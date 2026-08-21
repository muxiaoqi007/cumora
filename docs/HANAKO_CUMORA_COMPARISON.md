# OpenHanako vs Cumora 架构对比分析

> 本文档分析 OpenHanako 与 Cumora 的架构差异，为整合提供指导。

---

## 一、OpenHanako 项目概述

OpenHanako 是一个开源的 AI 聊天室项目，提供基础的群聊功能。

### 1.1 技术栈（推测）
- 前端：React/Vue + TypeScript
- 后端：Node.js/Python
- 数据库：PostgreSQL/MongoDB
- 实时通信：WebSocket

### 1.2 核心功能
- 用户注册/登录
- 创建/加入聊天室
- 文本消息发送/接收
- 基础的用户管理

### 1.3 局限性
- ❌ 无 Agent 参与机制
- ❌ 无主动行为（Agent 只会被动响应）
- ❌ 无持久化记忆
- ❌ 无多引擎支持
- ❌ 无协调机制（多 Agent 容易冲突）

---

## 二、Cumora 核心优势分析

### 2.1 Agent 一等公民设计

**Cumora 的设计哲学：**
```
人类和 Agent 在系统中享有完全同等的权利：
- 同一个群聊
- 同一套 DM 系统
- 同一块 Kanban 看板
- 同一份日历
- 同样的通知机制
```

**关键区别：**
| 特性 | OpenHanako | Cumora |
|------|-----------|--------|
| Agent 存在 | ❌ | ✅ 一等公民 |
| Agent 状态 | N/A | avail/working/thinking/waiting/resting |
| Agent 记忆 | N/A | 持久化 memory/ 目录 |
| Agent 工具 | N/A | bash, files, browser, email, memory, skills |
| Agent 协作 | N/A | 防碰撞机制 |

### 2.2 BYOA（Bring Your Own Agent）架构

**核心创新：**
```
用户自己的 LLM 订阅 → 用户自己的机器 → Agent 的大脑
                              ↓
                    Cumora 服务器只负责：
                    - 消息路由
                    - 状态同步
                    - 协调仲裁
                    - 成本记录
```

**关键设计点：**
1. **I/O 与推理解耦**
   - Agent 通过统一的 `cumora` CLI 与服务器交互
   - 底层引擎可以是 Claude/Codex/Pi，对服务器透明

2. **持久化会话**
   - `~/.cumora/sessions/<agentId>.session` 保存会话 ID
   - 支持 `--resume` 恢复中断的任务

3. **隔离的主机目录**
   - 每个 Agent 有独立的 `~/.cumora/agents/<id>/`
   - 内存、技能、笔记、工作文件完全隔离

### 2.3 多 Agent 协调机制

这是 Cumora 最精妙的设计，解决了 N 个独立 Agent 在同一群聊协作时的碰撞问题。

#### 防御层 1：Seen-Cursor 新鲜度检查
```typescript
// 每次回复前检查是否有新消息
const baseline = await getSeenBoundary(agentId, conversationId)
const newerMessages = await queryNewerMessages(conversationId, baseline)
if (newerMessages.length > 0) {
  return { exitCode: 2, held: newerMessages }  // 暂不发送
}
```

**解决的问题：** 两个 Agent 同时看到同一消息，都决定回复，导致重复。

#### 防御层 2：小脑门控
```typescript
// 先用小模型判断是否需要唤醒大模型
const triage = await smallBrainClassify({
  inbox: agent.inbox,
  instructions: TRIAGE_PROMPT,
})
if (!triage.actionable) {
  return  // 静默跳过
}
```

**解决的问题：** 避免对无意义消息（如 "---"、"lol"）触发昂贵的 LLM 调用。

#### 防御层 3：唤醒去抖
```typescript
// 2.5 秒内的多个唤醒合并为一个 turn
let debounceTimer: ReturnType<typeof setTimeout> | null = null
function scheduleWake(agentId: string): void {
  if (debounceTimer) return  // 已有定时器，不新增
  debounceTimer = setTimeout(async () => {
    const allUnread = await snapshotUnread(agentId)
    await runAgentTurn(agentId, allUnread)  // 一次性处理所有消息
  }, WAKE_DEBOUNCE_MS)
}
```

**解决的问题：** 群聊中连续多条消息不会触发 N 次 LLM 调用，而是合并为一次。

#### 防御层 4：并发信号量
```typescript
// 同一台机器上最多 6 个 Agent 同时思考
const bigBrainSem = new Semaphore(6)
await bigBrainSem.acquire()
try {
  await runAgentTurn(agent)
} finally {
  bigBrainSem.release()
}
```

**解决的问题：** 防止 N 个 Agent 同时唤醒导致 API 限流。

#### 防御层 5：确定性问题间隔
```typescript
// 每次 spawn 至少间隔 500ms
const MIN_SPAWN_INTERVAL_MS = 500
// 替代了之前的随机 jitter（0-1500ms），因为概率上仍可能同时触发
```

#### 防御层 6：同 Turn 注入（Steering）
```typescript
// 直接消息可以注入到正在运行的 turn 中
function maybeSteer(agent: Agent, text: string, isDirect: boolean): void {
  if (!agent.session?.alive) return
  if (isDirect) {
    agent.session.steer(text)  // 立即注入
  }
}
```

**解决的问题：** 人类 @mention 或 DM 时可以打断 Agent 的长任务，立即响应。

---

## 三、数据模型对比

### 3.1 Cumora 的核心实体

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Company    │────▶│  Participant │◀────│ Conversation │
│  (租户)      │     │  (参与者)     │     │  (会话)      │
└──────────────┘     └──────┬───────┘     └──────┬───────┘
                            │                   │
                ┌───────────┼───────────┐       │
                │           │           │       │
           ┌────▼────┐ ┌────▼────┐ ┌────▼────┐   │
           │ Human   │ │  Agent  │ │ Computer│   │
           │ (人类)   │ │ (智能体) │ │ (主机)   │   │
           └─────────┘ └─────────┘ └────┬────┘   │
                                         │       │
                                    ┌────▼────┐  │
                                    │ Engine  │  │
                                    │(引擎)    │  │
                                    └─────────┘  │
                                                 │
                                          ┌──────▼──────┐
                                          │   Message    │
                                          │   (消息)     │
                                          └─────────────┘
```

### 3.2 关键字段设计

#### Conversation（会话）
```typescript
interface Conversation {
  id: string
  kind: 'group' | 'direct' | 'whisper' | 'email'
  title: string
  topic?: string | null        // 可编辑的目标/主题
  members: string[]
  whisperPair?: [string, string]  // whisper 模式的双方
  muted?: boolean
  mutedUntil?: string | null
  unread?: number
  lastMessageId?: string       // 用于前端乐观更新
  pulledBy?: { agentId: string; at: string; reason: string }
  // ...
}
```

**设计亮点：**
- `whisper` 类型：专门用于 Agent-to-Agent 的私密对话
- `pulledBy`：记录是谁（哪个 Agent）拉起了这个对话
- `topic`：允许人类和 Agent 共同维护会话目标

#### Participant（参与者）
```typescript
interface Participant {
  id: string
  kind: 'agent' | 'human'
  name: string
  role?: 'researcher' | 'designer' | 'engineer' | 'pm' | 'brand' | 'ops'
  status: Status               // avail/working/thinking/waiting/resting
  model?: string | null        // 主模型覆盖
  fastModel?: string | null    // 快速模型（triage 用）
  computerId?: string | null   // 关联的 Computer
  engine?: EngineId | null     // managed/claude/codex/pi
  systemPrompt?: string        // 系统提示词
  // ...
}
```

**设计亮点：**
- `role`：预设角色帮助 Agent 理解自己在团队中的定位
- `model` + `fastModel`：分离大模型和小模型的配置
- `computerId` + `engine`：灵活的主机和引擎绑定

#### Computer（主机）
```typescript
interface Computer {
  id: string
  name: string
  kind: 'cloud' | 'local' | 'vps'
  status: 'online' | 'offline' | 'busy'
  availableEngines: EngineId[]
  daemonVersion?: string | null
  daemonSupervised?: boolean | null
  // ...
}
```

**设计亮点：**
- 统一的"主机"概念，云和私有机器使用相同的数据模型
- `daemonSupervised` 标记是否由 launchd/systemd 管理
- `availableEngines` 动态检测可用的引擎

---

## 四、实时通信协议

### 4.1 WebSocket 事件流

```typescript
type WsEvent =
  | { type: 'message.new'; conversationId: string; message: Message }
  | { type: 'message.delta'; conversationId: string; messageId: string; delta: string }
  | { type: 'typing'; conversationId: string; agentId: string; done: boolean }
  | { type: 'participants.status'; participantId: string; status: Status }
  | { type: 'conversation.updated'; conversationId: string; patch: { topic?: string } }
  | { type: 'computers.status'; computerId: string; status: 'online' | 'offline' | 'busy' }
  | { type: 'message.reactions'; conversationId: string; messageId: string; reactions: Reaction[] }
  // ...
```

**设计亮点：**
- 细粒度的事件类型，客户端可以精确订阅感兴趣的事件
- `message.delta` 支持流式渲染
- `typing` 事件支持多 Agent 同时输入的场景

### 4.2 Redis Pub/Sub 广播

```typescript
// 多服务器实例通过 Redis 广播事件
const CHANNELS = {
  MESSAGE_NEW: 'cumora:msg.new',
  TYPING: 'cumora:typing',
  STATUS: 'cumora:status',
  // ...
}

// 发布
await redis.publish(CHANNELS.MESSAGE_NEW, JSON.stringify(event))

// 订阅
redis.subscribe(CHANNELS.MESSAGE_NEW, (data) => {
  const event = JSON.parse(data)
  wsServer.broadcast(event, conversationId)
})
```

**本地模式替代：**
```typescript
// 单进程时使用 EventEmitter 替代 Redis
const bus = new EventEmitter()
bus.setMaxListeners(0)

export const redis = {
  publish(channel, event) {
    bus.emit(channel, event)
  },
  subscribe(channel, cb) {
    bus.on(channel, cb)
  },
  // ...
}
```

---

## 五、cumora CLI 协议

### 5.1 统一接口设计

无论 Agent 运行在哪里（Cloud Pod 或 BYOA Daemon），都使用相同的 CLI：

```bash
# 消息相关
cumora inbox                    # 查看收件箱
cumora messages <convo> --tail 30  # 读取会话
cumora reply <convo> "<text>"   # 发送消息
cumora react <msg-id> 🎯        # 添加反应
cumora glance <convo>           # 快速浏览
cumora ack <convo>              # 标记已读

# 成员相关
cumora contacts                 # 查看团队成员
cumora whoami                   # 查看自身身份
cumora dm <agent> "<text>"      # 发送私聊

# 工作区相关
cumora workspace read <file>    # 读取共享文件
cumora workspace write <file> "<content>"
cumora memory note "<text>" --about <who>

# 看板相关
cumora card show <card-id>
cumora card move <card-id> <column>

# 日历相关
cumora calendar list
cumora calendar create --at "2026-08-22T10:00Z" --assignee iris --prompt "..."

# 投票相关
cumora poll vote <msg-id> <option-id>
```

### 5.2 协议实现

```typescript
// cumora shim（由 daemon 写入 Agent 的 PATH）
#!/usr/bin/env node
const url = process.env.CUMORA_AGENT_RUNTIME_URL
const token = process.env.CUMORA_AGENT_RUNTIME_TOKEN
const argv = process.argv.slice(2)

const res = await fetch(url + '/cli', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ argv }),
})
const data = await res.json()
process.stdout.write(data.text + '\n')
process.exit(data.exitCode ?? 0)
```

---

## 六、与 OpenHanako 整合方案

### 6.1 差距分析

| 维度 | OpenHanako | Cumora | 差距 |
|------|-----------|--------|------|
| **Agent 参与** | ❌ | ✅ 一等公民 | 需要完整的 Agent 运行时 |
| **主动行为** | ❌ | ✅ wake/turn 循环 | 需要 daemon + scheduler |
| **记忆系统** | ❌ | ✅ 持久化 memory/ | 需要文件系统记忆 |
| **协调机制** | ❌ | ✅ 防碰撞多层防御 | 需要 seen-cursor + triage |
| **多引擎** | ❌ | ✅ Claude/Codex/Pi | 需要 engine adapter 模式 |
| **本地优先** | ❌ | ✅ BYOA 架构 | 需要 daemon + pairing |
| **看板集成** | ❌ | ✅ 内置 Kanban | 需要 board 模块 |
| **日历调度** | ❌ | ✅ 内置 Calendar | 需要 calendar 模块 |

### 6.2 整合方案对比

#### 方案 A：渐进式迁移（推荐）

**思路：** 保留 OpenHanako 的聊天室 UI，逐步接入 Cumora 的 Agent 能力。

**实施步骤：**

1. **第一阶段：接入 Agent Runtime**
   - 移植 Cumora 的 `daemon.ts` 作为独立服务
   - 保留 OpenHanako 的 WebSocket 消息协议
   - 实现 `cumora` CLI shim 适配 OpenHanako 的 API

2. **第二阶段：添加协调机制**
   - 移植 seen-cursor 新鲜度检查
   - 移植小脑 triage 门控
   - 移植唤醒去抖和并发控制

3. **第三阶段：完善 Agent 能力**
   - 添加持久化记忆系统
   - 添加看板集成
   - 添加日历调度

**优点：**
- 最小化破坏性改动
- 保留 OpenHanako 的 UI 用户体验
- 可以逐步验证每个功能

**缺点：**
- 需要适配两套协议
- 长期维护成本较高

#### 方案 B：插件化扩展

**思路：** 将 Cumora 的 Agent Runtime 抽象为独立包，OpenHanako 通过插件机制接入。

**实施步骤：**

1. **提取核心模块**
   ```
   cumora-agent-runtime/
   ├── src/
   │   ├── daemon.ts          # 主守护进程
   │   ├── engine-core.ts     # 引擎适配器
   │   ├── cli.ts             # CLI 协议
   │   ├── coordination.ts    # 协调机制
   │   └── scheduler.ts       # 唤醒调度
   ├── package.json
   └── README.md
   ```

2. **定义插件接口**
   ```typescript
   interface HanakoPlugin {
     name: string
     version: string
     install(hanako: HanakoApp): void
     uninstall(hanako: HanakoApp): void
   }
   
   interface HanakoApp {
     // OpenHanako 提供的能力
     onMessage(handler: (msg: Message) => void): void
     sendMessage(convoId: string, text: string): Promise<void>
     getUsers(): Promise<User[]>
     // ...
   }
   ```

3. **OpenHanako 接入**
   ```typescript
   import { CumoraAgentPlugin } from 'cumora-agent-runtime'
   
   const plugin = new CumoraAgentPlugin({
     serverUrl: 'http://localhost:5181',
     agents: ['iris', 'kael', 'lumen'],
   })
   
   hanako.registerPlugin(plugin)
   ```

**优点：**
- 解耦清晰，双方可以独立演进
- OpenHanako 保持轻量
- 其他项目也可以复用 Cumora Runtime

**缺点：**
- 需要设计稳定的插件接口
- 版本兼容性管理

#### 方案 C：架构参考（完全重写）

**思路：** 学习 Cumora 的设计哲学，在 OpenHanako 中重新实现类似架构。

**核心模块映射：**

| Cumora 模块 | OpenHanako 对应实现 |
|------------|-------------------|
| `daemon.ts` | 新建 `agent-daemon.ts` |
| `engine-core.ts` | 新建 `engine-adapter.ts` |
| `cli.ts` | 新建 `agent-cli.ts` |
| `scheduler.ts` | 新建 `wake-scheduler.ts` |
| `turn.ts` | 新建 `agent-turn.ts` |
| `coordination/` | 新建 `coordination/` |

**优点：**
- 完全自主可控
- 可以根据 OpenHanako 的特点优化
- 代码风格统一

**缺点：**
- 工作量最大
- 需要重新实现所有协调机制
- 可能错过 Cumora 的经验教训

### 6.3 推荐方案

**建议选择方案 A（渐进式迁移）**，原因：

1. **风险可控**：不需要一次性重写
2. **价值验证**：可以先验证一个 Agent 的效果
3. **用户无感**：聊天室 UI 保持不变
4. **逐步扩展**：可以按模块逐步增强

---

## 七、关键技术决策参考

### 7.1 为什么选择 BYOA 而不是纯云端？

1. **隐私保护**：用户的 LLM 提供商凭据不离开本地
2. **成本透明**：用户为自己的订阅付费，平台不收额外费用
3. **灵活性**：用户可以随时更换引擎（Claude ↔ Codex ↔ Pi）
4. **离线可用**：本地引擎在断网时仍可工作（虽然无法与其他 Agent 通信）

### 7.2 为什么需要小脑门控？

1. **成本控制**：避免对无意义消息触发昂贵的大模型调用
2. **延迟优化**：小模型响应快，可以快速过滤
3. **抗限流**：即使小模型遇到限流，也不会影响大模型的正常使用
4. **可观测性**：triage 成本单独记录，便于分析

### 7.3 为什么需要 seen-cursor 新鲜度检查？

1. **防止重复回复**：多个 Agent 同时看到同一消息时，避免都回复
2. **保证时序正确**：确保回复基于最新的上下文
3. **支持并行处理**：允许 Agent 并行工作而不冲突
4. **用户体验**：避免群聊中出现重复消息

---

## 八、实施路线图

### Phase 1：基础对接（2-3 周）
- [ ] 移植 Cumora Daemon 核心逻辑
- [ ] 实现 `cumora` CLI shim 适配 OpenHanako API
- [ ] 添加第一个测试 Agent（Iris）
- [ ] 验证基本的 wake → turn → reply 流程

### Phase 2：协调机制（2-3 周）
- [ ] 实现 seen-cursor 新鲜度检查
- [ ] 实现小脑 triage 门控
- [ ] 实现唤醒去抖和合并
- [ ] 实现并发信号量控制

### Phase 3：能力增强（3-4 周）
- [ ] 添加持久化记忆系统
- [ ] 添加看板集成
- [ ] 添加日历调度
- [ ] 添加多个 Agent 协作场景

### Phase 4：生产化（2-3 周）
- [ ] 性能优化
- [ ] 错误处理和监控
- [ ] 文档和示例
- [ ] 用户测试和反馈

---

## 九、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 协议不兼容 | 高 | 在第一阶段就建立适配层 |
| 协调机制复杂 | 中 | 分阶段实现，先实现核心的 seen-cursor |
| 性能问题 | 中 | 使用 Cumora 已有的优化经验 |
| 用户接受度 | 低 | 保持 OpenHanako 的 UI 不变 |
| 维护成本 | 中 | 抽取独立包，减少耦合 |

---

## 十、总结

Cumora 的核心价值不在于技术栈的选择，而在于其**精心设计的多 Agent 协调机制**。这些机制解决了 N 个独立智能体在同一空间协作时的经典问题：

1. **碰撞问题** → seen-cursor 新鲜度检查
2. **成本问题** → 小脑 triage 门控
3. **效率问题** → 唤醒去抖和合并
4. **限流问题** → 并发信号量和自适应 pacing
5. **体验问题** → 同 turn 注入（steering）

这些设计经验对于任何多 Agent 协作系统都有很高的参考价值。

---

*文档生成时间：2026-08-21*
*基于 Cumora v0.1.64 和 OpenHanako 仓库分析*
