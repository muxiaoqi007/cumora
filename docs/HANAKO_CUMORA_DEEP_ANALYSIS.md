# OpenHanako vs Cumora 深度架构分析与整合方案

> 本文档基于对两个项目源码的深入分析，为整合提供技术指导。

---

## 一、OpenHanako 核心架构解析

### 1.1 项目定位

OpenHanako（HanaAgent）是一个**个人 AI 助手**，强调：
- 有记忆、有性格、会主动行动
- 多 Agent 在单机上协作
- 支持多平台接入（Telegram、飞书、QQ、微信）
- 本地优先，数据存储在 `~/.hanako`

### 1.2 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 桌面端 | Electron 42 + React 19 | 本地 GUI |
| 服务端 | Hono + @hono/node-server | 独立 Node.js 进程 |
| Agent 运行时 | Pi SDK | 开源的 agent 框架 |
| 数据库 | better-sqlite3 | WAL 模式本地存储 |
| 状态管理 | Zustand 5 | 前端状态 |
| 构建 | Vite 7 | 现代前端构建 |

### 1.3 核心目录结构

```
openhanako/
├── core/                 # 引擎编排层
│   ├── agent.ts          # Agent 核心类
│   ├── agent-manager.ts  # 多 Agent 管理
│   └── persona-source.ts # 人格系统
├── lib/                  # 核心库
│   ├── memory/           # 记忆系统
│   │   ├── fact-store.ts      # 事实存储
│   │   ├── session-summary.ts # 会话摘要
│   │   └── memory-ticker.ts   # 记忆定时刷新
│   ├── tools/            # 工具集
│   │   ├── file-tool.ts        # 文件操作
│   │   ├── browser-tool.ts     # 浏览器
│   │   ├── web-search.ts       # 网页搜索
│   │   ├── channel-tool.ts     # 频道通信
│   │   └── subagent-tool.ts    # 子 Agent 通信
│   ├── desk/             # 书桌系统
│   │   ├── desk-manager.ts     # 书桌管理
│   │   └── cron-store.ts       # 定时任务
│   └── bridge/           # 平台适配器
│       ├── telegram.ts
│       ├── feishu.ts
│       └── wechat.ts
├── hub/                  # 调度器
│   ├── scheduler.ts      # 后台任务调度
│   ├── channel-router.ts # 频道路由
│   └── event-bus.ts      # 事件总线
├── server/               # HTTP + WebSocket 服务
├── desktop/              # Electron 应用
├── shared/               # 跨层共享工具
└── plugins/              # 内置系统插件
```

### 1.4 Agent 数据模型

```typescript
// Agent 目录结构
~/.hanako/agents/<agentId>/
├── config.yaml              # 配置（人格、模型、工具）
├── memory/
│   ├── facts.db             # SQLite 事实存储
│   ├── memory.md            # 长期记忆索引
│   ├── today.md             # 今日记忆
│   ├── week.md              # 周记忆
│   ├── longterm.md          # 长期记忆
│   └── summaries/           # 会话摘要
├── sessions/                # 会话历史
├── desk/                    # 书桌文件
└── skills/                  # 技能定义
```

### 1.5 核心能力

1. **记忆系统**
   - 事实存储（SQLite）
   - 时效性记忆（today/week/longterm）
   - 会话摘要（自动压缩）

2. **人格系统**
   - 人格模板
   - 自定义人格文件
   - 每个 Agent 独立人格

3. **工具系统**
   - 文件读写
   - 浏览器操作
   - 网页搜索
   - 定时任务
   - 子 Agent 委派

4. **多平台接入**
   - Telegram
   - 飞书
   - QQ
   - 微信机器人

5. **书桌系统**
   - 异步协作空间
   - 文件监听
   - 便签系统

---

## 二、Cumora 核心架构回顾

### 2.1 项目定位

Cumora 是一个 **Agent-First 团队协作平台**，强调：
- Agent 与人类平等参与团队协作
- 多 Agent 在同一群聊中协作
- 本地优先（BYOA 架构）
- 实时通信（WebSocket + Redis）

### 2.2 核心差异对比

| 维度 | OpenHanako | Cumora |
|------|-----------|--------|
| **定位** | 个人助手 | 团队协作平台 |
| **Agent 关系** | 并行独立 | 协同合作 |
| **通信方式** | 频道/DM | 群聊 + DM + Whisper |
| **协调机制** | ❌ 无 | ✅ 多层防御 |
| **数据库** | SQLite 本地 | PostgreSQL + Redis |
| **实时性** | 异步为主 | 实时 WebSocket |
| **多实例** | ❌ 单机 | ✅ 多服务器 |
| **看板/日历** | ❌ 无 | ✅ 内置 |
| **CLI 协议** | 自定义 | 统一 cumora CLI |

---

## 三、关键架构差异详解

### 3.1 Agent 协作模型

**OpenHanako：**
```
Agent A  ──┐
           ├──→ 书桌 (异步协作)
Agent B  ──┘

Agent A  ──┐
           ├──→ 频道群聊 (同时只能一个发言)
Agent B  ──┘
```

**Cumora：**
```
Agent A  ──┐
           ├──→ 群聊 (实时协作，防碰撞)
Agent B  ──┤
           │
Human C  ──┘

协调机制：
- seen-cursor 新鲜度检查
- 小脑 triage 门控
- 唤醒去抖合并
- 并发信号量
- 同 turn 注入
```

### 3.2 记忆系统设计

**OpenHanako 记忆：**
```typescript
// 时效性分层
- today.md      // 今日发生的
- week.md       // 本周重要的
- longterm.md   // 长期记住的
- facts.db      // SQLite 结构化事实

// 自动摘要
- summaries/    // 会话自动压缩
```

**Cumora 记忆：**
```typescript
// 文件系统记忆
~/.cumora/agents/<id>/memory/
├── MEMORY.md     // 索引文件
└── *.md          // 主题记忆

// 服务器端记忆
- agent_memory 表  // 结构化记忆
- agent_log 表     // 运行日志
```

### 3.3 协调机制对比

| 机制 | OpenHanako | Cumora |
|------|-----------|--------|
| **防重复回复** | ❌ | ✅ seen-cursor |
| **消息新鲜度** | ❌ | ✅ 原子 claim |
| **成本门控** | ❌ | ✅ 小脑 triage |
| **唤醒合并** | ❌ | ✅ 2.5s 去抖 |
| **并发控制** | ❌ | ✅ 信号量 (6) |
| **限流适应** | ❌ | ✅ AdaptivePacer |
| **同 turn 注入** | ❌ | ✅ steering |

---

## 四、整合方案设计

### 4.1 方案选择：渐进式迁移（推荐）

**理由：**
1. OpenHanako 已有完整的产品形态和用户基础
2. 保留现有 UI 和经验，只增强 Agent 能力
3. 风险可控，可以逐步验证

### 4.2 架构映射

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenHanako (现有)                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Electron App │  │  Hono Server │  │   Pi SDK         │  │
│  │  (UI)        │  │  (WebSocket) │  │   (Agent Run)    │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                 │                   │            │
│         └─────────────────┴───────────────────┘            │
│                          │                                  │
└──────────────────────────┼──────────────────────────────────┘
                           │
              ┌────────────▼────────────┐
              │    Cumora Runtime       │
              │  (新增适配层)            │
              │                         │
              │  - wake/scheduler       │
              │  - coordination layer   │
              │  - cumora CLI protocol  │
              │  - multi-agent sync     │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │    OpenHanako Core      │
              │  (保持现有)              │
              │                         │
              │  - Agent 实例           │
              │  - 记忆系统             │
              │  - 工具系统             │
              │  - 多平台 Bridge        │
              └─────────────────────────┘
```

### 4.3 实施步骤

#### Phase 1: 接入 Cumora Runtime（2 周）

**目标：** 让 OpenHanako 的 Agent 能够被 Cumora 服务器调度

**改动：**
1. 移植 `daemon.ts` 作为独立服务
2. 实现 `cumora` CLI shim 适配 OpenHanako API
3. 添加 Agent 注册和配对机制

**关键代码：**
```typescript
// openhanako-cumora-bridge.ts
import { CumoraDaemon } from 'cumora-daemon-runtime'

class OpenHanakoBridge extends CumoraDaemon {
  async spawnEngine(agentId: string, prompt: string): Promise<string> {
    // 调用 OpenHanako 的 Agent 执行
    const agent = this.getAgent(agentId)
    return await agent.run(prompt)
  }
  
  async cumoraReply(convoId: string, text: string): Promise<void> {
    // 通过 OpenHanako 的频道系统发送
    await this.sendToChannel(convoId, text)
  }
}
```

#### Phase 2: 添加协调机制（2 周）

**目标：** 实现多 Agent 协作防碰撞

**改动：**
1. 实现 seen-cursor 新鲜度检查
2. 添加小脑 triage 门控
3. 实现唤醒去抖

**关键代码：**
```typescript
// coordination.ts
class CoordinationLayer {
  private seenCursors = new Map<string, number>()  // agentId:convoId -> seq
  
  async checkFreshness(agentId: string, convoId: string, minSeq: number): Promise<boolean> {
    const baseline = this.seenCursors.get(`${agentId}:${convoId}`) ?? 0
    return minSeq > baseline
  }
  
  async advanceCursor(agentId: string, convoId: string, seq: number): void {
    this.seenCursors.set(`${agentId}:${convoId}`, Math.max(
      this.seenCursors.get(`${agentId}:${convoId}`) ?? 0,
      seq
    ))
  }
}
```

#### Phase 3: 增强 Agent 能力（3 周）

**目标：** 让 Agent 具备团队协作能力

**改动：**
1. 添加群聊感知（读取群消息）
2. 添加主动行为（agenda turn）
3. 添加 Agent-to-Agent 通信（whisper）

#### Phase 4: 集成 Kanban 和 Calendar（2 周）

**目标：** 复用 Cumora 的任务管理功能

### 4.4 API 适配层设计

```typescript
// cumora-protocol.ts
interface CumoraProtocol {
  // Agent 生命周期
  pair(computerId: string): Promise<void>
  heartbeat(): Promise<void>
  
  // 消息相关
  getInbox(): Promise<InboxSnapshot>
  reply(convoId: string, text: string): Promise<Message>
  react(messageId: string, emoji: string): Promise<void>
  
  // 工具调用
  workspaceRead(path: string): Promise<string>
  workspaceWrite(path: string, content: string): Promise<void>
  memoryNote(text: string, options: MemoryOptions): Promise<void>
  
  // 看板
  cardShow(cardId: string): Promise<Card>
  cardMove(cardId: string, columnId: string): Promise<void>
  
  // 日历
  calendarCreate(event: CalendarEvent): Promise<Event>
  calendarList(): Promise<Event[]>
}
```

---

## 五、关键技术决策

### 5.1 为什么选择渐进式迁移？

| 考虑因素 | 渐进式 | 完全重写 |
|---------|--------|---------|
| 用户影响 | 无感升级 | 需要重新学习 |
| 开发成本 | 中等 | 高 |
| 风险 | 低 | 高 |
| 时间周期 | 3 个月 | 6+ 个月 |
| 代码复用 | 高 | 低 |

### 5.2 如何保持 OpenHanako 的特性？

1. **记忆系统** → 保留 OpenHanako 的记忆结构，Cumora 只读取不写入
2. **人格系统** → 保留 OpenHanako 的人格模板
3. **工具系统** → 保留 OpenHanako 的工具，Cumora CLI 作为统一入口
4. **多平台接入** → 保留 OpenHanako 的 Bridge 系统

### 5.3 Cumora 新增什么？

1. **协调机制** → 防止多 Agent 碰撞
2. **实时通信** → WebSocket 实时同步
3. **Kanban/Calendar** → 任务管理集成
4. **成本记录** → LLM 使用追踪
5. **多主机支持** → BYOA 架构

---

## 六、实施路线图

```
Week 1-2:    基础对接
             ├── 移植 Cumora Daemon
             ├── 实现 CLI shim
             └── 第一个测试 Agent

Week 3-4:    协调机制
             ├── seen-cursor 实现
             ├── triage 门控
             └── 唤醒去抖

Week 5-7:    能力增强
             ├── 群聊感知
             ├── 主动行为
             └── Agent-to-Agent 通信

Week 8-9:    功能集成
             ├── Kanban 对接
             ├── Calendar 对接
             └── UI 适配

Week 10-12:  生产化
             ├── 性能优化
             ├── 错误处理
             ├── 文档
             └── 用户测试
```

---

## 七、风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| 协议不兼容 | 中 | 高 | 在第一阶段就建立适配层 |
| 性能下降 | 中 | 中 | 使用 Cumora 已有的优化经验 |
| 用户接受度 | 低 | 中 | 保持 OpenHanako 的 UI 不变 |
| 维护成本 | 中 | 中 | 抽取独立包，减少耦合 |

---

## 八、总结

OpenHanako 和 Cumora 各有优势：

**OpenHanako 优势：**
- 成熟的个人助手产品
- 完整的多平台接入
- 丰富的工具系统
- 良好的 UI/UX

**Cumora 优势：**
- 精心设计的多 Agent 协调机制
- 企业级协作功能（Kanban/Calendar）
- BYOA 架构（本地优先）
- 实时通信能力

**整合价值：**
将两者的优势结合，可以创建一个既适合个人使用又支持团队协作的 AI Agent 平台。

---

*文档生成时间：2026-08-21*
*基于 OpenHanako v0.449 和 Cumora v0.1.64 分析*
