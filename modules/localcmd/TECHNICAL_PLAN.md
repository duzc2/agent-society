# localcmd 命令审核 — 技术实施方案

## 前置功能：统一心跳通信框架

### 动机

当前 `uiCommandService` 使用独立的长轮询向服务端拉取命令。随着模块增加，各自轮询将产生大量重复连接。需要一个统一的机制，让服务端能主动向客户端推送消息。

### 设计原则

心跳机制只做一件事：**服务端通过心跳响应向客户端推送消息**。心跳请求本身不是模块可利用的通信信道，只携带已收到的消息序号。消息是否需要回复、如何回复，由各模块自行通过各自的 HTTP 端点处理，与心跳无关。

**无 clientId，无客户端状态**：服务端不记录任何客户端信息。心跳请求只带 `lastMessageId`，服务端据此返回新消息。所有客户端（多标签页、v3、mobile）被完全统一对待，每个客户端独立维护自己的 `lastMessageId`。

**全局递增消息 ID**：HeartbeatBroker 内部维护 `_nextId` 计数器（从 1 开始），每条消息分配单调递增的整数 ID。客户端记录已收到的最大 `messageId`，下次心跳携带 `lastMessageId`，服务端只返回 `messageId > lastMessageId` 的消息——服务端天然过滤重复，无需客户端去重。

**消息 TTL**：`broadcast(type, payload, ttl?)` 支持可选 TTL（秒）。不设 TTL 的消息持久存在，直到 `clearMessage()` 显式清除（如 cmd_confirm 需等待用户决策）。设 TTL 的一次性消息超时后自动从 `drain()` 结果中排除（如 ui_command 不需要重连后补发）。

**重连恢复**：手机杀进程重开 → `lastMessageId = 0` → drain 返回所有未过期消息（cmd_confirm 无 TTL，仍在） → 弹窗恢复。

```
客户端                              服务端
  │                                   │
  │── POST /api/heartbeat ──────────▶│  每 3s 一次
  │   { lastMessageId: 5 }           │  只携带已收到的最大消息ID
  │                                   │  初始 lastMessageId = 0
  │◀─ 200                            │
  │   {                               │
  │     messages: [                   │  仅 messageId > lastMessageId
  │       { messageId: 7, ... }       │  且未过期
  │     ]                             │
  │   }                               │
  │                                   │
  │ 客户端更新 lastMessageId =         │
  │ messages.length > 0 ?             │
  │ messages[last].messageId :        │
  │ lastMessageId                     │
  │                                   │
  │   [消息按 type 分发给处理器]        │
  │                                   │
  │   [若需回复，走业务模块的独立端点]    │
```

### 1. 服务端：HeartbeatBroker

新建 `src/platform/services/heartbeat/heartbeat_broker.js`。

```js
class HeartbeatBroker {
  constructor()

  // 消息发布
  broadcast(type, payload, ttlMs?)     // → messageId。消息存入 _messages，可选 TTL

  // 消息消费
  drain(lastMessageId)                 // → message[]。返回 messageId > lastMessageId 且未过期的消息

  // 生命周期
  clearMessage(messageId)              // 显式清除消息（如 cmd_confirm 已解决）
}
```

**无客户端管理**：不记录客户端，不生成 clientId，不维护活跃列表。所有客户端平等对待。

**内部数据结构**：
- `_nextId: number` — 全局递增计数器（从 1 开始）
- `_messages: Map<messageId, { messageId, type, payload, createdAt, expiresAt? }>` — 所有消息

**`broadcast(type, payload, ttlMs?)`**：
1. `_nextId++` 分配 messageId
2. 构建消息对象，`expiresAt = ttlMs ? Date.now() + ttlMs : null`
3. 存入 `_messages`
4. 返回 messageId

**`drain(lastMessageId)`**：
1. 遍历 `_messages`
2. 过滤出 `messageId > lastMessageId` 且未过期的消息
3. 不删除消息（等待 `clearMessage` 或自动过期）
4. 返回过滤后的消息数组

**`clearMessage(messageId)`**：从 `_messages` 中删除，停止向任何客户端投递。

**消息格式**（由 HeartbeatBroker 内部生成，messageId 为递增整数）：
```json
{
  "messageId": 5,
  "type": "cmd_confirm",
  "payload": { ... }
}
```

**关键点**：
- 无客户端状态，`drain(lastMessageId)` 是纯数据查询
- 无 TTL 的消息持久存在，直到 `clearMessage()`（如 cmd_confirm）
- 有 TTL 的消息自动过期（如 ui_command 设 60s TTL，重连后不复现）
- 新客户端（`lastMessageId = 0`）自然拿到所有未过期消息
- 在 `bootstrap_manager.js` 中初始化，挂到 `runtime.heartbeatBroker`
- `send()` 已删除——所有消息统一走 `broadcast()`

---

### 2. HTTP 端点与详细流程

新建 `src/platform/services/http/http_server/heartbeat.js`。

心跳只有一个端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/heartbeat` | 心跳。详见下方各流程 |

---

#### 2.1 首次心跳

客户端首次加载页面，`lastMessageId` 初始为 0。

```
客户端                                       服务端
  │                                           │
  │── POST /api/heartbeat ──────────────────▶│
  │   { lastMessageId: 0 }                   │  首次：lastMessageId = 0
  │                                           │  broker.drain(0)
  │                                           │  返回所有未过期消息
  │◀── 200 ──────────────────────────────────│
  │   {                                       │
  │     messages: [                           │
  │       { messageId: 3, type: "cmd_confirm",│
  │         payload: {...} },                  │
  │       { messageId: 5, type: "cmd_confirm",│
  │         payload: {...} }                   │
  │     ]                                     │
  │   }                                       │
  │                                           │
  │ 客户端 lastMessageId = 5                  │
```

**服务端逻辑**：
1. `const messages = broker.drain(lastMessageId ?? 0)` — 未传则视为 0
2. 返回 `{ messages }`（messageId 升序排列）

**手机重开**：新页面加载，`lastMessageId = 0`，服务端返回所有未过期消息（cmd_confirm 无 TTL，ui_command 有 TTL 已过期），弹窗恢复。

---

#### 2.2 正常心跳

```
客户端                                       服务端
  │                                           │
  │── POST /api/heartbeat ──────────────────▶│  每 3s 一次
  │   { lastMessageId: 5 }                   │
  │                                           │  broker.drain(5)
  │                                           │  只返回 messageId > 5 且未过期的
  │◀── 200 ──────────────────────────────────│
  │   { messages: [] }  或                    │
  │   { messages: [{messageId: 7, ...}] }    │
  │                                           │
  │ 更新 lastMessageId = 7 （若有消息）        │
  │   [按 type 分发消息]                       │
```

**服务端逻辑**：
1. `const messages = broker.drain(lastMessageId)`
2. 返回 `{ messages }`
3. 无消息时返回 `{ messages: [] }`

---

#### 2.3 异常处理

**`lastMessageId` 缺失/空**：视为 0，等同首次心跳。不返回 400，心跳是后台自动化请求。

**请求体为空 `{}`**：等同于 `{ lastMessageId: 0 }`。

---

### 3. 前端：HeartbeatService

**两个前端工程都需要各自的 `HeartbeatService` 实现**：

| 工程 | 文件 | UI 框架 | 确认弹窗形式 |
|---|---|---|---|
| `web/v3` | `web/v3/src/services/heartbeatService.ts` | 自定义组件 | 居中对话框（CmdConfirmDialog.vue） |
| `web/mobile` | `web/mobile/src/services/heartbeatService.ts` | PrimeVue | 已有 ConfirmSheet 模式，复用或封装 |

两个实现共享相同的协议（请求格式、消息格式、分发逻辑），仅 UI 层不同。

```ts
class HeartbeatService {
  start()                       // 启动心跳循环
  stop()                        // 停止心跳
  onMessage(type, handler)      // 注册消息处理器。handler 接收 { messageId, payload }
}
```

**内部状态**：
- `lastMessageId: number` — 已收到的最新消息 ID（初始 0）

**心跳循环**：
- POST `/api/heartbeat`，请求体 `{ lastMessageId }`
- 响应中 `messages` 非空时，更新 `lastMessageId = messages[messages.length-1].messageId`（messages 已按 ID 升序排列）
- `messages` 按 `type` 分发给注册的处理器
- 间隔 **3s**，无论上一次请求是否完成都发下一次

**消息去重**：无需客户端去重——`drain(lastMessageId)` 在服务端天然过滤了已发送的消息。

**后台运行**：浏览器后台标签页会节流 `setInterval`（可能降到 1 分钟以上），但不影响功能——切回来后漏掉的消息通过 `lastMessageId` 补齐。

### 4. 迁移现有 uiCommandService

- `uiCommandService` 不再自己轮询，改为向 `heartbeatService.onMessage('ui_command', handler)` 注册
- `ui_command_broker.js` 改为通过 `heartbeatBroker.broadcast('ui_command', payload, 60000)` 投递消息（60s TTL，一次性消息不需重连补发）
- `ui_command_broker` 的 `waitForResult` / `resolveResult` 保持不变（走自己已有的响应端点，不经过心跳）
- 所有标签页都会收到 ui_command，各自处理

### 5. 变更文件（心跳框架）

| 文件 | 变更类型 |
|---|---|
| `src/platform/services/heartbeat/heartbeat_broker.js` | 新建 |
| `src/platform/services/http/http_server/heartbeat.js` | 新建 |
| `src/platform/services/http/http_server/router.js` | 修改 |
| `src/platform/runtime/bootstrap_manager.js` | 修改 |
| `web/v3/src/services/heartbeatService.ts` | 新建 |
| `web/v3/src/services/uiCommandService.ts` | 修改 |
| `web/v3/src/App.vue` | 修改 |
| `src/platform/services/ui/ui_command_broker.js` | 修改 |

---

## localcmd 命令审核（基于心跳框架）

### 1. 策略数据归属

策略数据由 localcmd 模块管理，存储在 `data/runtime/state/localcmd_cmdpolicy.json`，按组织 ID 分键。

```json
{
  "orgs": {
    "<orgId>": { "whitelist": [...], "blacklist": [...] }
  },
  "defaults": { "whitelist": [], "blacklist": ["rm -rf", "sudo", "del /f", ...] }
}
```

若某组织无独立策略，使用 defaults。

### 2. PolicyStore

新建 `modules/localcmd/policy_store.js`。

```js
class PolicyStore {
  constructor(dataDir)
  async load()
  async save()
  get(orgId)
  getAll()
  async set(orgId, policy)
  async setDefaults(policy)
  async remove(orgId)
}
```

### 3. 策略引擎

新建 `modules/localcmd/policy_engine.js`，导出纯函数。

- `normalizeCommand(command, args)` — 去路径、去后缀、参数取 basename
- `checkPolicy(normalized, policy)` — 黑名单优先 → 白名单 → confirm
- 匹配方式：规范化后字符串的 `startsWith`（Windows 不区分大小写）

### 4. 确认钩子

`localcmd/index.js` 的 `executeToolCall()`，`localcmd_spawn` case 最前面。

localcmd 模块内部维护一个 `pendingConfirmations` Map：`{ messageId: { resolve, reject } }`。

```
1. PolicyStore.get(orgId) 获取策略
2. normalizeCommand → checkPolicy
3a. reject → return { error: "command_blocked_by_policy" }
3b. allow  → spawn
3c. confirm → const messageId = heartbeatBroker.broadcast('cmd_confirm', payload)
              → 将 { resolve, reject } 存入 pendingConfirmations[messageId]
              → await new Promise（等待 resolve/reject）
              → 允许则 spawn + 可能更新白名单；拒绝则 return error
              → 最后 heartbeatBroker.clearBroadcast(messageId)
```

### 5. 确认响应端点

localcmd 模块通过 `getHttpHandler()` 暴露确认响应端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/modules/localcmd/confirm-response` | 客户端提交确认结果。请求: `{ messageId, allowed, rememberChoice?, matchEntry? }` |

处理逻辑：
1. 根据 `messageId` 找到 `pendingConfirmations` 中的对应条目
2. 调用 `resolve(allowed)`
3. 如果 `rememberChoice` 为 true，将 `matchEntry` 加入对应组织的白名单或黑名单
4. 返回 `{ ok: true }`

**注意**：此端点走 localcmd 模块自己的 `getHttpHandler()`，完全独立于心跳框架。心跳只负责把确认消息推送到前端，前端收到后用普通的 HTTP POST 回复此端点。

### 6. 前端确认弹窗

`heartbeatService.onMessage('cmd_confirm', handler)`：
- 收到消息 → 解析 `{ messageId, payload }` → `cmdConfirmService.show(payload)` 弹出 CmdConfirmDialog
- 用户操作 → HTTP POST `/api/modules/localcmd/confirm-response` 发送 `{ messageId, allowed, rememberChoice, matchEntry }`

新建：
- `web/v3/src/components/common/CmdConfirmDialog.vue` — 居中对话框
- `web/v3/src/services/cmdConfirmService.ts`
- `web/mobile/src/components/common/CmdConfirmSheet.vue` — 底部弹出（复用现有 ConfirmSheet 模式）
- `web/mobile/src/services/cmdConfirmService.ts`

### 7. 设置界面

新建 `web/v3/src/components/settings/CmdPolicySettings.vue`：
- 列出所有组织及其白名单/黑名单
- 默认策略编辑
- 每组织编辑、恢复默认值

修改 `SettingsDialog.vue`：新增「命令审核」标签页。

`configApi.ts` 新增策略 API 方法。

### 8. HTTP API（策略管理 + 确认响应）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/modules/localcmd/policies` | 获取所有组织策略 + 默认值 |
| POST | `/api/modules/localcmd/policies/defaults` | 设置默认策略 |
| POST | `/api/modules/localcmd/policies/:orgId` | 设置某组织策略 |
| DELETE | `/api/modules/localcmd/policies/:orgId` | 删除策略（恢复默认） |
| POST | `/api/modules/localcmd/confirm-response` | 提交命令确认结果 |

全部通过 localcmd 模块 `getHttpHandler()` 暴露。

### 9. 变更文件清单

**心跳框架（前置）：**

| 文件 | 变更类型 |
|---|---|
| `src/platform/services/heartbeat/heartbeat_broker.js` | 新建 |
| `src/platform/services/http/http_server/heartbeat.js` | 新建 |
| `src/platform/services/http/http_server/router.js` | 修改 |
| `src/platform/runtime/bootstrap_manager.js` | 修改 |
| `web/v3/src/services/heartbeatService.ts` | 新建 |
| `web/v3/src/services/uiCommandService.ts` | 修改（迁移到心跳） |
| `web/v3/src/App.vue` | 修改（启动心跳服务） |
| `web/mobile/src/services/heartbeatService.ts` | 新建 |
| `web/mobile/src/App.vue` | 修改（启动心跳服务） |
| `src/platform/services/ui/ui_command_broker.js` | 修改（改用 heartbeatBroker.send） |

**localcmd 审核（本体）：**

| 文件 | 变更类型 |
|---|---|
| `modules/localcmd/policy_engine.js` | 新建 |
| `modules/localcmd/policy_store.js` | 新建 |
| `modules/localcmd/index.js` | 修改 |
| `modules/localcmd/tools.js` | 修改 |
| `web/v3/src/services/cmdConfirmService.ts` | 新建 |
| `web/v3/src/components/common/CmdConfirmDialog.vue` | 新建 |
| `web/v3/src/components/settings/CmdPolicySettings.vue` | 新建 |
| `web/v3/src/components/settings/SettingsDialog.vue` | 修改 |
| `web/v3/src/services/configApi.ts` | 修改 |
| `web/mobile/src/services/cmdConfirmService.ts` | 新建 |
| `web/mobile/src/components/common/CmdConfirmSheet.vue` | 新建 |
| `web/mobile/src/components/settings/SettingsView.vue` | 修改（新增命令审核入口） |

**不修改：** `org_primitives.js`、`config/modules/localcmd.json`

### 10. 实施顺序

1. 心跳框架
2. policy_engine + policy_store
3. localcmd/index.js 集成
4. 前端确认弹窗
5. 设置界面

### 11. 验证方式

1. 心跳框架独立验证：启动系统，v3 和 mobile 两端心跳循环正常，现有 ui_page 功能不受影响
2. 策略 CRUD：v3 设置页查看/编辑各组织策略
3. 命令触发：白名单直接放行，黑名单直接拒绝，未知命令弹出确认
4. 多端同时：desktop（v3）和 mobile 同时打开，两端都弹出确认
5. 重连恢复：mobile 杀进程重开，lastMessageId 重置为 0 → drain 返回所有未过期消息 → 弹窗恢复
6. 后台恢复：desktop 后台标签页切回，漏掉的消息通过 lastMessageId 补齐
