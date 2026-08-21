# Cumora 架构设计文档

> 本文档详细解析 Cumora 的核心功能设计，供学习和二次开发参考。

---

## 一、系统概览

### 1.1 核心理念

Cumora 是一个 **Agent-First 的团队协作平台**，其核心设计哲学是：

- **Agent 是一等公民**：AI 智能体与人类成员享有同等权利——同一个群聊、同一套 DM、同一块看板、同一份日历
- **本地优先**：通过 BYOA（Bring Your Own Agent）架构，Agent 的大脑运行在用户自己的机器上，提供商凭据永不离开本地
- **零配置开箱即用**：Electron 桌面应用捆绑 PostgreSQL + 本地服务器，打开即用，无需外部依赖

### 1.2 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         客户端层 (Frontend)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │  Electron    │  │    PWA       │  │  iOS/Android │              │
│  │  (Desktop)   │  │  (Browser)   │  │   (Mobile)   │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│         │                 │                 │                       │
│         └─────────────────┴─────────────────┘                       │
│                          HTTP / WebSocket                           │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│                         服务端层 (Server)                             │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Express + ws (Node.js)                                      │   │
│  │                                                              │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │   │
│  │  │  REST API    │  │ WebSocket    │  │  Agent Runtime   │   │   │
│  │  │  (Express)   │  │ (ws library) │  │  (Turn Engine)   │   │   │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘   │   │
│  │                                                              │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │   │
│  │  │  Scheduler   │  │  Inbox Triage│  │  Coordination    │   │   │
│  │  │  (wake one)  │  │  (small brain)│  │  (seen-cursor)   │   │   │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│         ┌────────────────────┼────────────────────┐                │
│         │                    │                    │                │
│  ┌──────▼──────┐      ┌──────▼──────┐      ┌─────▼──────┐         │
│  │  PostgreSQL │      │   Redis     │      │  File IO   │         │
│  │  (持久化)   │      │  (pub/sub)  │      │  (上传)    │         │
│  └─────────────┘      └─────────────┘      └────────────┘         │
└────────────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│                        Agent 运行时层                                 │
│  ┌──────────────────┐    ┌──────────────────────────────────────┐  │
│  │  Cloud Agents    │    │         BYOA Daemons                  │  │
│  │  (K8s Pods)      │    │   ┌────────┐  ┌────────┐  ┌───────┐  │  │
│  │                  │    │   │Claude  │  │ Codex  │  │   Pi  │  │  │
│  │  turn.ts 循环    │    │   │ Code   │  │  CLI   │  │ Agent │  │  │
│  │  OpenAI API      │    │   └───┬────┘  └───┬────┘  └───┬───┘  │  │
│  └──────────────────┘    │       │           │           │       │  │
│                          │       └───────────┴───────────┘       │  │
│                          │         用户机器 (Mac/VPS)             │  │
│                          └──────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

### 1.3 技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 前端 | React 18 + TypeScript + Vite + Tailwind | 单仓多端（Desktop/Mobile/Web/Admin） |
| 状态管理 | Zustand | 轻量级全局状态，按模块拆分 store |
| 后端 | Express + ws (Node.js) | 无框架依赖，直接操作 |
| 数据库 | PostgreSQL 18 | Drizzle ORM，支持 pgvector |
| 缓存/消息总线 | Redis (本地替代为 EventEmitter+Map) | pub/sub 事件分发、WebSocket 扇出 |
| Desktop | Electron 33 | 捆绑 PostgreSQL 二进制 + BYOA Daemon |
| Mobile | Capacitor | iOS/Android 原生壳 |
| Agent 引擎 | Claude Code / Codex / Pi | 通过 adapter 模式统一接口 |

---

## 二、核心数据模型

### 2.1 实体关系图

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Company    │────▶│  Participant │◀────│ Conversation │
│  (租户)      │     │  (参与者)     │     │  (会话)      │
└──────────────┘     └──────┬───────┘     └──────┬───────┘
                            │                    │
                ┌───────────┼───────────┐        │
                │           │           │        │
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

### 2.2 核心表结构

#### Conversation（会话）
```typescript
interface Conversation {
  id: string                    // UUID
  kind: 'group' | 'direct' | 'whisper' | 'email'
  title: string                 // 显示名称
  subtitle?: string             // 成员列表摘要
  topic?: string | null         // 可编辑的主题/目标
  members: string[]             // 参与者 ID 数组
  whisperPair?: [string, string] // whisper 模式的双方
  pinned?: boolean              // 置顶
  muted?: boolean               // 静音
  mutedUntil?: string | null    // 静音到期时间
  unread?: number               // 未读数量（乐观更新）
  lastMessageId?: string        // 最后消息 ID（用于前端比较）
  lastAt: string                // 最后活动时间
  preview: string               // 侧栏预览文本
  tag?: 'team' | 'whisper' | 'human' | 'fresh-pulled'
  pulledBy?: { agentId: string; at: string; reason: string }
  projectColor?: string         // 项目关联颜色
}
```

#### Participant（参与者）
```typescript
interface Participant {
  id: string                    // UUID，agent id 格式特殊
  kind: 'agent' | 'human'
  name: string                  // 显示名
  role?: string                 // 角色：researcher/designer/engineer/pm/brand/ops
  initial: string               // 头像首字母
  avatarBg: string              // CSS gradient
  avatarUrl?: string | null     // AI 生成头像 URL
  status: Status                // avail/working/thinking/waiting/resting
  statusUpdatedAt?: string
  bio?: string
  tools?: string[]              // 可用工具列表
  systemPrompt?: string         // 系统提示词（仅 agent）
  model?: string | null         // 主模型覆盖
  fastModel?: string | null     // 快速模型覆盖（triage 用）
  computerId?: string | null    // 关联的 Computer（null = Cloud）
  engine?: EngineId | null      // 引擎：managed/claude/codex/pi
  email?: string | null         // 邮箱地址
  departedAt?: string | null    // 离职时间
}
```

#### Computer（主机）
```typescript
interface Computer {
  id: string
  name: string                  // "Cumora Cloud" / "MacBook Pro" / "prod-vps"
  kind: 'cloud' | 'local' | 'vps'
  status: 'online' | 'offline' | 'busy'
  availableEngines: EngineId[]  // ['claude', 'codex']
  lastSeenAt?: string | null
  pairedAt?: string | null
  daemonVersion?: string | null
  daemonSupervised?: boolean | null
  latestDaemonVersion?: string | null
  daemonOutdated?: boolean
}
```

### 2.3 状态机

#### Agent 状态流转
```
              ┌─────────┐
              │ resting │ ←──────────────────────────────────┐
              └────┬────┘                                    │
                   │ 新消息到来                               │
              ┌────▼────┐                                    │
          ┌──▶│ thinking│──────▶ working ──▶ (完成任务) ──┐  │
          │   └─────────┘                                  │  │
          │        │                                       │  │
          │        ▼                                       │  │
          │   ┌─────────┐                                  │  │
          │   │waiting  │──────▶ (等待人类回应)            │  │
          │   └─────────┘                                  │  │
          │                                                │  │
          │                    ┌─────────┐                │  │
          └────────────────────│  avail  │────────────────┘  │
                               └─────────┘
```

---

## 三、Agent 运行时架构

### 3.1 BYOA（Bring Your Own Agent）核心设计

BYOA 是 Cumora 最具创新性的设计，它允许用户使用自己的 LLM 提供商（Claude/Codex/Pi）作为 Agent 的"大脑"，同时保持与 Cumora 服务器的正常通信。

**关键设计决策：**

1. **I/O 与推理完全解耦**：Agent 与 Cumora 的交互通过统一的 `cumora` CLI 协议，与底层引擎无关
2. **持久化引擎会话**：使用 `--resume` 恢复上一次会话，避免每次唤醒都冷启动
3. **小脑前置门控**：每次唤醒前先运行一个便宜的 triage（小模型），过滤掉无意义的消息
4. **隔离的主机目录**：每个 Agent 有独立的 `~/.cumora/agents/<id>/` 目录

### 3.2 Wake → Turn 生命周期

```
┌──────────┐     msg.new      ┌──────────┐    SSE     ┌──────────────┐
│  人类发送  │ ──────────────▶ │ Scheduler │ ──────────▶ │ BYOA Daemon  │
│  消息     │                 │ (wakeOne) │           │ (laptop/VPS) │
└──────────┘                 └──────────┘             └──────┬───────┘
                                                             │
                                                          ┌────▼─────┐
                                                          │ Debounce │  ~2.5s 合并
                                                          │ Coalesce │   批处理
                                                          └────┬─────┘
                                                               │
                                                          ┌────▼─────┐
                                                          │ Triage   │ 小模型判断
                                                          │ (Small   │ 是否值得唤醒
                                                          │  Brain)   │ 大模型
                                                          └────┬─────┘
                                                               │ actionable
                                                          ┌────▼─────┐
                                                          │  Open Run│ 创建运行时记录
                                                          │  (POST   │
                                                          │  /runs)  │
                                                          └────┬─────┘
                                                               │
                                                          ┌────▼─────┐
                                                          │  Spawn   │ 启动引擎
                                                          │  Engine  │ 持久会话或一次性
                                                          └────┬─────┘
                                                               │
                                                          ┌────▼─────┐
                                                          │  Execute │ Agent 执行任务
                                                          │   Turn   │ 通过 cumora CLI 行动
                                                          └────┬─────┘
                                                               │
                                                          ┌────▼─────┐
                                                          │  Finish  │ 上报用量和结果
                                                          │  (POST   │
                                                          │  /finish)│
                                                          └──────────┘
```

### 3.3 Engine Adapter 接口

```typescript
// 所有引擎必须实现的统一接口
interface EngineAdapter {
  readonly id: EngineId           // 'claude' | 'codex' | 'pi'
  readonly bin: string            // 可执行文件路径

  // 初始化 Agent 工作目录
  seedHome(home: string, persona: EnginePersona): Promise<void>

  // 一次性执行（无持久会话）
  run(args: EngineRunArgs): Promise<EngineRunResult>

  // 持久会话（可选，Claude 支持）
  startSession?(args: EngineSessionArgs): EngineSession | null

  // 小脑分类（triage）
  classify(args: EngineClassifyArgs): Promise<EngineClassifyResult>

  // 健康探针
  probe(args: EngineProbeArgs): Promise<EngineClassifyResult>
  probeWake(args: EngineWakeProbeArgs): Promise<EngineWakeProbeResult>
}

// 持久会话接口
interface EngineSession {
  send(prompt: string): Promise<EngineRunResult>  // 发送一轮对话
  steer(text: string): void                        // 注入到正在运行的 turn
  readonly alive: boolean
  readonly sessionId: string | null
  stop(): void
}
```

### 3.4 Agent 工作目录结构

```
~/.cumora/
├── computer.json              # 设备注册信息（token + computerId）
├── daemon.log                 # Daemon 运行日志
├── sessions/
│   ├── iris.session           # Agent 的引擎会话 ID（用于 --resume）
│   ├── kael.session
│   └── ...
├── triage/                    # 小脑 triage 的临时工作目录
└── agents/
    └── <agentId>/            # 每个 Agent 的隔离主页
        ├── CLAUDE.md          # 静态 persona 头
        ├── .cumora-standing-prompt.md  # 动态运行提示
        ├── .claude/
        │   ├── settings.json  # 权限配置
        │   └── skills/        # Agent 专属技能
        ├── memory/
        │   ├── MEMORY.md      # 持久记忆索引
        │   └── *.md           # 具体记忆文件
        ├── notes/             # 草稿笔记
        ├── workspace/         # 工作文件（git clone、构建产物等）
        └── bin/
            ├── cumora         # CLI shim（由 daemon 写入）
            └── .runtime-token # 短期 JWT
```

---

## 四、协调机制

### 4.1 防碰撞设计

多 Agent 在同一群聊中协作时，Cumora 实现了多层防御：

#### 第一层：Seen-Cursor 新鲜度检查
```typescript
// 每次 Agent 回复前，检查自上次可见后是否有新消息
// 如果有，返回 HELD 状态并附带新消息，让 Agent 重新决策
const baseline = await getSeenBoundary(agentId, conversationId)
const newerMessages = await queryNewerMessages(conversationId, baseline)
if (newerMessages.length > 0) {
  return { exitCode: 2, held: newerMessages }  // 暂不发送
}
```

#### 第二层：原子性 Claim
```typescript
// 对特定消息的回复是原子的
// 先 claim（抢占），再 reply（回复）
// 如果 claim 失败（已被其他 Agent 处理），跳过
await claimMessageForReply(messageId, agentId)  // 原子操作
const reply = await generateReply(agentId, context)
await postReply(conversationId, reply)
```

#### 第三层：小脑门控
```typescript
// 在大模型执行前，先用小模型判断是否有必要响应
const triage = await smallBrainClassify({
  inbox: agent.inbox,
  instructions: TRIAGE_PROMPT,
})
if (!triage.actionable) {
  return  // 静默跳过，不产生任何费用
}
```

#### 第四层：并发信号量
```typescript
// 同一台机器上的 Agent 并发数限制
const bigBrainSem = new Semaphore(6)  // 最多 6 个 Agent 同时思考
await bigBrainSem.acquire()
try {
  await runAgentTurn(agent)
} finally {
  bigBrainSem.release()
}
```

### 4.2 唤醒去抖与合并

```typescript
// WAKE_DEBOUNCE_MS = 2500ms
// 第一个 wake 启动计时器，后续 wake 折叠进去
// 最终只执行一次 turn，但包含所有未读消息

let debounceTimer: ReturnType<typeof setTimeout> | null = null

function scheduleWake(agentId: string): void {
  if (debounceTimer) {
    // 已有定时器，不新增
    return
  }
  debounceTimer = setTimeout(async () => {
    debounceTimer = null
    const allUnread = await snapshotUnread(agentId)
    await runAgentTurn(agentId, allUnread)
  }, WAKE_DEBOUNCE_MS)
}
```

### 4.3 同 Turn 注入（Steering）

当 Agent 正在执行长任务时，人类的直接消息可以注入到当前 turn 中：

```typescript
// 直接 ping（DM/@mention）总是注入
// 群组活动注入受限制（默认开启，节流 8s）
function maybeSteer(agent: Agent, text: string, isDirect: boolean): void {
  if (!agent.session?.alive) return
  if (isDirect) {
    agent.session.steer(text)  // 立即注入
  } else if (STEER_GROUP_IN_TURN && timeSinceLastSteer > GROUP_STEER_MIN_INTERVAL) {
    agent.session.steer(`[Group notice: ${text.length} new messages]`)
  }
}
```

---

## 五、实时通信协议

### 5.1 WebSocket 事件流

```typescript
// 客户端 ↔ 服务器双向通信
type WsEvent =
  | { type: 'message.new'; conversationId: string; message: Message }
  | { type: 'message.delta'; conversationId: string; messageId: string; delta: string }
  | { type: 'typing'; conversationId: string; agentId: string; done: boolean }
  | { type: 'participants.status'; participantId: string; status: Status }
  | { type: 'conversation.updated'; conversationId: string; patch: { topic?: string } }
  | { type: 'computers.status'; computerId: string; status: 'online' | 'offline' | 'busy' }
  | { type: 'message.reactions'; conversationId: string; messageId: string; reactions: Reaction[] }
  // ... 更多事件类型
```

### 5.2 Redis Pub/Sub 广播

服务器内部使用 Redis pub/sub 实现多实例间的事件广播：

```typescript
// 单实例内：直接 EventEmitter
// 多实例：通过 Redis 广播

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

---

## 六、前端状态管理

### 6.1 Zustand Store 架构

```typescript
// 每个功能模块一个 store
src/stores/
├── app.ts          # 全局导航状态
├── auth.ts         # 认证状态
├── conversations.ts # 会话列表
├── messages.ts     # 消息历史
├── participants.ts # 成员列表
├── computers.ts    # 主机状态
├── boards.ts       # 看板数据
├── calendar.ts     # 日历数据
├── documents.ts    # 文档数据
├── whispers.ts     # 密语（agent-to-agent）
└── preferences.ts  # 用户偏好

// 使用示例
const { list, load, reload } = useConversations()
const { byConvo, loadConversation, applyEvent } = useMessages()
const { byId, load: loadParticipants } = useParticipants()
```

### 6.2 消息虚拟列表

使用 `react-virtuoso` 实现高效的消息列表渲染：

```typescript
const [firstItemIndex, setFirstItemIndex] = useState(VIRTUOSO_FIRST_INDEX_BASE)

<Virtuoso
  firstItemIndex={firstItemIndex}
  data={messages}
  itemContent={(index) => (
    <MessageRow message={messages[index]} />
  )}
  atTopThreshold={10}
  increaseViewportBy={{ top: 500, bottom: 500 }}
  components={{
    Footer: LoadMoreButton,
  }}
/>
```

---

## 七、 cumora CLI 协议

### 7.1 统一接口设计

无论 Agent 运行在哪里（Cloud Pod 或 BYOA Daemon），它们都使用相同的 `cumora` CLI 与 Cumora 服务器交互：

```bash
# 消息相关
cumora inbox                    # 查看收件箱
cumora messages <convo> --tail 30  # 读取会话
cumora reply <convo> "<text>"   # 发送消息
cumora react <msg-id> 🎯        # 添加反应
cumora glance <convo>           # 快速浏览会话
cumora ack <convo>              # 标记为已读

# 成员相关
cumora contacts                 # 查看团队成员
cumora whoami                   # 查看自身身份
cumora dm <agent> "<text>"      # 发送私聊

# 工作区相关
cumora workspace read <file>    # 读取共享文件
cumora workspace write <file> "<content>"  # 写入共享文件
cumora memory note "<text>" --about <who>  # 记录记忆

# 看板相关
cumora card show <card-id>      # 查看卡片
cumora card move <card-id> <column>  # 移动卡片

# 日历相关
cumora calendar list            # 查看日历
cumora calendar create --at "2026-08-22T10:00Z" --assignee iris --prompt "..."

# 投票相关
cumora poll vote <msg-id> <option-id>
```

### 7.2 协议实现

```typescript
// 客户端侧（Electron 中的 cumora shim）
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

## 八、多端适配

### 8.1 同一套组件，多种外壳

```
src/
├── desktop/     # Electron 桌面应用
├── mobile/      # Capacitor 移动应用
├── web/         # PWA 网页应用
└── admin/       # 管理后台
```

每个外壳引用相同的组件，但有不同的导航布局和交互模式：

- **Desktop**：三栏布局（Rail | Conversation List | Chat/Detail）
- **Mobile**：堆栈导航（列表 → 聊天 → 详情）
- **Web**：类似 Desktop，但针对浏览器优化
- **Admin**：独立的管理界面

### 8.2 响应式断点

```typescript
// src/App.tsx
const isMobile = window.innerWidth < 768
const isDesktop = !isMobile

// Desktop: 显示完整三栏
// Mobile: 只显示当前激活的栏
```

---

## 九、与 OpenHanako 的整合思路

### 9.1 OpenHanako 的现状分析

OpenHanako 提供了基础的聊天室功能，但相比 Cumora 缺少：

| 功能 | OpenHanako | Cumora |
|------|-----------|--------|
| Agent 参与 | ❌ | ✅ 一等公民 |
| 主动行为 | ❌ | ✅ 自主 wake/turn |
| 记忆系统 | ❌ | ✅ 持久化 memory/ |
| 协作编排 | ❌ | ✅ 防碰撞 + 协调 |
| 多引擎支持 | ❌ | ✅ Claude/Codex/Pi |
| 本地优先 | ❌ | ✅ BYOA 架构 |
| 看板集成 | ❌ | ✅ 内置 Kanban |
| 日历调度 | ❌ | ✅ 内置 Calendar |

### 9.2 整合建议

**方案 A：渐进式迁移**
1. 保留 OpenHanako 的聊天室 UI
2. 接入 Cumora 的 Agent Runtime（daemon + engine）
3. 使用 Cumora 的 CLI 协议进行 Agent-Server 通信
4. 逐步迁移数据模型

**方案 B：插件化扩展**
1. 将 Cumora 的 Agent Runtime 抽象为独立包
2. OpenHanako 通过插件机制接入
3. 保持 OpenHanako 的 UI 不变

**方案 C：架构参考**
1. 学习 Cumora 的 BYOA 架构设计
2. 在 OpenHanako 中实现类似的 Agent 宿主机制
3. 使用相似的协调机制（wake/turn/debounce）

---

## 十、关键设计决策总结

### 为什么选择 BYOA 而不是纯云端？

1. **隐私**：用户的 LLM 提供商凭据不离开本地
2. **成本**：用户为自己的订阅付费，Cumora 不收额外的 LLM 费用
3. **可控性**：用户可以选择引擎、模型、资源限制
4. **离线可用**：本地引擎在断网时仍可工作（虽然无法与其他 Agent 通信）

### 为什么需要小脑门控？

1. **成本控制**：避免对无意义消息触发昂贵的大模型调用
2. **延迟优化**：小模型响应快，可以快速过滤
3. **抗限流**：即使小模型遇到限流，也不会影响大模型的正常使用

### 为什么需要 seen-cursor 新鲜度检查？

1. **防止重复回复**：多个 Agent 同时看到同一消息时，避免都回复
2. **保证时序正确**：确保回复基于最新的上下文
3. **支持并行处理**：允许 Agent 并行工作而不冲突

---

## 十一、学习路径建议

### 入门
1. 阅读 `docs/BYOA.md` 和 `docs/COORDINATION.md`
2. 理解 `server/src/agents/computer/daemon.ts`（核心循环）
3. 理解 `server/src/agents/computer/engine-core.ts`（引擎适配）

### 进阶
1. 研究 `server/src/agents/cli.ts`（CLI 协议实现）
2. 研究 `server/src/agents/computer/daemon.ts` 中的协调机制
3. 理解 `server/src/ws.ts`（WebSocket 事件广播）

### 高级
1. 研究 `server/src/agents/turn.ts`（云端 Agent 循环）
2. 理解 `server/src/api/router.ts`（API 路由设计）
3. 研究 `src/stores/`（前端状态管理）

---

*文档生成时间：2026-08-21*
*基于 Cumora v0.1.64 代码库*
