# OpenHanako 核心能力增强：让 Agent 成为真正的第一公民

## 一、现状对比

### OpenHanako（现在）
```
用户 ──┬── Agent A（被动响应）
       ├── Agent B（被动响应）
       └── 频道 #11（静态聊天室）
```

**问题：**
- Agent 只能被@或定时唤醒
- 没有"主动跟进任务"的概念
- 没有跨频道协作
- 没有任务状态跟踪

### Cumora（目标）
```
用户 ──┬── Agent A（主动：跟踪任务、私聊跟进、跨频道协作）
       ├── Agent B（主动：看到消息后自主决定行动）
       └── 群聊 #11（实时协作空间）
```

---

## 二、核心能力差距

| 能力 | OpenHanako | Cumora | 价值 |
|------|-----------|--------|------|
| **主动行为** | ❌ 被动等待 | ✅ wake/turn 循环 | Agent 可以自主推进任务 |
| **任务跟踪** | ❌ 无 | ✅ Agenda（看板+日历） | Agent 知道"该做什么" |
| **记忆共享** | ❌ 各自独立 | ✅ workspace/文档 | Agent 可以协作产出 |
| **私聊跟进** | ❌ 无 | ✅ Whisper（Agent-to-Agent） | Agent 可以私下协调 |
| **状态可见** | ⚠️ 简单状态 | ✅ 工作/思考/等待 | 人类知道 Agent 在干嘛 |

---

## 三、最关键的三个增强

### 1. 主动行为（Wake → Turn）
```
现在：用户 @Agent → Agent 响应
增强：新消息到来 → Agent 自主判断是否响应 → 执行任务
```

**实现：**
- 监听频道新消息
- Agent 自主决定是否需要回复
- 支持"主动发起"（已有功能，但不够智能）

### 2. 任务跟踪（Agenda）
```
现在：Agent 不知道自己有什么任务
增强：Agent 可以看到 assigned cards + upcoming events
```

**实现：**
- 接入 Kanban 看板（已有或新建）
- 接入 Calendar（已有或新建）
- Agent 定期"检查议程"

### 3. 跨频道协作（Whisper）
```
现在：Agent 只能在一个频道发言
增强：Agent 可以私聊其他 Agent 协调
```

**实现：**
- Agent-to-Agent 私信功能
- 让 Agent 可以在群聊讨论前"先对齐"

---

## 四、实施优先级

### P0（核心价值）
1. **Agent 主动行为** — 让 Agent 能自主响应，而不是只被动@
2. **任务状态可见** — 让用户知道 Agent 在忙什么

### P1（体验增强）
3. **跨频道协作** — Agent 之间可以私聊协调
4. **记忆共享** — Agent 可以读取其他 Agent 的输出

### P2（高级功能）
5. **看板集成** — Agent 可以操作 Kanban
6. **日历调度** — Agent 可以创建/管理日历事件

---

## 五、最小可行方案

**不改 UI，只增强 Agent 的行为模式：**

```typescript
// 在现有 Agent 类中添加
class Agent {
  // 新增：主动检查是否有新任务
  async checkAgenda(): Promise<void> {
    const tasks = await this.getAssignedTasks()
    for (const task of tasks) {
      if (task.isOverdue) {
        await this.followUp(task)  // 主动跟进
      }
    }
  }
  
  // 新增：感知频道动态
  async listenToChannel(channelId: string): Promise<void> {
    this.hub.onMessage(channelId, async (msg) => {
      // Agent 自主判断是否响应
      if (this.shouldRespond(msg)) {
        await this.respond(msg)
      }
    })
  }
  
  // 新增：与其他 Agent 私聊
  async whisper(toAgentId: string, text: string): Promise<void> {
    await this.hub.sendDM(toAgentId, text)
  }
}
```

---

## 六、总结

**核心不是"防碰撞"，而是"让 Agent 真正参与协作"。**

OpenHanako 已经具备了基础（频道、Agent、状态），只需要：
1. 让 Agent 更主动（wake/turn 循环）
2. 让 Agent 有任务感（agenda）
3. 让 Agent 能私下协调（whisper）

这样用户就能体验到 Cumora 的核心价值：**Agent 不是工具，而是团队成员。**
