# OpenHanako 增强方案：添加 Cumora 式多 Agent 协作

## 核心思路

不新建第二个客户端，而是在 OpenHanako 基础上添加：
1. **群聊协作机制**（类似 Cumora 的群聊 + 防碰撞）
2. **主动唤醒系统**（类似 Cumora 的 wake/turn）
3. **统一 CLI 协议**（让 Agent 可以用 cumora 命令操作）

---

## 一、需要新增的核心模块

### 1.1 新建 `core/coordination/` 目录

```
openhanako/
├── core/
│   ├── coordination/
│   │   ├── seen-cursor.ts      # 新鲜度检查
│   │   ├── triage-gate.ts      # 小脑门控
│   │   ├── wake-debounce.ts    # 唤醒去抖
│   │   └── concurrency.ts      # 并发控制
│   └── ...
```

### 1.2 关键实现

#### seen-cursor.ts（防重复回复）
```typescript
// 类似 Cumora 的 freshness preflight
class SeenCursor {
  private cursors = new Map<string, number>() // agentId:convoId -> seq
  
  async checkFreshness(agentId: string, convoId: string, minSeq: number): Promise<boolean> {
    const baseline = this.cursors.get(`${agentId}:${convoId}`) ?? 0
    return minSeq > baseline
  }
  
  async advance(agentId: string, convoId: string, seq: number): void {
    this.cursors.set(`${agentId}:${convoId}`, Math.max(
      this.cursors.get(`${agentId}:${convoId}`) ?? 0,
      seq
    ))
  }
}
```

#### triage-gate.ts（小脑门控）
```typescript
// 先用小模型判断是否需要唤醒大模型
class TriageGate {
  async shouldWake(agent: Agent, inbox: Message[]): Promise<boolean> {
    const triage = await this.smallBrainClassify({
      messages: inbox,
      instructions: TRIAGE_PROMPT,
    })
    return triage.actionable === true
  }
}
```

#### wake-debounce.ts（唤醒去抖）
```typescript
// 2.5 秒内的多个唤醒合并为一个 turn
class WakeDebounce {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  
  scheduleWake(agentId: string, callback: () => Promise<void>): void {
    if (this.timers.has(agentId)) return
    this.timers.set(agentId, setTimeout(async () => {
      this.timers.delete(agentId)
      await callback()
    }, 2500))
  }
}
```

---

## 二、修改现有模块

### 2.1 增强 `hub/scheduler.ts`

添加群聊监听和主动唤醒：

```typescript
// 在 Scheduler 中添加
class Scheduler {
  private coordination: CoordinationLayer
  
  async startGroupListening(channelId: string): Promise<void> {
    // 监听群聊新消息
    this.hub.onMessage(channelId, async (msg) => {
      // 检查是否需要唤醒相关 Agent
      const agents = await this.getRelevantAgents(msg)
      for (const agent of agents) {
        await this.coordination.scheduleWake(agent.id, () => 
          this.runAgentTurn(agent, msg)
        )
      }
    })
  }
}
```

### 2.2 增强 `core/agent.ts`

添加协作能力：

```typescript
class Agent {
  // 新增：群聊感知
  async listenToGroup(convoId: string): Promise<void> {
    this.hub.subscribe(convoId, this.onGroupMessage.bind(this))
  }
  
  // 新增：主动行为
  async checkAgenda(): Promise<void> {
    const tasks = await this.getAssignedTasks()
    for (const task of tasks) {
      await this.executeTask(task)
    }
  }
  
  // 新增：Agent-to-Agent 通信
  async whisper(toAgentId: string, text: string): Promise<void> {
    await this.hub.sendDM(toAgentId, text)
  }
}
```

---

## 三、添加 cumora CLI 兼容层

让 OpenHanako 的 Agent 可以使用 cumora 命令：

```typescript
// lib/cumora-cli-bridge.ts
class CumoraCLIBridge {
  async reply(convoId: string, text: string): Promise<void> {
    // 通过 OpenHanako 的频道系统发送
    await this.hub.sendMessage(convoId, text)
  }
  
  async inbox(): Promise<Message[]> {
    // 读取 OpenHanako 的会话历史
    return await this.hub.getRecentMessages()
  }
  
  async glance(convoId: string): Promise<string> {
    // 获取会话预览
    return await this.hub.getConversationPreview(convoId)
  }
}
```

---

## 四、实施步骤

### Week 1-2: 基础协调层
- [ ] 实现 SeenCursor
- [ ] 实现 TriageGate
- [ ] 实现 WakeDebounce
- [ ] 单元测试

### Week 3-4: 群聊集成
- [ ] 修改 Scheduler 添加群聊监听
- [ ] 修改 Agent 添加协作方法
- [ ] 联调测试

### Week 5-6: CLI 兼容
- [ ] 实现 cumora CLI bridge
- [ ] 测试 cumora reply/inbox 等命令

### Week 7-8: 高级功能
- [ ] Agent-to-Agent 通信
- [ ] 看板/日历集成（可选）

---

## 五、预期效果

整合后，OpenHanako 将具备：

| 功能 | 状态 |
|------|------|
| 多 Agent 群聊协作 | ✅ 新增 |
| 防重复回复 | ✅ 新增 |
| 主动唤醒 | ✅ 新增 |
| cumora CLI 兼容 | ✅ 新增 |
| 原有个人助手功能 | ✅ 保留 |

---

## 六、关键代码位置

| 文件 | 修改内容 |
|------|---------|
| `hub/scheduler.ts` | 添加群聊监听 + 唤醒调度 |
| `core/agent.ts` | 添加协作方法 |
| `core/coordination/` | 新建协调模块 |
| `lib/cumora-cli-bridge.ts` | 新建 CLI 兼容层 |

---

*方案生成时间：2026-08-21*
