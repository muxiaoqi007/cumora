# OpenHanako 多 Agent 群聊增强方案

> OpenHanako 已有基础的多 Agent 群聊功能，本文档聚焦于**增强协调机制**，解决碰撞问题。

---

## 一、现状分析

### 1.1 OpenHanako 已有的能力

从用户截图看，OpenHanako 已具备：

| 功能 | 状态 | 说明 |
|------|------|------|
| 多 Agent 群聊 | ✅ | 频道系统，支持 4+ 成员 |
| Agent 状态 | ✅ | 空闲/工作中状态显示 |
| 主动发起 | ✅ | 可配置间隔（31秒） |
| 轮次控制 | ✅ | 轮次上限 36 |
| 模型配置 | ✅ | 可覆写模型 |
| 工具权限 | ✅ | 只读/写入控制 |

### 1.2 与 Cumora 的差距

| 能力 | OpenHanako | Cumora | 影响 |
|------|-----------|--------|------|
| **防重复回复** | ❌ | ✅ seen-cursor | 多个 Agent 可能回复同一消息 |
| **消息新鲜度** | ❌ | ✅ 原子 claim | Agent 可能基于过时上下文回复 |
| **成本门控** | ❌ | ✅ 小脑 triage | 无意义消息也触发大模型 |
| **唤醒合并** | ❌ | ✅ 2.5s 去抖 | 连续消息触发多次 LLM 调用 |
| **并发控制** | ❌ | ✅ 信号量 | 多 Agent 同时唤醒可能导致限流 |

---

## 二、增强方案：最小化改动

### 2.1 核心思路

**不改 UI，不改数据模型，只加协调层。**

在现有的 `hub/scheduler.ts` 和 `core/agent.ts` 基础上，添加一个轻量级的协调中间件。

### 2.2 架构图

```
┌─────────────────────────────────────────────────────────┐
│                    OpenHanako UI                        │
│              （保持不变，已有频道/Agent 配置）               │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                Hub (现有调度器)                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  新增：Coordination Middleware（协调中间件）        │   │
│  │                                                  │   │
│  │  ┌──────────────┐  ┌──────────────┐             │   │
│  │  │ SeenCursor   │  │  TriageGate  │             │   │
│  │  │ (新鲜度检查)  │  │  (成本门控)   │             │   │
│  │  └──────────────┘  └──────────────┘             │   │
│  │  ┌──────────────┐  ┌──────────────┐             │   │
│  │  │ WakeDebounce │  │ Concurrency  │             │   │
│  │  │  (唤醒去抖)   │  │  (并发控制)   │             │   │
│  │  └──────────────┘  └──────────────┘             │   │
│  └──────────────────────────────────────────────────┘   │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                 Agent 系统 (现有)                         │
│   • 记忆系统                                             │
│   • 人格系统                                             │
│   • 工具系统                                             │
│   • 多平台 Bridge                                        │
└─────────────────────────────────────────────────────────┘
```

---

## 三、具体实现

### 3.1 新增文件结构

```
openhanako/
├── lib/
│   └── coordination/
│       ├── index.ts          # 统一导出
│       ├── seen-cursor.ts    # seen-cursor 新鲜度检查
│       ├── triage-gate.ts    # 小脑门控
│       ├── wake-debounce.ts  # 唤醒去抖
│       └── concurrency.ts    # 并发控制
├── hub/
│   └── scheduler.ts          # 修改：接入协调中间件
└── core/
    └── agent.ts              # 修改：添加协作方法
```

### 3.2 seen-cursor.ts（防重复回复）

```typescript
// lib/coordination/seen-cursor.ts
/**
 * 防止多个 Agent 对同一消息重复回复
 * 
 * 原理：每个 Agent 维护一个"已看到"的消息序列号基线
 * 回复前检查是否有更新的消息，如果有则暂不发送
 */

export class SeenCursor {
  // key: `${agentId}:${channelId}` → seq
  private cursors = new Map<string, number>()
  
  /** 检查消息是否新鲜（是否有更新的未读消息） */
  checkFreshness(agentId: string, channelId: string, minSeq: number): boolean {
    const baseline = this.cursors.get(`${agentId}:${channelId}`) ?? 0
    return minSeq > baseline
  }
  
  /** 推进基线（成功回复后调用） */
  advance(agentId: string, channelId: string, seq: number): void {
    const key = `${agentId}:${channelId}`
    const current = this.cursors.get(key) ?? 0
    this.cursors.set(key, Math.max(current, seq))
  }
  
  /** 重置（频道切换时） */
  reset(agentId: string, channelId: string): void {
    this.cursors.delete(`${agentId}:${channelId}`)
  }
}
```

### 3.3 triage-gate.ts（小脑门控）

```typescript
// lib/coordination/triage-gate.ts
/**
 * 小脑门控：先用小模型判断是否需要唤醒大模型
 * 
 * 原理：对每条消息，先用轻量模型分类：
 * - actionable: 需要大模型响应
 * - ignore: 无意义消息，跳过
 */

interface TriageResult {
  actionable: boolean
  reason?: string
}

export class TriageGate {
  private smallModel: string = 'haiku' // 或 gpt-4o-mini
  
  async shouldWake(
    agentId: string,
    messages: Message[],
    context: string
  ): Promise<TriageResult> {
    // 调用小模型分类
    const result = await this.classify({ messages, context })
    return result
  }
  
  private async classify(input: {
    messages: Message[]
    context: string
  }): Promise<TriageResult> {
    // 这里可以复用 OpenHanako 现有的小模型配置
    const prompt = `判断以下消息是否需要回复：
    
${input.messages.map(m => `[${m.author}]: ${m.text}`).join('\n')}

上下文：${input.context}

如果消息是无意义的（如 "---"、"lol"、表情），返回 {"actionable": false}。
如果是需要回复的，返回 {"actionable": true, "reason": "简短原因"}。`
    
    const response = await callSmallModel(prompt, this.smallModel)
    return parseTriageResponse(response)
  }
}
```

### 3.4 wake-debounce.ts（唤醒去抖）

```typescript
// lib/coordination/wake-debounce.ts
/**
 * 唤醒去抖：2.5 秒内的多个唤醒合并为一个 turn
 * 
 * 原理：第一个 wake 启动计时器，后续 wake 折叠进去
 * 最终只执行一次 turn，但包含所有未读消息
 */

export class WakeDebounce {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private pending = new Map<string, Message[]>()
  
  /** 调度唤醒 */
  scheduleWake(
    agentId: string,
    messages: Message[],
    callback: () => Promise<void>
  ): void {
    const key = agentId
    
    if (this.timers.has(key)) {
      // 已有定时器，追加消息
      const existing = this.pending.get(key) ?? []
      this.pending.set(key, [...existing, ...messages])
      return
    }
    
    // 启动新定时器
    this.pending.set(key, messages)
    this.timers.set(key, setTimeout(async () => {
      this.timers.delete(key)
      const msgs = this.pending.get(key) ?? []
      this.pending.delete(key)
      await callback(msgs)
    }, 2500))
  }
}
```

### 3.5 修改 hub/scheduler.ts

```typescript
// hub/scheduler.ts 修改点

import { CoordinationMiddleware } from '../lib/coordination/index.ts'

export class Scheduler {
  private coordination: CoordinationMiddleware
  
  constructor(opts) {
    // 现有代码...
    this.coordination = new CoordinationMiddleware({
      seenCursor: new SeenCursor(),
      triageGate: new TriageGate(),
      wakeDebounce: new WakeDebounce(),
    })
  }
  
  /** 修改：添加协调中间件 */
  async onChannelMessage(channelId: string, msg: Message): Promise<void> {
    // 1. 获取相关 Agent
    const agents = await this.getRelevantAgents(channelId, msg)
    
    for (const agent of agents) {
      // 2. 小脑门控
      const shouldWake = await this.coordination.triageGate.shouldWake(
        agent.id, [msg], this.getContext(agent, channelId)
      )
      if (!shouldWake.actionable) continue
      
      // 3. 唤醒去抖
      this.coordination.wakeDebounce.scheduleWake(
        agent.id,
        [msg],
        async (messages) => {
          // 4. 新鲜度检查
          const isFresh = this.coordination.seenCursor.checkFreshness(
            agent.id, channelId, msg.seq
          )
          if (!isFresh) {
            console.log(`[coordination] ${agent.id} message stale, skipping`)
            return
          }
          
          // 5. 执行 turn
          await this.runAgentTurn(agent, messages)
          
          // 6. 推进 seen-cursor
          this.coordination.seenCursor.advance(agent.id, channelId, msg.seq)
        }
      )
    }
  }
}
```

---

## 四、实施步骤

### Week 1: 协调层基础
- [ ] 实现 `SeenCursor`
- [ ] 实现 `WakeDebounce`
- [ ] 单元测试

### Week 2: 集成到 Scheduler
- [ ] 修改 `hub/scheduler.ts`
- [ ] 联调测试
- [ ] 修复碰撞问题验证

### Week 3: 小脑门控
- [ ] 实现 `TriageGate`
- [ ] 复用 OpenHanako 现有小模型配置
- [ ] 成本优化验证

### Week 4: 完善与优化
- [ ] 添加并发控制
- [ ] 性能优化
- [ ] 文档更新

---

## 五、预期效果

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| 重复回复率 | 高（无防护） | 低（seen-cursor 拦截） |
| 无效 LLM 调用 | 高（所有消息都触发） | 低（triage 过滤） |
| 连续消息处理 | N 次调用 | 1 次调用（去抖合并） |
| 限流风险 | 高 | 低（并发控制） |

---

## 六、关键设计决策

### Q: 为什么不改 OpenHanako 的 UI？
A: UI 已经满足需求，只需在后台加协调层，用户无感升级。

### Q: 为什么用轻量级中间件而不是替换整个调度器？
A: 最小化改动风险，保留 OpenHanako 已有的功能（记忆、人格、工具等）。

### Q: triage 用小模型会不会增加延迟？
A: 小模型响应很快（~100ms），相比大模型（~2s）可以忽略。而且过滤掉了无意义消息，总体节省时间。

---

*方案更新时间：2026-08-21*
