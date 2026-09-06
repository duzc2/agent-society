# Proc 消息协议

进程消息协议（Proc Messaging Protocol）让智能体启动的进程与智能体、网页三方互通。完整规范以 `docs/proc-messaging-protocol.md` 为准（v1.2），本篇是开发者视角的摘要。

## 实现位置

| 组件 | 文件 |
|------|------|
| 会话与路由中心 | `src/platform/services/proc_messaging/proc_message_hub.js` |
| 通道端点 | `proc_message_channel_routes.js` |
| HTTP 桥接端点 | `proc_http_bridge_routes.js` |
| Node SDK | `sdk/proc_client.js` |
| 示例 | `sdk/examples/crawler.js` |
| 协议测试 | `test/platform/proc_message_hub.test.js` 等 |

## 协议要点

- **传输**：全部走框架 HTTP 服务，进程零端口。请求/响应 JSON。
- **端点**：
  | 端点 | 用途 |
  |------|------|
  | `POST <base>/api/proc-messaging/channel/connect` | 建立会话（校验 spawn token，返回 sessionId） |
  | `POST <base>/api/proc-messaging/channel/poll` | 长轮询下行（空轮询挂起 ≤25s） |
  | `POST <base>/api/proc-messaging/channel/up` | 上行一条消息（msg/event/error/http_result） |
  | `POST <base>/api/proc-messaging/channel/disconnect` | 注销会话 |
  | `ANY <base>/api/proc-http/:procName/*` | 网页 ⇄ 进程 HTTP 桥 |
- **上行类型**：`msg`（给智能体）/ `event`（给网页）/ `error` / `http_result`（桥接响应）；
- **下行类型**：`msg`（智能体消息）/ `http`（桥接请求）；
- **地址**：进程注册后为 `proc:<name>#<agentId>`；`name` 进程声明、须唯一（同名顶掉旧连接，被顶者不重连）；`agentId` 服务端按 token 解析；智能体侧按 spawn 注入的 `processId` 寻址；
- **安全**：连接权限 = spawn 专属 token（`SOCIETY_PROC_TOKEN`，spawn 时注入，进程生命周期内有效）；connect 成功后的 sessionId 为后续凭证；
- **SDK 重连**：断线指数退避 1s→30s；被顶替不重连（防顶替风暴）。

## 会话时序

```
进程                                     平台
 │── connect{token,name,processId?} ──▶ │ 校验 token → 解析归属 agentId
 │                                      │ → 分配 procId；注册 proc:<name>#<agentId>
 │ ◀── {sessionId, as} ──────────────── │
 │── poll{sessionId} ─────────────────▶ │ 队列空则挂起（≤25s）
 │ ◀── [下行消息…] ──────────────────── │
 │── up{sessionId, type:msg|event,…} ─▶ │ 路由到智能体会话/网页事件通道
```

## HTTP 桥接时序

```
网页                     平台                         进程
 │─ fetch /api/proc-http/ │                            │
 │   {name}/path… ──────▶ │─ down:http{reqId,path,…} ─▶│ onRequest(req)
 │                        │                            │ 返回 {status,headers,body}
 │ ◀─ 响应 ────────────── │◀─ up:http_result{reqId,…} ─│
```

- 未注册 onRequest 的进程自动 404；handler 抛异常自动 500；
- 请求有超时保护，进程离线时桥接直接失败。

## 非 Node 接入

1. 读环境变量 `SOCIETY_PROC_HTTP_URL` / `SOCIETY_PROC_TOKEN` / `SOCIETY_PROC_PROCESS_ID`；
2. POST connect 拿 sessionId；
3. 循环 poll 收下行；有消息要发就 POST up；
4. 处理 `http` 类型下行即实现桥接服务端；
5. 退出前 POST disconnect。

照协议文档的字段定义实现即可，协议测试（`test/platform/proc_message_hub.test.js`）是行为基准。

## 相关文档

- 用户视角：[进程协作](../user-guide/12-proc-messaging.md)
- localcmd 模块（进程生命周期）：`modules/localcmd/`
