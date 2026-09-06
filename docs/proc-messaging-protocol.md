# 进程消息协议（Proc Messaging Protocol）

> 版本：v1.2（传输层 HTTP 化；消息 + 事件 + 握手注册；v1.2 兑现 v1.1 预留的 RPC：网页页面 ⇄ 进程 HTTP 桥接）
> 实现：平台侧 `src/platform/services/proc_messaging/proc_message_hub.js`（会话与路由）+ `proc_message_channel_routes.js`（HTTP 端点）+ `proc_http_bridge_routes.js`（桥接端点）；SDK 侧 `sdk/proc_client.js`
> 适用：智能体通过 `localcmd_spawn` 启动的**本机**服务器进程（remote SSH 进程后续接入，协议不变）

## 一、总体

- **传输**：全部走**框架 HTTP 服务**（进程不感知也不需要感知端口——`SOCIETY_PROC_HTTP_URL` 由平台 spawn 时注入实际地址，端口唯一来源是用户配置）。请求/响应均为 JSON。
- **端点**（`<base>` = `SOCIETY_PROC_HTTP_URL`）：
  | 端点 | 说明 |
  |---|---|
  | `POST <base>/api/proc-messaging/channel/connect` | 建立会话（校验 token，返回 sessionId） |
  | `POST <base>/api/proc-messaging/channel/poll` | 长轮询取下行消息（空队列挂起 ≤25s） |
  | `POST <base>/api/proc-messaging/channel/up` | 上行一条消息（msg/event/error） |
  | `POST <base>/api/proc-messaging/channel/disconnect` | 注销会话 |
- **方向**：
  - 进程 → 平台（上行，经 `up`）：`msg` / `event` / `error` / `http_result`
  - 平台 → 进程（下行，经 `poll` 返回）：`msg` / `http`
- **地址**：进程注册后的地址为 `proc:<name>#<agentId>`（`name` 由进程声明且须唯一——同名接入会顶掉先接入的连接；`agentId` 由服务端按 token 解析归属，进程无需声明）；**智能体侧寻址用 spawn 时注入的 `processId`**（connect 携带，平台建立 processId→地址索引），智能体无需知道进程名。
- **安全**：连接权限由 **spawn 专属 token** 控制（`SOCIETY_PROC_TOKEN`，平台 spawn 时注入，进程生命周期内存续——SDK 断线重连复用同一 token，进程退出后由进程管理器清理）。connect 成功后的 `sessionId` 为后续请求凭证。

## 二、会话流程

```
进程                                  平台
 │── connect{token,name,processId?} ──→ │  校验 token → 解析归属 agentId
 │                                      │  → 分配 procId；注册 proc:<name>#<agentId>
 │ ←── {sessionId, as} ──────────────── │
 │── poll{sessionId} ──────────────────→ │  队列空则挂起（≤25s）
 │ ←── {messages:[{type:"msg",...}]} ── │  下行消息随 poll 返回
 │── up{sessionId, msg:{type:"event",…}}│  上行消息
```

- token 无效 → `401 invalid_token`；字段缺失 → `400`；未知 sessionId → `404 unknown_session`。
- 同名进程重复 connect（同 `name#agentId`）：平台保留新会话、旧会话标记 replaced——旧会话挂起的 poll 立即返回 `{replaced:true}`（进程重启场景；多 worker 并发时 name 冲突会互踩，进程名须唯一）。
- **进程侧应实现断线重连**（SDK 已内置：网络错误指数退避 1s→2s→…→30s 重新 connect；收到 replaced 不重连，避免顶替风暴）。SDK close 时等待未完成上行落地再 disconnect。
- 进程异常死亡（未 disconnect）→ 服务端惰性过期清理（>60s 无 poll/up 活动即注销）。

## 三、消息信封

| 字段 | 类型 | 说明 |
|---|---|---|
| `v` | number | 协议版本，当前 `1` |
| `id` | string | 消息 ID（UUID），`http`/`http_result` 的请求/响应关联键（v1.1 预留的 RPC 匹配键） |
| `type` | string | `msg`/`event`/`error`/`http`/`http_result`（握手与会话由 HTTP 语义承载，不再是消息类型） |
| 其余 | — | 按 type 定义，见下表 |

### 3.1 上行（进程 → 平台，经 `up` 端点）

```json
{"v":1,"id":"<uuid>","type":"msg","to":"agent-1","payload":{"text":"任务完成"}}
```
- `to`：目标（**缺省 = 归属智能体**）。
- 平台行为：`to` 为智能体 ID → `bus.send({ to, from: "proc:<name>#<agentId>", payload, extras:{kind:"proc_msg", procName} })`；智能体以【服务器进程消息·name】插入会话。
- `payload`：任意 JSON（对象/字符串），建议 `{ text, data }` 结构。

```json
{"v":1,"id":"<uuid>","type":"event","event":"progress","data":{"percent":42}}
```
- 平台行为：`heartbeatBroker.broadcast("proc_event", { procId, procName, agentId, event, data, ts }, 60s TTL)` → 网页进程控制台显示；60 秒窗口内未消费即过期（事件类通知，不保证送达）。
- `event` 为事件名（必填，且必须为合法字符串）。

```json
{"v":1,"id":"<uuid>","type":"error","message":"...","details":{...}}
```
- 平台行为：`log.error` 全量记录 + 以 `proc_event`（`event="proc_error"`）广播网页。

### 3.2 下行（平台 → 进程，经 `poll` 返回）

```json
{"v":1,"id":"<uuid>","type":"msg","payload":{"text":"...","data":{...}}}
```
- `msg.payload` 来源：① 智能体 `proc_send` 工具（`payload = { ...结构化参数, text? }`）；② 网页进程控制台发送。

## 四、接入方式

### 4.1 Node 接入胶水（推荐，一行接入）

智能体侧：`localcmd_spawn` 传 `procName` 参数（如 `procName: "crawler"`），平台自动注入全部连接配置。

进程代码侧：

```js
// 一行接入：proc 已连接就绪（进程名/地址/token 由平台注入的环境变量提供）
const { proc } = await import(process.env.SOCIETY_PROC_GLUE_URL);

proc.onMessage((payload) => {                                // 收到智能体发来的消息
  console.log("收到:", payload);
  proc.send({ text: "收到：" + JSON.stringify(payload) });   // 回消息给智能体（缺省目标 = 归属智能体）
});

proc.notifyWeb("progress", { percent: 42 });                 // 事件 → 网页控制台
```

要点：
- 进程退出前调 `await proc.close()`：等待未完成上行落地并注销会话（HTTP 上行是异步请求，`send` 后立即 `process.exit` 会把请求带走）。
- `name`（procName）须在该智能体名下唯一（同名接入会顶掉先接入的连接）。
- 断线重连内置（指数退避，重连自动重新 connect；被同名顶替时停止重连并发出 replaced 事件）。

### 4.2 Node SDK（手动接入， glue 不可用时的等价方式）

```js
// 动态 import（静态 import 的 from 只能是字符串字面量，无法引用环境变量）
const { createProcClient } = await import(process.env.SOCIETY_PROC_SDK_URL);   // spawn 注入的 file:// URL（或 "<项目>/sdk/proc_client.js"）

const proc = await createProcClient({ name: "crawler" });   // 只需进程名（须唯一）；地址/token 自动读 spawn 环境变量
```

其余 API 与 4.1 相同。`name` 须在该智能体名下唯一。

### 4.3 平台侧环境变量（spawn 自动注入）

| 变量 | 说明 |
|---|---|
| `SOCIETY_PROC_HTTP_URL` | 框架 HTTP 服务地址（如 `http://127.0.0.1:3000`；端口来自用户配置，平台启动后自动注入实际值——进程与智能体均不感知具体端口） |
| `SOCIETY_PROC_TOKEN` | 本次 spawn 专属 token（进程生命周期内存续；进程退出后失效） |
| `SOCIETY_PROC_PROCESS_ID` | 本次 spawn 的进程 ID（SDK connect 携带，供智能体按 processId 寻址） |
| `SOCIETY_PROC_AGENT_ID` | 归属智能体 ID（SDK 兜底读取；归属最终由服务端按 token 解析） |
| `SOCIETY_PROC_SDK_URL` | SDK 的 file:// URL（生成的进程代码动态 import 用，避免 Windows 盘符路径无法 import） |
| `SOCIETY_PROC_GLUE_URL` | 接入胶水模块的 file:// URL（spawn 带 procName 时注入；import 即完成连接并导出就绪的 proc） |
| `SOCIETY_PROC_NAME` | procName 参数值（glue 模块创建连接时用作进程名） |

进程内读取这些变量后连接即可；不连接的进程完全不受影响（普通 stdin/stdout 语义不变）。

## 五、Python 手写示例（最小可用）

```python
import json, os, urllib.request, uuid

base = os.environ["SOCIETY_PROC_HTTP_URL"]; token = os.environ["SOCIETY_PROC_TOKEN"]

def post(path, body):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

# connect：agentId 由服务端按 token 解析，无需声明
conn = post("/api/proc-messaging/channel/connect", {"token": token, "name": "crawler"})
session = conn["sessionId"]
print("注册成功:", conn["as"])
post("/api/proc-messaging/channel/up", {"sessionId": session,
     "msg": {"v":1,"id":str(uuid.uuid4()),"type":"event","event":"ready","data":{"ok":True}}})

# 长轮询收下行（SDK 会循环调用；此处演示一次）
inbox = post("/api/proc-messaging/channel/poll", {"sessionId": session})
for msg in inbox.get("messages", []):
    if msg["type"] == "msg":
        print("收到消息:", msg.get("payload"))
        post("/api/proc-messaging/channel/up", {"sessionId": session,
             "msg": {"v":1,"id":str(uuid.uuid4()),"type":"msg","payload":{"text":"已处理"}}})
```

## 六、网页页面 ⇄ 进程 HTTP 桥接（v1.2）

让挂在框架静态托管上的页面（`/workspace-files/{workspaceId}/xxx.html`）经框架端口与进程双向通信——**进程零端口**（不监听任何东西，只收发协议信封），页面与 API 同源（同一个用户配置的框架端口），fetch 相对路径即可。

```
页面 fetch("/api/proc-http/{procName}/api/data")
  → 桥接路由解析 procName（在线同名进程唯一 → 直接路由；多个 → ?ws={agentId} 过滤；仍歧义 → 409 带候选）
  → hub.requestProc 以 {"v":1,"id":"<uuid>","type":"http",...} 信封经长轮询下发
  → 进程 SDK onRequest 处理 → {"v":1,"id":"<同一uuid>","type":"http_result","status":200,...} 上行
  → 桥接路由按 id 关联，把 status/headers/body 原样回给浏览器
```

### 6.1 桥接端点（框架侧，页面直接调用）

| 端点 | 说明 |
|---|---|
| `ANY /api/proc-http/:procName/*` | 页面 → 进程（method/path/query/headers/body 透传给进程 onRequest） |

- 寻址：页面只给 procName + 相对路径；归属 agentId 由服务端按在线会话解析，页面无需（也不应）声明。
- 同名消歧：在线同名进程唯一 → 直接路由（常见情形）；多个 → `?ws={agentId}` 过滤（页面可从 `location.pathname` 解析）；仍歧义 → `409 {error:"ambiguous_proc_name", candidates:[{agentId, addr}]}`，绝不瞎选。
- 失败：进程离线 → `404 {error:"proc_offline"}`；进程处理超时（30s）→ `504 {error:"bridge_timeout"}`；挂起期间会话死亡（被顶替/注销/过期）→ `502 {error:"session_died"}`；body 超 10MB → `413`。

### 6.2 下行信封（平台 → 进程）

```json
{"v":1,"id":"<uuid>","type":"http","method":"POST","path":"/api/data","query":"?x=1","headers":{...},"body":{...}}
```

- `body`：`Content-Type: application/json` → 解析后的 JSON 对象；其余类型 → `{_raw:"<文本>", _contentType:"<类型>"}`；无 body → `null`。

### 6.3 上行信封（进程 → 平台，经 `up`）

```json
{"v":1,"id":"<与请求相同的uuid>","type":"http_result","status":200,"headers":{"Content-Type":"application/json"},"body":{...}}
```

- `id` 必须与请求信封相同（关联键）；`status` 缺省 500；平台只透传 `Content-Type` 响应头，其余头忽略。
- 进程侧行为：未注册 onRequest → 平台代答 404（`no_request_handler`）；onRequest 抛异常 → SDK 记日志 + 代答 500（异常不吞）。
- 迟到的 `http_result`（请求已超时/会话死亡）被平台丢弃并告警。

### 6.4 进程侧接入（SDK，与 onMessage 并列）

```js
const { proc } = await import(process.env.SOCIETY_PROC_GLUE_URL);

// 页面（浏览器）→ 进程：处理并返回 {status, headers?, body?}（可异步）
proc.onRequest(async (req) => {
  // req = { method, path, query, headers, body }
  if (req.method === "POST" && req.path === "/api/data") {
    proc.notifyWeb("data", req.body);          // 可顺带推事件给页面控制台
    return { status: 200, body: { ok: true, received: req.body } };
  }
  return { status: 404, body: { error: "not_found" } };
});
```

### 6.5 页面侧用法（零配置，同源相对路径）

```html
<!-- 页面由 localcmd 写入工作区（如 widget.html），经 /workspace-files/{workspaceId}/widget.html 打开 -->
<script>
  // fetch 相对路径 = 同一个框架端口（页面地址与 API 同源），无任何配置
  const r = await fetch(`/api/proc-http/widget-server/api/data?ws=${location.pathname.split("/")[2]}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello" })
  });
  const data = await r.json();
</script>
```

- `?ws={workspaceId}` 仅同名多进程歧义时才需要（`location.pathname.split("/")[2]` 即 workspaceId）；单进程场景可省略。
- 页面 → 进程之外的其他方向沿用既有通道：进程 → 页面用 `proc.notifyWeb`（控制台），页面 → 智能体用会话。

## 七、与标准输入输出的关系

| | 协议进程（接入 SDK） | 普通进程（未接入） |
|---|---|---|
| 智能体 → 进程 | `proc_send`（结构化 msg） | `localcmd_send_input`（stdin 文本） |
| 进程 → 智能体 | `msg`（进会话【服务器进程消息·x】） | 输出文件 + 事件推送（30s 聚合/exit 立即） |
| 进程 → 网页 | `event`（控制台消息流） | 无（面板文本输出轮询） |
| 日志 | 建议写 stderr / 日志文件 | stdout（read_output 可读） |

两种方式可并存：同一进程先走 stdin/stdout 语义，再升级为协议进程时，SDK 连入即生效，无需改动进程管理侧。
