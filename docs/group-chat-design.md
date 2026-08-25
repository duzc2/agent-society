# 智能体群聊（Group Chat）功能设计方案

> 版本：v1.3
> 状态：Phase 1 后端已实施，前端待实施
> 范围：架构设计、核心逻辑、UI 设计、交互设计、实施路径

---

## 变更历史

### v1.3
- **架构重构**：群聊服务完全通过 `ModuleRegistry` 依赖注入系统注册，**不挂载到 runtime**
- `GroupChatService` 使用 `registry.declare()` 声明依赖与提供服务，与 `MoodService` 等模块一致
- 工具执行器通过 `registry.getService('groupChatService')` 获取服务，不通过 `this.runtime.xxx`
- 消息格式化、HTTP 路由、心跳广播均走 DI 依赖链，高内聚低耦合
- **新增移动端设计**：`web/mobile` 群聊视图，精简至必要功能

### v1.2
- 明确群聊对标微信群体验：随时创建 / 加人 / 退群、非必须回复
- `get_org_structure` 增加群摘要区（仅 5 个轻量字段，减少上下文干扰）
- 新增 `get_group_info` 工具：查看自己所在群的完整信息
- 成员进入 / 退出群聊时，群内系统消息通知其他成员
- 群消息格式化强调"非必须回复，根据话题相关性自行决定"
- **用户权限**：user 不在任何群成员列表中，但可向任何群发消息、查看任何群聊历史
- **侧边栏改为标签页**："智能体"（保持现有内容不变）/"群"（仅展示群名(人数)）

---

## 1. 调研结论

### 1.1 现有系统关键机制盘点

| 机制 | 实现位置 | 说明 |
|------|----------|------|
| 岗位树 | `src/platform/core/org_primitives.js` | Role（岗位）+ Agent（智能体），通过 `parentAgentId` / `roleId` 组织树状结构；前端 `GlobalSidebar.vue` 展示组织列表（平铺），`AgentList.vue` 展示选中组织的岗位树与智能体列表，由心跳 `org_tree` 事件驱动 |
| 网状协作 | `send_message` 工具（`tools_agent.js`）+ `get_org_structure` 工具 | 任意智能体可向任意其他智能体发异步消息，支持多收件人数组、`delayMs` 延迟投递 |
| 异步消息总线 | `src/platform/core/message_bus.js` | 按收件人（agentId）维护 FIFO 队列；`send()` / `receiveNext()` / `drainAll()` / `waitForMessage()`；支持延迟消息（`deliverAt` 最小堆排序） |
| 消息调度 | `runtime_messaging.js` | 生产者-消费者常驻循环；单智能体串行、多智能体并发（`maxConcurrent`）；`_scheduleMessageProcessing` 轮询所有智能体取队列消息 |
| 插话机制 | `compute_scheduler.js` `_checkAndApplyInterruptions()` | 在 **pre-LLM / post-LLM / post-tool** 三个时机 `drainAll(agentId)` 排空队列新消息 → `_formatMessageForLlm()` 格式化 → 追加到当前 Turn 的 `conv` → `turn.phase = "need_llm"` 重新调用 LLM；配合 `AgentCancelManager` 的 epoch 机制丢弃过期 LLM 结果（`reason = "message_interruption"`） |
| 消息持久化 | `http_server/message-handlers.js` | `messagesByAgent: Map<agentId, Message[]>`；落盘 `web/messages/<agentId>.jsonl`；`storeMessage()` 同时写入 `from` 与 `to` 两个智能体的历史 |
| 前端实时推送 | `heartbeat/heartbeat_broker.js` + `web/v3/src/services/heartbeatService.ts` | 全局递增 messageId，客户端轮询 `/api/heartbeat?lastMessageId=` 增量拉取；`agent_message`（消息增量）、`org_tree`（组织树）事件 |
| 前端会话模型 | `web/v3/src/stores/chat.ts` | `chatMessages: Record<agentId, Message[]>`，按智能体维度组织消息流；`ChatArea.vue` / `ChatMessageList.vue` 渲染 |
| 组织结构工具 | `tools_agent.js` `_executeGetOrgStructure()` | 返回 `{ self, selfOrg, otherOrgs }`，按工作空间组织区分自己与他人，包含岗位 → 智能体列表 |
| **DI 系统** | `src/platform/core/module_registry.js` + `bootstrap_manager.js` | `ModuleRegistry` 声明式依赖注入：`registry.declare({name, requires, provides, init(deps)})` 自动按依赖拓扑激活；`registry.provide({key:value})` 手动注入基础服务；`registry.getService(name)` 只读查找。每个服务文件末尾以副作用 `registry.declare()` 自注册，`import` 即触发声明。参考实现：`mood_service.js`、`workspace_manager.js`、`message-handlers.js` |

### 1.2 插话机制细节（复用前提）

插话的完整链路（`spec/02-architecture/04-interruption.md` + 代码确认）：

1. `MessageBus.send()` 将消息推入目标智能体队列；
2. 若目标智能体正在 `waiting_llm`，`ComputeScheduler` 在 LLM 调用前后、工具执行后调用 `_checkAndApplyInterruptions`；
3. 该函数 `drainAll()` **原子排空**目标队列中所有新消息，逐条格式化后追加到当前 Turn 的对话上下文；
4. 置 `phase = "need_llm"`，基于包含新消息的上下文重新调用 LLM；
5. `AgentCancelManager` 递增 epoch，旧 LLM 响应返回后被识别为过期并丢弃（不影响处理流程，只是不采纳结果）。

**关键结论：插话机制是按"个人队列 + drainAll 批量合并"工作的，对消息来源（谁发的）完全无感知。群消息只要进入成员的个人队列，就能 100% 复用插话能力，且同一轮到达的多条群消息天然被合并为一批处理。**

### 1.3 现状与群聊需求的差距

| 需求 | 现状 | 差距 |
|------|------|------|
| 智能体自主拉群 | 无群概念，`send_message` 仅支持"发给已有成员列表" | 需要群元数据（成员集合、群名、创建者）与群生命周期管理 |
| 群里智能体都能看到消息 | 多收件人数组可实现"一次发多人" | 需要"群成员动态变化"（拉人/踢人/退群后自动生效）与群历史 |
| 异步处理 | ✅ MessageBus 天然支持 | 无差距，直接复用 |
| 插话形式处理 | ✅ ComputeScheduler 天然支持 | 只需扩展消息格式化（群聊格式 + 回复提示指向 send_group_message） |
| 群聊历史查看 | 无 | 需要独立群历史存储 + 查询 API |
| 前端群聊 UI | 仅个人会话 | 需要群列表、群聊天视图、群成员面板、建群交互 |
| 组织架构可见群 | `get_org_structure` 仅返回岗位树 | 需在组织架构中附加群摘要（轻量字段） |
| 群详情查询 | 无 | 需新增 `get_group_info` 工具 |
| 成员变动通知 | 无 | 需群内系统消息通知成员进入/退出 |

---

## 2. 总体架构设计

### 2.0 架构原则：服务注册 + 依赖注入，零 runtime 耦合

群聊功能作为独立服务通过 `ModuleRegistry` DI 系统注册，**不挂载到 `runtime` 对象**。这与现有的 `MoodService`、`WorkspaceManager`、`HeartbeatBroker` 等通过 `registry.declare()` 注册的模式完全一致。

**现有 DI 模式参考**（`mood_service.js` 末尾）：

```js
// 文件末尾副作用自注册
registry.declare({
  name: "mood-service",
  requires: ["logRoot", "configService", "heartbeatBroker", "runtimeEvents", "llmConversations", "agentLlmClients", "dataDir"],
  provides: ["moodService"],
  async init(deps) {
    const service = new MoodService(deps);  // deps 是已注入的依赖
    await service.init();
    return { moodService: service };
  }
});
```

群聊服务遵循相同模式：

```js
// group_chat_service.js 文件末尾
registry.declare({
  name: "group-chat-service",
  requires: ["bus", "heartbeatBroker", "org", "agentManager", "logRoot", "dataDir", "runtimeDir"],
  provides: ["groupChatService"],
  async init(deps) {
    const service = new GroupChatService(deps);
    await service.init();
    return { groupChatService: service };
  }
});
```

**DI 依赖链**：

```
BootstrapManager.provide({ bus, heartbeatBroker, org, ... })
       │
       ▼
registry._activateAll() 自动拓扑排序
       │
       ▼  依赖 bus / heartbeatBroker / org / agentManager / dataDir 已就绪
GroupChatService 激活 → provides: ["groupChatService"]
       │
       ▼  依赖 groupChatService 已就绪
group-routes 激活（HTTP 路由）→ provides: []
       │
       ▼  依赖 groupChatService 已就绪
group-tools 激活（工具注册）→ provides: ["groupTools"]
```

**关键设计点**：
- `GroupChatService` 构造函数接收 `deps` 对象，不接收 `runtime`；
- 内部通过 `this.bus` / `this.heartbeatBroker` / `this.org` 等依赖访问，**零 `this.runtime.xxx` 引用**；
- HTTP 路由模块通过 `deps.groupChatService` 获取服务实例；
- 工具执行器通过 `registry.getService('groupChatService')` 获取服务实例；
- 消息格式化器作为纯函数模块，不依赖任何运行时实例。

### 2.1 核心思路：三层结构，最大化复用现有管道

```
┌─────────────────────────────────────────────────────────────┐
│            群聊服务层 GroupChatService（DI 注册）              │
│  GroupRegistry（群元数据）· 群生命周期 · 成员管理 · 权限校验      │
│  群历史（groups/<groupId>.jsonl）· 群消息扇出 · 成员变动通知     │
│  deps: bus, heartbeatBroker, org, agentManager, dataDir     │
└──────────────┬─────────────────────────────────────────────┘
               │ bus.send({to: memberId, groupId, ...}) × N
┌──────────────▼──────────────────────────────────────────────┐
│               现有异步管道（零修改复用）                        │
│  MessageBus（个人队列）→ RuntimeMessaging 调度                  │
│  → ComputeScheduler._checkAndApplyInterruptions（插话）        │
│  → TurnEngine 合并上下文 → LLM 重新生成回复                     │
└──────────────────────────────────────────────────────────────┘
```

**设计决策：扇出（fan-out）而非群队列（group queue）**

| 方案 | 做法 | 优点 | 缺点 |
|------|------|------|------|
| **A. 扇出（推荐）** | 群消息发送时遍历成员，各自 `bus.send()` 一份，消息带 `groupId` 标记 | 插话/调度/并发控制零改动；成员离线/忙碌语义与个人消息一致；消息合并天然支持 | 每条群消息产生 N 次队列写入与 N 次潜在 LLM 调用（但这是"每个成员都要看到并可能回复"的必然代价） |
| B. 群队列 | `bus.send({to: groupId})`，调度器识别群 ID 轮询成员 | 一次写入 | 需改 MessageBus、调度器、插话三处，侵入大；群成员被占用时的语义难以界定 |

### 2.2 模块划分

```
src/platform/services/group_chat/
├── group_chat_service.js     # 群聊服务（DI 注册）：扇出、权限、生命周期、事件广播、成员变动通知
├── group_registry.js         # 群元数据存储（groups.json）与查询（纯数据层，无外部依赖）
├── group_message_store.js    # 群历史存储（web/messages/groups/<groupId>.jsonl）（纯数据层）
└── group_routes.js           # HTTP 路由（DI 注册，requires: app, groupChatService, log, runtimeDir）

src/platform/runtime/
└── tools_group.js            # 群聊工具实现（DI 注册，requires: groupChatService, org, bus）

src/platform/utils/message/
└── group_message_formatter.js  # 群消息格式化器（纯函数，无依赖）
```

- **`GroupChatService`** 通过 `registry.declare()` 注册，`provides: ["groupChatService"]`；构造函数接收 `{ bus, heartbeatBroker, org, agentManager, logRoot, dataDir, runtimeDir }`；**不挂载到 runtime**；
- **`GroupRoutes`**（HTTP 路由）通过 `registry.declare()` 注册，`requires: ["app", "groupChatService", "log", "runtimeDir"]`，`provides: []`；在 `http_server/index.js` 以副作用 `import` 触发注册；
- **`GroupTools`**（工具实现）通过 `registry.declare()` 注册，`requires: ["groupChatService", "org", "bus"]`，`provides: ["groupTools"]`；在 `tool_executor.js` 或 `tools_schema.js` 以副作用 `import` 触发注册；
- **`group_message_formatter.js`** 是纯函数模块，`formatGroupMessageForAgent(message, senderInfo)` / `formatGroupSystemMessageForAgent(message)`，无类、无依赖、可直接 import；
- **`GroupRegistry`** 和 **`GroupMessageStore`** 是纯数据层类，由 `GroupChatService` 在 `init()` 中实例化，不独立注册到 DI；
- 新工具组 `group_chat` 注册到 `tool_group_manager.js`（在 BootstrapManager 中以 `registerBuiltins: true` 触发）。

---

## 3. 核心逻辑设计

### 3.1 数据模型

```js
// 群元数据（data/runtime/state/groups.json）
{
  "groups": [
    {
      "id": "g_1f3a...",              // 群 ID，随机 UUID
      "name": "产品需求讨论群",          // 群名（必填）
      "description": "围绕 v2.0 需求评审的临时协作群",
      "ownerAgentId": "agent_abc",     // 创建者（root 或任意智能体）
      "members": ["agent_abc", "agent_def", "root"],
      "createdAt": "2026-08-23 17:00:00",
      "updatedAt": "2026-08-23 17:30:00",
      "status": "active",              // active | archived（解散）
      "lastMessageAt": "2026-08-23 17:29:58",
      "lastMessagePreview": "方案我整理好了，详见工作区 report.md"
    }
  ]
}

// 群消息（web/messages/groups/g_1f3a....jsonl，每行一条）
{
  "id": "gm_9c2e...",               // 群消息全局唯一 ID
  "kind": "group",                  // group | group_system
  "groupId": "g_1f3a...",
  "from": "agent_abc",
  "fromRoleName": "产品经理",         // 冗余角色名，方便前端与格式化
  "fromName": "产品经理-1",           // 冗余显示名
  "taskId": null,                    // 可选：关联任务
  "payload": { "text": "..." },
  "createdAt": "2026-08-23 17:29:58"
}
```

### 3.2 消息流（核心时序）

```
Agent A 调用 send_group_message(groupId, payload)
  │
  ├─ 0. ToolExecutor 调用 GroupTools.sendGroupMessage()
  │      └─ GroupTools 通过 DI 获取 groupChatService 实例：
  │           const svc = registry.getService('groupChatService');
  │           return svc.sendGroupMessage({ from: ctx.agent.id, groupId, payload });
  │
  ├─ 1. GroupChatService.sendGroupMessage()
  │      ├─ 校验：A ∈ members（user 例外，跳过成员校验）且群 active
  │      ├─ 生成 groupMessageId；写入群历史（group_message_store）
  │      ├─ 更新群 lastMessageAt / lastMessagePreview
  │      ├─ this.heartbeatBroker.broadcast('group_message', { groupId, messages: [...] })
  │      └─ 扇出：for M in members:
  │             this.bus.send({
  │               to: M,
  │               from: A,
  │               payload,
  │               groupId, groupMessageId, groupName,   // 扩展字段
  │               kind: 'group',                        // 标记群消息
  │             })
  │
  └─ 2. 每个成员 M 的既有管道自动接管（零改动）：
         MessageBus 队列 → RuntimeMessaging 调度
         → ComputeScheduler._checkAndApplyInterruptions（插话）
         → 群消息格式化 → 追加 conv → need_llm
         → LLM 自主决定是否回复（调用 send_group_message 回到群里）
```

**要点**：
- `GroupChatService` 通过 DI 注入的 `this.bus` / `this.heartbeatBroker` 访问依赖，**不通过 `this.runtime.xxx`**；
- 扇出的消息 `kind: 'group'` + `groupId`，格式化层据此走群聊模板；
- `storeMessage`（消息持久化层）检测到 `kind === 'group'` 时**不写入个人历史**（避免污染个人会话流），群历史由 `group_message_store` 统一维护；
- 群消息对成员的处理语义与个人消息完全一致：空闲则立即处理，忙碌则插话打断，离线（停用）则不处理（`_processAgentMessage` 已有状态检查）。

### 3.3 工具集（智能体自主拉群的能力）

新增工具组 `group_chat`，全部纳入 `get_org_structure` 同级提示词引导：

| 工具 | 参数 | 说明 |
|------|------|------|
| `create_group` | `name, memberIds[], description?` | 创建群并自动邀请成员；建群后向每个成员发一条系统通知（"您已被邀请加入群 X"），该通知也走个人队列触发插话。群内同时生成系统消息"A 创建了本群" |
| `invite_to_group` | `groupId, memberIds[]` | 拉人进群；权限：owner 或 root。群内生成系统消息"A 邀请了 B、C 加入群聊" |
| `remove_from_group` | `groupId, memberIds[]` | 移出成员；权限：owner 或 root（不能移出 owner 自己，除非 root）。群内生成系统消息"B 已被移出群聊" |
| `leave_group` | `groupId` | 主动退群（任何成员）。群内生成系统消息"A 退出了群聊" |
| `dissolve_group` | `groupId` | 解散群（owner 或 root）；向剩余成员发解散通知。群内生成系统消息"群聊已解散" |
| `send_group_message` | `groupId, payload` | 发群消息；权限：群成员 |
| `get_group_info` | `groupId` | 查看自己所在群的完整信息：创建者、创建时间、成员列表（id/name/roleName/status）、群状态、最近消息摘要。**仅群成员可调用** |
| `list_my_groups` | — | 列出我所在的群（与 `get_org_structure` 的群摘要字段一致，但仅返回自己加入的群） |

**提示词引导**：在系统提示词的组织协作段落追加群聊能力说明，例如：
> 当多个智能体需要持续协作、反复沟通时，可以调用 create_group 建立群聊，将相关成员拉入群中；群内消息通过 send_group_message 发送，所有成员都能看到并可插话回复。**群消息不需要每条都回复——请根据消息内容是否与你的职责、当前任务相关来决定是否回复。** 可以通过 get_org_structure 查看组织架构中存在的群（摘要信息），通过 get_group_info 查看自己所在群的完整详情。

### 3.3.1 `get_org_structure` 扩展：群聊摘要区

`get_org_structure` 返回结构**新增 `groups` 字段**，与现有 `self` / `selfOrg` / `otherOrgs` 平级：

```js
// get_org_structure 返回新增字段
{
  self: { ... },          // 不变
  selfOrg: { ... },       // 不变
  otherOrgs: [ ... ],     // 不变

  // 【新增】群聊摘要（仅包含可见群，轻量字段）
  groups: [
    {
      id: "g_1f3a...",
      name: "产品需求讨论群",
      ownerAgentId: "agent_abc",
      memberCount: 5,
      isMember: true        // 当前调用者是否为群成员
    }
    // 不返回：成员列表、描述、创建时间、最近消息 → 需要详情时调 get_group_info
  ]
}
```

**可见性规则**：
- `isMember: true` 的群：自己已加入，可调 `get_group_info` 看详情
- `isMember: false` 的群：组织内存在但自己未加入（知道有这个群、谁建的、多少人，但不能发消息也不能查详情）
- 目的：让智能体感知组织中的群聊生态，同时用 5 个轻量字段避免上下文膨胀

### 3.3.2 `get_group_info` 工具详情

```js
// 工具 schema
{
  name: "get_group_info",
  description: "查看自己所在群的完整信息，包括创建者、创建时间、成员列表、群状态、最近消息摘要。仅群成员可调用。非成员调用返回错误。",
  parameters: {
    type: "object",
    properties: {
      groupId: { type: "string", description: "群 ID" }
    },
    required: ["groupId"]
  }
}

// 返回示例
{
  id: "g_1f3a...",
  name: "产品需求讨论群",
  description: "围绕 v2.0 需求评审的临时协作群",
  ownerAgentId: "agent_abc",
  ownerName: "产品经理-1",
  ownerRoleName: "产品经理",
  createdAt: "2026-08-23 17:00:00",
  status: "active",
  memberCount: 5,
  members: [
    { id: "agent_abc", name: "产品经理-1", roleName: "产品经理", status: "idle" },
    { id: "agent_def", name: "研发工程师-1", roleName: "研发工程师", status: "processing" },
    // ...
  ],
  lastMessageAt: "2026-08-23 17:29:58",
  lastMessagePreview: "方案我整理好了..."
}
```

### 3.3.3 成员变动通知（群内系统消息）

群内成员变动时，自动向群历史写入系统消息并扇出通知到所有成员：

| 事件 | 系统消息内容 | 触发方 |
|------|-------------|--------|
| 建群 | `[系统] {创建者名称} 创建了本群` | `create_group` |
| 成员加入 | `[系统] {邀请者名称} 邀请 {新成员名称} 加入群聊` | `invite_to_group` |
| 成员退出 | `[系统] {退群者名称} 退出了群聊` | `leave_group` |
| 成员被移出 | `[系统] {被移出者名称} 已被 {操作者名称} 移出群聊` | `remove_from_group` |
| 群解散 | `[系统] 群聊已被 {操作者名称} 解散` | `dissolve_group` |
| 成员终止 | `[系统] {终止成员名称} 已离线，自动退出群聊` | `agent_manager` 终止联动 |

系统消息特点：
- `from: "system"`，`kind: "group_system"`，不触发 LLM 回复（格式化层跳过，仅在 conv 中以纯文本注入提示上下文）
- 同时扇出到所有成员个人队列（触发插话，让成员感知到群成员变化）
- 群历史中显示为居中灰色系统消息样式

### 3.4 插话复用与群消息格式化

插话管道本身零改动，需要扩展的是**消息格式化**：

1. `runtime_llm.js` 的 `formatMessageForLlm()` 检测 `message.kind === 'group'` 时，改用群聊模板（调用独立纯函数模块 `group_message_formatter.js` 的 `formatGroupMessageForAgent`）：

```
【群聊 产品需求讨论群】
来自 产品经理（agent_abc）的消息：
方案我整理好了，详见工作区 report.md

如需回复，请使用 send_group_message(groupId='g_1f3a...', payload={text:'...'})
注意：你不需要对每条群消息都回复。请根据消息内容是否与你的职责和当前任务相关来决定是否回复。
```

2. `group_message_formatter.js` 是**纯函数模块**，无类、无依赖、无 DI 注册，直接 `import { formatGroupMessageForAgent, formatGroupSystemMessageForAgent } from '...'`；
3. `getSenderInfo` 已能解析发送者角色名（`fromRoleName` 冗余字段保证即使成员已删除也能显示历史消息来源）；

4. 群系统消息（`kind: 'group_system'`）格式化为简短提示行，不附带回复引导：
```
【群聊 产品需求讨论群 · 系统通知】
研发工程师-1 退出了群聊
```

**群消息合并**：`_checkAndApplyInterruptions` 的 `drainAll` 天然把同一轮到达的若干条群消息合并为一批追加，无需额外开发。

### 3.5 群消息风暴与循环抑制

群聊最大的新风险是"全员互相回复 → 无限插话循环"。设计如下防线：

| 机制 | 实现 |
|------|------|
| 批量合并 | `drainAll` 已合并同一轮多条消息为一批，减少 LLM 调用次数 |
| 上下文窗口 | 群消息在 conv 中仅保留最近 N 条（如 20 条）或最近时间窗（如 30 分钟）的完整内容，更早的折叠为摘要行（`[群聊 X] 更早的 15 条消息摘要...`），防止上下文膨胀 |
| 自愿回复 | 群聊模板明确告知"不需要对每条群消息都回复"，LLM 根据职责相关性自主决定是否接话 |
| 最大连续回复轮次 | `ComputeScheduler` 或群服务层记录"某成员对某群连续主动发言次数"，超过阈值（如 3 次）后该成员对后续群消息只追加摘要不触发完整 LLM 生成（可选配置，默认关闭） |
| 退群机制 | 成员可 `leave_group`，退出后不再收到扇出，天然止损 |

#### 3.5.1 群系统消息与插话的关系

群系统消息（成员变动通知）扇出到成员个人队列后同样会触发插话。但格式化层对 `kind: 'group_system'` 的消息**不附带回复引导**，仅作为上下文提示。LLM 看到成员变动通知后，可以选择：
- 不回复（多数场景）
- 如果变动影响协作（如关键成员退出），主动在群里 `send_group_message` 说明影响

### 3.6 权限与生命周期

- **建群**：任何活跃智能体（含 root、user 入口）都可建群；`create_group` 的 `memberIds` 限本组织或全部组织（默认允许全部活跃智能体，由 owner 把关）；群名必填；
- **成员校验**：被邀请的智能体必须存在且 `status !== 'deleted'`；已终止智能体自动移出所有群并通知群内其他成员；群内仅剩 0 个活跃成员（或 owner 已删）时自动归档；
- **user 特殊权限**：**user 不在任何群成员列表中**（`members` 数组不包含 `user`），但 user 可以向任何群发送消息、查看任何群聊历史。这是设计上的"上帝视角旁观者"——user 不参与群内插话（不接收扇出），但可以随时发言，智能体看到的群消息发送者是 `user` 时与普通成员消息无异；
- **删除联动（事件驱动，非直接调用）**：`GroupChatService` 在 `init()` 中通过 DI 获取的 `runtimeEvents` 监听 `agent_terminated` 事件（`this.runtimeEvents.onAgentTerminated((event) => this.onAgentTerminated(event.agentId))`），**不修改 `agent_manager.js`**，完全解耦；
- **root 特权**：root 可解散任意群、移除任意成员（作为组织管理者兜底）。
- **退群自由**：任何成员可随时 `leave_group`，无需 owner 同意。

### 3.7 持久化与恢复

- 群元数据：`data/runtime/state/groups.json`（与 org.json 同级），启动时加载；
- 群历史：`web/messages/groups/<groupId>.jsonl`，与个人消息存储风格一致；
- 重启恢复：群元数据与历史完整恢复；扇出的个人队列不持久化（与现有行为一致，重启后不再触发处理），成员可通过 `get_group_info` 拉取群历史补读（可选：入群时注入最近摘要）。

#### 3.7.1 群历史存储格式（含系统消息）

```jsonl
// web/messages/groups/g_1f3a....jsonl 每行一条
{"id":"gm_001","kind":"group_system","groupId":"g_1f3a","from":"system","payload":{"text":"产品经理-1 创建了本群"},"createdAt":"2026-08-23 17:00:00"}
{"id":"gm_002","kind":"group","groupId":"g_1f3a","from":"agent_abc","fromRoleName":"产品经理","fromName":"产品经理-1","payload":{"text":"需求文档已放工作区"},"createdAt":"2026-08-23 17:01:00"}
{"id":"gm_003","kind":"group_system","groupId":"g_1f3a","from":"system","payload":{"text":"产品经理-1 邀请 测试工程师-1 加入群聊"},"createdAt":"2026-08-23 17:05:00"}
{"id":"gm_004","kind":"group","groupId":"g_1f3a","from":"agent_xyz","fromRoleName":"测试工程师","fromName":"测试工程师-1","payload":{"text":"收到，我下午出测试计划"},"createdAt":"2026-08-23 17:06:00"}
```

---

## 4. UI 设计

### 4.1 侧边栏（GlobalSidebar.vue）— 标签页设计

**放置位置**：`GlobalSidebar`（左侧边栏），**不是** `AgentList`（`WorkspaceTabs` 中 Splitter 的中间面板）。因为群成员可能来自不同组织（跨组织群聊），群不属于单一组织，应放在全局侧边栏中。

```
┌──────────────────────┬──────────────────────────────────┐
│ GlobalSidebar        │  WorkspaceTabs                    │
│                      │  ┌────────┬────────────────────┐ │
│ 🏠 首页              │  │AgentList│  ChatArea          │ │
│ ─────────────────    │  │(25%)   │  (75%)             │ │
│ ┌──────┬──────┐     │  │        │                    │ │
│ │ 智能体 │  群   │     │  │        │                    │ │
│ └──────┴──────┘     │  │        │                    │ │
│ ─────────────────    │  │        │                    │ │
│                      │  │        │                    │ │
│ 【智能体 页】         │  │        │                    │ │
│ 🏢 组织 1            │  │        │                    │ │
│ 🏢 组织 2            │  │        │                    │ │
│ 🏢 组织 3            │  │        │                    │ │
│                      │  │        │                    │ │
│ 【群 页】            │  │        │                    │ │
│ 📌 产品需求讨论群     │  │        │                    │ │
│       (5)           │  │        │                    │ │
│ 📌 软件研发作战群     │  │        │                    │ │
│       (3)           │  │        │                    │ │
│ 📌 内容审核三人组     │  │        │                    │ │
│       (3)           │  │        │                    │ │
│                      │  │        │                    │ │
│ [+ 新建群聊]         │  │        │                    │ │
└──────────────────────┴──────────────────────────────────┘
```

**设计要点**：

- 标签页放在 `GlobalSidebar.vue` 中，首页按钮下方，两个 Tab：`智能体` / `群`；
- **`智能体` 页**：保持现有 `GlobalSidebar` 内容完全不变（组织列表、拖拽排序、首页入口）；
- **`群` 页**：仅展示**群名**和**(人数)**（如"产品需求讨论群 (5)"），不显示最后消息预览、未读角标等（保持简洁，与智能体列表风格一致）；
- 群列表排序：按创建时间倒序；
- **点击群**：切换到群聊视图（`activeSession = { type: 'group', id: groupId }`），主区域 `ChatArea` 显示群聊对话；
- 群列表数据来源：`groupChatService` 提供的 API `/api/groups`，心跳 `group_event` 驱动增量刷新；
- **新建群聊**：底部"+"按钮，弹出建群对话框（群名必填、描述选填、成员多选，跨组织可选）；
- 智能体建群无需前端入口（工具调用自动创建，前端通过 `group_event` 心跳刷新群列表并 Toast 提示）；
- `AgentList`（中间面板）**完全不改动**。

### 4.2 群聊视图详细结构

**会话模型扩展**（`stores/chat.ts`）：

```ts
interface ChatSession {
  type: 'direct' | 'group';
  id: string;  // agentId 或 groupId
}

// 群聊消息独立存储，不混入个人消息
groupMessages: Record<groupId, GroupMessage[]>
groupMeta: Record<groupId, GroupMeta>
activeSession: ChatSession | null  // 当前查看的会话
```

用户点击侧边栏智能体条目 → `activeSession = { type: 'direct', id: agentId }`（保持现有个人会话逻辑）；点击群条目 → `activeSession = { type: 'group', id: groupId }`，主区域切换为群聊视图。

**群聊视图布局**：

```
┌──────────────────────────────────────────────┐
│ ← 群名                   成员(5)  ⋮ 更多        │
│   [头像1][头像2][头像3] +2                     │
├──────────────────────────────────────────────┤
│  📌 智能体 A 创建了本群                         │  ← 系统消息（居中灰字）
│                                              │
│  [A头像] 产品经理                               │
│  方案我整理好了，详见工作区 report.md             │
│           10:32                                │
│                                              │
│  [B头像] 研发工程师                             │
│  收到，我评估一下技术可行性，15:00 前答复          │
│           10:33                                │
│  ── 新消息插话 ──                             │  ← 插话提示分隔线
│  [B头像] 研发工程师                             │
│  技术可行，建议用事件驱动方案                     │
│           10:35                                │
│                                              │
│  📌 测试工程师-1 退出了群聊                      │  ← 成员变动系统消息
├──────────────────────────────────────────────┤
│ [输入框：发消息到群...]  [发送]                  │
└──────────────────────────────────────────────┘
```

- 消息气泡带发送者昵称 + 角色名 + 头像色块（按 `agentId` 哈希取色，保证同一成员颜色稳定）；
- 群消息不显示 `to`（区别于个人消息）；
- 系统消息样式：建群 / 拉人 / 移出 / 退群 / 解散 / 成员终止；
- 输入框允许人类用户直接发群消息（`from='user'`），显示"你"。

### 4.2.1 群聊视图中的系统消息渲染

成员变动通知在群聊视图中以居中灰色气泡显示：
```
           ── 产品经理-1 创建了本群 ──

           ── 产品经理-1 邀请 测试工程师-1 加入群聊 ──

           ── 研发工程师-1 退出了群聊 ──
```

- 系统消息不显示头像、不显示时间戳（以时间分隔线代替）
- 与普通消息的渲染逻辑区分：`ChatMessageList.vue` 检测 `message.kind === 'group_system'` 走系统消息样式分支

### 4.3 群详情 / 成员管理面板

点击群聊头部"成员(5)"或"⋮"打开右侧抽屉：

```
┌──────────────────────────┐
│ 群信息                    │
│  群名：产品需求讨论群       │
│  描述：v2.0 需求评审       │
│  创建者：产品经理-1（agent_abc） │
│  创建时间：2026-08-23 17:00     │
│                          │
│ 成员（5）            + 邀请 │
│  [色块] 产品经理  忙碌      │
│  [色块] 研发工程师 空闲     │
│  [色块] UI 设计师  处理中   │
│  [色块] 测试工程师 空闲     │
│  [色块] 前端工程师 离线     │
│                          │
│  [解散群聊]（owner/root）  │
└──────────────────────────┘
```

- 成员状态复用 `agentStore` 的计算状态（idle / processing / waiting_llm），方便人类用户判断"谁有空"；
- 邀请弹窗：组织树多选（复用岗位树组件，勾选智能体节点）；**user 不可被选为群成员**；
- 注意：user 不在成员列表中，但 user 在前端看到的所有群聊视图的输入框都是可用的（可以直接发消息）。

### 4.4 新建群聊对话框（人类用户）

- 群名（必填）、描述（选填）、成员多选（按组织树分组，含搜索，**不可选 user**）；
- 提交后调 `POST /api/groups` → 服务端建群 + 通知成员 + 心跳广播 `group_event`；
- 建群后 user 自动进入该群的群聊视图（但不在成员列表中）。

### 4.5 实时性与未读

- 心跳新增事件类型：
  - `group_message`：群消息增量（`{ groupId, messages: [...] }`），前端追加到 `groupMessages[groupId]` 并更新侧边栏预览；**群系统消息（成员变动）也通过此事件推送**，前端按 `kind` 区分渲染；
  - `group_event`：建群 / 成员变动 / 解散（`{ groupId, type, actorId, memberIds? }`），前端刷新 `groupMeta` 与群列表（如人数变化、新增群、删除群）；
- 未读角标：每群记录 `lastReadMessageId`（本地存储），`group_message` 到达且非当前会话时计数；**群页标签上也显示总未读数**；
- 插话可视化：成员因群消息被打断时，前端群聊视图显示"── 新消息插话 ──"分隔线（复用现有消息流的时间分隔样式）。

### 4.6 组织架构中群聊的可见性

群聊在组织架构 API 中通过 `get_org_structure` 的 `groups` 摘要字段返回，但前端侧边栏的"智能体"标签页（组织树）不展示群聊——群聊仅在"群"标签页中展示。

`get_org_structure` 返回的 `groups` 摘要字段仅供智能体感知组织中的群聊生态（知道有哪些群、谁建的、多少人、自己是否在群内），前端无需在组织树中渲染群聊节点。

### 4.7 移动端（`web/mobile`）群聊设计

**设计原则**：精简至必要功能，复用现有移动端页面切换模型（`currentPage`），不新增底部导航 Tab。

#### 4.7.1 入口：`OrgListView` 顶部加分段控件

移动端 `OrgListView` 展示所有组织（全局视图，非单组织），顶部新增分段控件，两段切换：

**设计理由**：移动端 `OrgListView` 本身就展示所有组织（不是 PC 端 `AgentList` 那种单组织面板），因此把群放在这里的分段控件中，与 PC 端 `GlobalSidebar` 的标签页语义一致——群和组织的列表都是全局可见的，不受具体组织上下文限制。

```
┌────────────────────────┐
│  MobileNavBar           │
├────────────────────────┤
│  ┌─────────┬─────────┐ │
│  │  智能体  │   群    │  │  ← 分段控件（Segment）
│  └─────────┴─────────┘ │
├────────────────────────┤
│  【智能体 段】            │  ← 保持现有内容完全不变
│  🏢 组织 1               │     组织列表（平铺）
│  🏢 组织 2               │     → 点击组织进入智能体列表
│  ...                     │
│                          │
│  【群 段】                │  ← 新增
│  ┌────────────────────┐ │
│  │ 📌 产品需求讨论群    │ │     群名 + (人数)
│  │    (5)              │ │
│  ├────────────────────┤ │
│  │ 📌 软件研发作战群    │ │
│  │    (3)              │ │
│  ├────────────────────┤ │
│  │ 📌 内容审核三人组    │ │
│  │    (3)              │ │
│  └────────────────────┘ │
│                          │
│     [+ 新建群聊]          │
├────────────────────────┤
│  组织  │  对话  │  设置  │  ← BottomNav 不变
└────────────────────────┘
```

**要点**：
- 分段控件仅在 `appStore.currentPage === 'orgs'` 时显示，属于 `OrgListView` 内部组件；
- `智能体` 段：保持现有组织列表完全不变；
- `群` 段：列表项仅显示**群名**和**(人数)**，点击进入群聊视图；
- 底部"+ 新建群聊"：群名必填 + 成员多选，与 PC 版共用同一 API；
- `BottomNav` 三个 Tab（组织/对话/设置）**完全不变**，不新增 Tab。

#### 4.7.2 群聊视图：`GroupChatView`

新增 `web/mobile/src/components/chat/GroupChatView.vue`，复用 `MessageList`、`MessageBubble`、`MessageInput` 组件：

```
┌────────────────────────┐
│  ← 产品需求讨论群 (5)    │  ← 顶部栏：返回键 + 群名 + 人数
├────────────────────────┤
│                        │
│  ── 系统消息 ──         │
│  Root 创建了本群         │  ← 灰色居中，比普通消息小
│                        │
│  [头像] 产品经理        │
│  ████████████████████  │  ← 消息气泡（复用 MessageBubble）
│  █ 方案整理好了 ██████  │
│                        │
│  [头像] 研发工程师       │
│  ████████████████████  │
│  █ 收到，今天开始 █████  │
│                        │
│  ── 系统消息 ──         │
│  测试工程师 加入了群聊    │
│                        │
├────────────────────────┤
│  [输入框]          [发送]│  ← 复用 MessageInput
└────────────────────────┘
```

**要点**：
- 通过 `appStore.currentPage = 'groupChat'` + `appStore.currentGroupId` 进入；
- 顶部栏：← 返回键（回到群列表）+ 群名 + 人数 + 点击人数进入成员列表；
- 消息流：复用 `MessageList` + `MessageBubble`，群系统消息（`kind='group_system'`）灰色居中渲染；
- 输入框：复用 `MessageInput`，从 `stores/chat.ts` 的 `groupMessages` 读取消息；
- 发送：调 `POST /api/groups/:id/send`（`from='user'`）；
- 数据：心跳 `group_message` + `group_event` 驱动增量刷新，与 PC 版共用同一套心跳事件。

#### 4.7.3 群成员列表（轻量弹窗）

点击顶部栏人数 → 底部弹出半屏面板（Sheet），仅显示成员列表：

```
┌────────────────────────┐
│  群成员 (5)    [关闭]   │
├────────────────────────┤
│  [色块] 产品经理  忙碌   │
│  [色块] 研发工程师 空闲   │
│  [色块] UI 设计师  空闲   │
│  [色块] 测试工程师 处理中 │
│  [色块] 前端工程师 空闲   │
└────────────────────────┘
```

**不提供**：成员管理（邀请/踢人/解散）——这些操作在移动端属于低频管理行为，用户可到 PC 端操作。移动端只读。

#### 4.7.4 移动端改动清单

**新增**：
- `web/mobile/src/components/chat/GroupChatView.vue` — 群聊视图（复用 `MessageList`/`MessageBubble`/`MessageInput`）
- `web/mobile/src/components/chat/GroupsList.vue` — 群列表组件（群名+人数，供 `OrgListView` 群段使用）

**修改**：
- `web/mobile/src/components/orgs/OrgListView.vue` — 顶部加分段控件（智能体/群），群段嵌入 `GroupsList`
- `web/mobile/src/stores/app.ts` — `currentPage` 新增 `'groupChat'`；新增 `currentGroupId`；新增 `navigateToGroup(groupId)` / `navigateBackFromGroup()`
- `web/mobile/src/stores/chat.ts` — 新增 `groupMessages: Record<groupId, Message[]>` / `groupMeta: Record<groupId, GroupMeta>`
- `web/mobile/src/App.vue` — 新增 `groupChat` 页面分支（`v-else-if="showGroupChat"`），引入 `GroupChatView`；注册 `group_message` / `group_event` 心跳 handler
- `web/mobile/src/services/api.ts` — 新增 `getGroupMessages` / `sendGroupMessage` / `getGroups` API

**不修改**：
- `BottomNav.vue` — 保持 3 个 Tab 不变
- `MobileNavBar.vue` — 保持现有顶部栏逻辑不变

---

## 5. 交互设计

### 5.1 智能体自主拉群（主场景）

```
用户：请组织一个团队开发一个旅游推荐网站
  ↓
Root 拆解任务 → 创建 产品/前端/后端/测试 岗位
  ↓
Root 发现需要持续协作 → 调用 create_group('旅游网站开发群', [...4个成员])
  ↓ 前端：侧边栏出现新群 + Toast「Root 创建了群聊 旅游网站开发群」
  ↓ 群内系统消息：Root 创建了本群
  ↓ 各成员收到入群通知（插话式）
Root → send_group_message(群, '需求文档已放工作区，请各自认领模块')
  ↓
产品经理插话回复 → 前端实时显示
前端工程师插话回复 → 后端工程师插话回复
  ↓ 群内持续讨论，成员间网状插话
测试工程师：'我 16:00 前出测试计划' → 其他人插话确认
  ↓ 测试工程师认为某条消息与自己无关 → 不回复（自愿回复机制）
```

### 5.2 插话式参与（复用机制）

- 成员忙碌时（正在生成回复 / 执行工具）收到群消息 → `_checkAndApplyInterruptions` 打断当前回合 → 新上下文重新生成；
- 群消息与个人消息同优先级（统一管道），LLM 自主判断是否回复及回复什么；
- 前端无需特殊处理，消息流自然呈现"打断 → 插入群消息 → 回复"。
- **自愿回复**：群消息格式化模板明确告知"不需要对每条群消息都回复"，LLM 根据消息内容与自身职责相关性决定。例如测试工程师收到产品需求讨论的消息，如果内容不涉及测试，可以选择不回复。

#### 5.2.1 成员变动通知的交互

```
场景：产品经理邀请测试工程师进群
  ↓
GroupChatService.invite_to_group()
  ├─ 群历史写入系统消息：「产品经理-1 邀请 测试工程师-1 加入群聊」
  ├─ 扇出到所有成员（含新成员）个人队列，kind='group_system'
  ├─ 心跳广播 group_event → 前端刷新群成员列表
  └─ 成员插话感知到变动：
       - 其他成员：看到通知，不回复（多数场景）
       - 新成员：看到通知 + 之前的群消息上下文，可选择打招呼
       - 如果关键成员退出：其他成员可能主动在群里说明影响
```

### 5.3 人类用户参与

- user **不在任何群成员列表中**（`members` 数组不包含 `user`），但 user 可向任何群发消息、查看任何群聊历史；
- 用户在前端点击群聊即可进入群聊视图，无需是群成员——所有群对所有用户可见；
- 用户在群里的发言以 `from='user'` 进入群历史，格式化层显示"【群聊 X】来自 用户 的消息"；智能体对 user 消息的处理与普通成员消息一致；
- 发送流程：前端 `POST /api/groups/:id/send`（`from='user'`）→ `GroupRoutes`（DI 注册的 HTTP 路由）通过 `deps.groupChatService.sendGroupMessage()` 写入群历史 → 扇出到所有成员个人队列 → 成员插话处理；
- 用户可随时在群详情面板修改群名、踢人/加人（root 权限，且 user 无需在成员列表中即可操作），也可解散群（root 权限），干预智能体自治。

### 5.4 通知与防打扰

- 智能体可 `leave_group` 主动退出（停止接收该群消息）；
- 人类用户可"静音群聊"（前端本地：不再弹 Toast、不置顶，仅保留角标）；
- 智能体侧不引入"免打扰"开关（v1 保持插话语义纯粹），风暴抑制交给 3.5 节的机制。
- 智能体收到群系统消息（成员变动）时，格式化层不附带回复引导，减少不必要的 LLM 调用。

---

## 6. 实施路径

### Phase 1 — MVP（跑通闭环）

1. `group_registry.js` + `group_message_store.js`（元数据 / 历史持久化，纯数据层，无 DI 注册）；
2. `group_chat_service.js`：建群、扇出、`send_group_message`、成员变动通知；**文件末尾 `registry.declare()` 自注册**，`requires: ["bus", "heartbeatBroker", "org", "runtimeEvents", "agentManager", "logRoot", "dataDir", "runtimeDir"]`，`provides: ["groupChatService"]`；
3. `group_message_formatter.js`：纯函数模块（`formatGroupMessageForAgent` + `formatGroupSystemMessageForAgent`），无 DI 注册；
4. `tools_group.js`：工具 schema + 实现（`create_group` / `send_group_message` / `list_my_groups` / `get_group_info`）；**文件末尾 `registry.declare()` 自注册**，`requires: ["groupChatService", "org", "bus"]`，`provides: ["groupTools"]`；在 `tool_executor.js` 中以副作用 `import` 触发注册；
5. `runtime_llm.js` 的 `formatMessageForLlm` 分支：`kind === 'group'` 时调用 `group_message_formatter`；
6. `get_org_structure` 扩展：`tools_agent.js` 的 `_executeGetOrgStructure` 通过 `registry.getService('groupChatService')` 获取群摘要数据，返回 `groups` 字段；
7. `group_routes.js`：群历史存储 + `/api/groups`、`/api/groups/:id/messages`、`/api/groups/:id/send` 路由 + 心跳 `group_message` / `group_event`；**文件末尾 `registry.declare()` 自注册**，`requires: ["app", "groupChatService", "log", "runtimeDir"]`，`provides: []`；在 `http_server/index.js` 以副作用 `import` 触发注册；
8. 在 `bootstrap_manager.js` 中确保 `bus`、`heartbeatBroker`、`org`、`runtimeEvents`、`agentManager` 等基础服务已通过 `registry.provide()` 注入（大部分已存在）；
9. 前端（PC）：`GlobalSidebar.vue` 标签页（智能体/群）+ 群列表（群名(人数)）+ `ChatArea` 群聊会话视图（群消息 + 系统消息渲染）+ chatStore 扩展（`activeSession` / `groupMessages` / `groupMeta`）；`AgentList` 不修改。
10. 前端（移动端）：`OrgListView` 分段控件 + `GroupsList`（群名+人数）+ `GroupChatView`（复用 `MessageList`/`MessageBubble`/`MessageInput`）+ `currentPage='groupChat'` 导航 + 心跳 `group_message`/`group_event` handler；`BottomNav` 不修改。

### Phase 2 — 群管理完整化

10. 工具补齐：`invite_to_group` / `remove_from_group` / `leave_group` / `dissolve_group`（在 `tools_group.js` 中追加）；
11. 群详情面板 + 成员管理 + 新建群聊对话框；
12. 未读角标 + 群消息搜索（复用 `/search` 模式）；
13. 智能体终止联动退群（通过 `runtimeEvents` 事件监听，已在 Phase 1 的 `init()` 中注册监听器，此阶段完善通知逻辑）+ 群自动归档 + 成员变动系统消息。

### Phase 3 — 治理与增强

12. 群消息风暴抑制（上下文窗口折叠、连续发言阈值）；
13. 群摘要（历史过长时由 owner 或 LLM 生成群周报式摘要，注入新成员）；
14. 权限细化（跨组织建群策略、成员上限）、群标签 / 置顶；
15. 群聊与工作区联动（群公告写工作区文档，成员变动更新团队共识记忆）；
16. 组织架构树前端展示群聊节点（可选展开）。

---

## 7. 涉及文件清单

### 服务端（新增）
- `src/platform/services/group_chat/group_chat_service.js` — 群聊服务（`registry.declare()` 自注册，`provides: ["groupChatService"]`）
- `src/platform/services/group_chat/group_registry.js` — 群元数据存储（纯数据层）
- `src/platform/services/group_chat/group_message_store.js` — 群历史存储（纯数据层）
- `src/platform/services/group_chat/group_routes.js` — HTTP 路由（`registry.declare()` 自注册，`requires: ["app", "groupChatService", "log", "runtimeDir"]`）
- `src/platform/runtime/tools_group.js` — 群聊工具实现（`registry.declare()` 自注册，`requires: ["groupChatService", "org", "bus"]`，`provides: ["groupTools"]`）
- `src/platform/utils/message/group_message_formatter.js` — 群消息格式化器（纯函数模块，无 DI 注册）

### 服务端（修改）
- `src/platform/runtime/bootstrap_manager.js` — 确保基础服务已 `registry.provide()`（大部分已存在）；**不新增 runtime 属性**
- `src/platform/services/http/http_server/index.js` — 副作用 `import "./group_routes.js"` 触发路由注册（与现有 `import "./mood_routes.js"` 模式一致）
- `src/platform/runtime/tool_executor.js` — 副作用 `import "./tools_group.js"` 触发工具注册 + switch 分发群聊工具
- `src/platform/runtime/tools_agent.js` — `_executeGetOrgStructure` 通过 `registry.getService('groupChatService')` 获取群摘要
- `src/platform/extensions/tool_group_manager.js` — 注册 `group_chat` 工具组
- `src/platform/runtime/runtime_llm.js` — `formatMessageForLlm` 增加 `kind === 'group'` 分支，调用 `group_message_formatter`
- `config/prompts/` — 系统提示词群聊能力引导

### 前端 — PC（修改 / 新增）
- `web/v3/src/services/api.ts` — 群聊 API（含 `get_group_info` 对应的前端调用）
- `web/v3/src/services/heartbeatService.ts` — `group_message` / `group_event` 处理
- `web/v3/src/stores/chat.ts` — 会话模型扩展（`activeSession` / `groupMessages` / `groupMeta`）
- `web/v3/src/types/` — 群聊类型定义（GroupMeta / GroupMessage / GroupSummary）
- `web/v3/src/components/chat/GroupChatArea.vue`（新）
- `web/v3/src/components/chat/GroupMemberPanel.vue`（新）
- `web/v3/src/components/chat/CreateGroupDialog.vue`（新）
- `web/v3/src/components/chat/ChatMessageList.vue` — 群消息 + 群系统消息渲染分支
- `web/v3/src/components/layout/GlobalSidebar.vue` — 标签页（智能体/群）+ 群列表

### 前端 — 移动端（修改 / 新增）
- `web/mobile/src/components/chat/GroupsList.vue`（新）— 群列表（群名+人数）
- `web/mobile/src/components/chat/GroupChatView.vue`（新）— 群聊视图（复用 MessageList/MessageBubble/MessageInput）
- `web/mobile/src/components/orgs/OrgListView.vue` — 顶部加分段控件（智能体/群）
- `web/mobile/src/stores/app.ts` — `currentPage: 'groupChat'` + `currentGroupId`
- `web/mobile/src/stores/chat.ts` — `groupMessages` + `groupMeta`
- `web/mobile/src/App.vue` — 群聊页面分支 + 注册 `group_message`/`group_event` 心跳 handler
- `web/mobile/src/services/api.ts` — 群聊 API

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| 群消息风暴 → LLM 调用激增 | 成本与延迟 | drainAll 批量合并 + 上下文窗口折叠 + 连续发言阈值（Phase 3） |
| 无限互回复循环 | 死循环消耗 | 自愿回复软引导 + 阈值抑制 + 退群止损 |
| 上下文膨胀（群聊历史长） | 超出 context 限制 | 窗口化 + 摘要折叠，`get_group_info` 按需拉取 |
| 扇出成本（N 份消息） | 存储与队列膨胀 | 群历史单一存储（不复制到个人 JSONL），扇出仅内存队列 |
| 已终止智能体残留群内 | 僵尸成员 | 删除联动清理 + 空群自动归档 + 群内系统通知 |
| 群消息误入个人历史 | 个人会话流被污染 | `storeMessage` 按 `kind==='group'` 分流，群历史独立存储 |
| 用户不在成员列表中但发消息 | 成员列表不完整，但用户仍需发送 | 前端直接调 `POST /api/groups/:id/send`（`from='user'`），服务端跳过成员校验仅校验群存在，user 消息扇出到所有成员 |
| 插话被打断后上下文混乱 | 回复质量下降 | 复用现有 epoch 机制，群消息以 `【群聊 X】` 头清晰区分来源 |
| `get_org_structure` 返回膨胀 | 上下文窗口被群信息挤占 | 群摘要仅 5 字段，详情走 `get_group_info` 按需查询 |
| 成员变动通知过多 | 群消息流被系统消息淹没 | 系统消息不触发回复引导，密集变动时可合并为一条摘要通知 |
| 群系统消息触发不必要的 LLM 调用 | 成本浪费 | `kind='group_system'` 格式化为简短提示，无回复引导，LLM 多数情况不回复 |
| `runtime` 耦合回归 | 架构腐化 | `GroupChatService` 构造函数仅接收 `deps`，禁止 `this.runtime.xxx`；代码审查 + lint 规则可选 |

---

## 9. 测试要点

- 单元：扇出逻辑（成员增减后扇出集合变化）、权限校验、群历史读写、格式化模板（群消息 + 系统消息）、`get_org_structure` 群摘要返回格式；
- **DI 集成**：`registry.declare()` 声明后 `registry.getService('groupChatService')` 可正确获取实例；依赖未就绪时模块停留在 `declared` 状态不崩溃；`registry.ensureReady()` 无死依赖/循环依赖报错；
- 集成：建群 → 双成员互发 → 验证双方队列均收到且 `groupId` 正确；
- 插话：成员忙碌时发群消息 → 验证 `drainAll` 合并、epoch 递增、重新生成；
- 成员变动：邀请 / 退出 / 移出 → 验证群内系统消息写入 + 扇出通知 + 心跳 `group_event`；
- **事件联动**：模拟 `runtimeEvents` 发出 `agent_terminated` → 验证 `GroupChatService` 自动清理成员身份 + 群内系统消息（**不依赖 `agent_manager.js` 直接调用**）；
- 持久化：重启后群元数据 / 历史恢复（含系统消息），成员补读；
- 生命周期：删除成员 → 自动退群 → 群事件广播 + 系统消息；
- 权限：非成员调 `get_group_info` 返回错误；非 owner 调 `invite_to_group` 返回错误；
- 前端：心跳增量渲染、未读角标、群聊视图消息排序、系统消息样式、`activeSession` 切换。

---

*本文档 Phase 1 后端 + Phase 2 前端 PC + Phase 3 移动端已全部实施完成。*
