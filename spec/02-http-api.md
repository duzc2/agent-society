# Agent Society HTTP API 规范

## 1. 概述

### 1.1 设计原则

**为什么保持 API 不变？**

Agent Society Python 版本需要与现有 JavaScript 版本的前端完全兼容。前端代码（HTML/CSS/JS）已经成熟，不应因后端重写而修改。保持 API 一致性意味着：
- 现有用户无需学习新接口
- 前端代码无需修改即可使用新版本
- 可以平滑迁移，回滚风险低

**兼容性保证范围**
- URL 路径必须完全一致
- HTTP 方法必须完全一致
- 请求参数名称、类型、必填性必须完全一致
- 响应字段名称、类型必须完全一致
- 状态码使用必须完全一致
- 错误响应格式必须完全一致

### 1.2 基础信息

**Base URL**：`http://localhost:{port}`

**默认端口**：3000（可通过配置或命令行修改）

**内容类型**：所有 API 请求/响应使用 `application/json`，文件上传除外

**编码**：UTF-8

### 1.3 CORS 支持

所有 API 端点必须支持跨域访问，响应头包含：
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

预检请求（OPTIONS）直接返回 204，无需业务处理。

### 1.4 通用响应格式

**成功响应**

所有成功响应返回 HTTP 200，响应体包含 `ok: true`：
```json
{
  "ok": true,
  ...其他字段
}
```

`ok` 字段是为了让前端代码可以统一检查响应状态，无需关心具体状态码。

**错误响应**

错误响应返回对应的 HTTP 状态码（400、404、500等），响应体包含：
```json
{
  "error": "error_code",
  "message": "Human readable error description"
}
```

`error` 是机器可读的编码，`message` 是人类可读的描述。前端可以根据 error code 做特定处理，也可以直接显示 message。

**错误码规范**

| 状态码 | Error Code | 使用场景 |
|-------|-----------|---------|
| 400 | invalid_json | 请求体不是有效的 JSON |
| 400 | missing_text | 缺少必需的 text 字段 |
| 400 | missing_agent_id | 缺少必需的 agentId 字段 |
| 400 | invalid_content_type | Content-Type 不正确 |
| 400 | file_too_large | 上传文件过大 |
| 404 | not_found | 资源不存在（智能体、岗位、文件等）|
| 409 | agent_terminating | 智能体正在停止，无法发送消息 |
| 409 | agent_computing | 智能体正在计算（某些操作不允许）|
| 500 | society_not_initialized | 系统未初始化完成 |
| 500 | internal_error | 内部服务器错误（兜底）|

---

## 2. API 端点清单

### 2.1 核心 API

**提交需求**
- 端点：`POST /api/submit`
- 功能：向 Root 智能体提交用户需求
- 请求体：`{ "text": "用户的自然语言需求" }`
- 响应：`{ "taskId": "uuid-string" }`
- 说明：系统创建新的 taskId，将需求转发给 Root 智能体异步处理

**发送消息**
- 端点：`POST /api/send`
- 功能：向指定智能体发送消息
- 请求体：`{ "agentId": "目标ID", "text": "消息内容", "taskId": "关联任务", "attachments": [] }`
- 响应：`{ "ok": true, "messageId": "uuid", "taskId": "uuid", "to": "agent-id" }`
- 说明：兼容字段名 `agentId`/`to`、`text`/`message`

**新建 Root 会话**
- 端点：`POST /api/root/new-session`
- 功能：清除 Root 智能体的对话历史
- 请求体：`{}`
- 响应：`{ "ok": true }`
- 说明：用户想要开始新的独立对话时调用

### 2.2 消息查询 API

**获取任务消息**
- 端点：`GET /api/messages/{taskId}`
- 功能：获取指定任务的所有消息
- 响应：消息数组
- 说明：用于前端轮询获取任务进展

**获取智能体消息**
- 端点：`GET /api/agent-messages/{agentId}`
- 功能：获取指定智能体的所有消息
- 响应：消息数组
- 说明：用于显示智能体的完整对话历史

**获取智能体对话历史**
- 端点：`GET /api/agent-conversation/{agentId}`
- 功能：获取用于 LLM 上下文的对话历史
- 响应：`{ "messages": [], "tokenUsage": {} }`
- 说明：格式化为 LLM API 所需的格式

### 2.3 智能体管理 API

**获取智能体列表**
- 端点：`GET /api/agents`
- 功能：列出系统中所有智能体
- 响应：`{ "agents": [ { "id", "roleId", "roleName", "status", ... } ] }`
- 说明：包含状态、自定义名称、工具组等信息

**删除智能体**
- 端点：`DELETE /api/agent/{agentId}`
- 功能：删除指定智能体
- 响应：`{ "ok": true, "message": "智能体已删除" }`
- 说明：级联删除子智能体（需确认）

**中断 LLM 调用**
- 端点：`POST /api/agent/{agentId}/abort`
- 功能：强制中断智能体正在进行的 LLM 调用
- 响应：`{ "ok": true, "message": "已发送中断信号" }`
- 说明：用于用户想要取消当前操作

**设置自定义名称**
- 端点：`POST /api/agent/{agentId}/custom-name`
- 请求体：`{ "customName": "新名称" }`
- 响应：`{ "ok": true }`
- 说明：空字符串表示清除自定义名称

**获取自定义名称**
- 端点：`GET /api/agent-custom-names`
- 响应：`{ "agentId1": "Name1", "agentId2": "Name2" }`
- 说明：返回所有智能体的自定义名称映射

**获取 System Prompt**
- 端点：`GET /api/agent/{agentId}/system-prompt`
- 响应：`{ "agentId": "...", "systemPrompt": "..." }`
- 说明：用于调试查看智能体的完整提示词

### 2.4 岗位管理 API

**获取岗位列表**
- 端点：`GET /api/roles`
- 响应：`{ "roles": [ { "id", "name", "prompt", "agentCount", "toolGroups" } ] }`
- 说明：包含每个岗位下的智能体数量

**获取岗位详情**
- 端点：`GET /api/role/{roleId}`
- 响应：`{ "id", "name", "prompt", "agents": [], "toolGroups" }`
- 说明：包含该岗位下所有智能体列表

**更新岗位职责**
- 端点：`POST /api/role/{roleId}/prompt`
- 请求体：`{ "prompt": "新的职责描述" }`
- 响应：`{ "ok": true }`
- 说明：修改后新创建的智能体使用新 prompt，已有的不受影响（除非重新创建）

**更新工具组**
- 端点：`POST /api/role/{roleId}/tool-groups`
- 请求体：`{ "toolGroups": ["org_management", "workspace"] }`
- 响应：`{ "ok": true }`
- 说明：修改后新创建的智能体使用新工具组

**更新 LLM 服务**
- 端点：`POST /api/role/{roleId}/llm-service`
- 请求体：`{ "llmService": "service-id" }`
- 响应：`{ "ok": true }`
- 说明：指定该岗位使用的 LLM 服务

**删除岗位**
- 端点：`DELETE /api/role/{roleId}`
- 响应：`{ "ok": true, "message": "岗位已删除" }`
- 说明：岗位下有智能体时可能拒绝删除

### 2.5 组织架构 API

**获取组织树**
- 端点：`GET /api/org/tree`
- 响应：`{ "root": { "id", "roleId", "children": [ ... ] } }`
- 说明：以 Root 智能体为根的完整组织层级

**获取岗位树**
- 端点：`GET /api/org/role-tree`
- 响应：`{ "root": { "id", "name", "children": [ ... ] } }`
- 说明：岗位之间的从属关系树

### 2.6 工具组 API

**获取工具组列表**
- 端点：`GET /api/tool-groups`
- 响应：`{ "toolGroups": [ { "id", "name", "description", "tools": [ ... ] } ] }`
- 说明：包含每个工具组下的工具定义

### 2.7 配置管理 API

**获取配置状态**
- 端点：`GET /api/config/status`
- 响应：`{ "llmStatus": "connected|disconnected|error|unknown", "llmLastError": "..." }`
- 说明：返回系统配置和连接状态

**获取 LLM 配置**
- 端点：`GET /api/config/llm`
- 响应：`{ "llm": { "baseURL", "model", "apiKey", ... }, "source": "local|default" }`
- 说明：source 表示配置来源

**保存 LLM 配置**
- 端点：`POST /api/config/llm`
- 请求体：`{ "baseURL": "...", "model": "...", "apiKey": "..." }`
- 说明：保存到 `app.local.json`，apiKey 为空时保留原值

**获取 LLM 服务列表**
- 端点：`GET /api/config/llm-services`
- 响应：`{ "services": [ { "id", "name", "baseURL", "model", ... } ] }`

**添加/更新/删除 LLM 服务**
- 添加：`POST /api/config/llm-services`
- 更新：`POST /api/config/llm-services/{serviceId}`
- 删除：`DELETE /api/config/llm-services/{serviceId}`

**获取运行时服务列表**
- 端点：`GET /api/llm-services`
- 说明：返回运行时实际使用的服务列表

### 2.8 工作空间 API

**获取工作空间列表**
- 端点：`GET /api/workspaces`
- 响应：`{ "workspaces": [ { "id", "name", "path", "fileCount", "size" } ] }`

**获取文件列表**
- 端点：`GET /api/workspaces/{workspaceId}`
- 响应：`{ "workspaceId", "path", "files": [ { "id", "type", "name", "size", ... } ] }`

**获取文件内容**
- 端点：`GET /api/workspaces/{workspaceId}/file?path={filePath}`
- 响应：`{ "id", "name", "content", "encoding": "utf-8|base64", ... }`
- 说明：文本文件直接返回内容，二进制返回 base64

**写入文件**
- 端点：`POST /api/workspaces/{workspaceId}/file?path={filePath}`
- 请求体：`{ "content": "...", "encoding": "utf-8|base64" }`
- 说明：自动创建目录

**删除文件**
- 端点：`DELETE /api/workspaces/{workspaceId}/file?path={filePath}`
- 说明：可删除文件或目录

**其他工作空间操作**
- 获取元信息：`GET /api/workspaces/{workspaceId}/meta`
- 获取空间占用：`GET /api/workspaces/{workspaceId}/disk-usage`
- 获取智能体文件：`GET /api/workspaces/{workspaceId}/agent-files/{agentId}`
- 删除工作空间：`DELETE /api/workspaces/{workspaceId}`

### 2.9 组织模板 API

**模板列表**：`GET /api/org-templates`
**创建模板**：`POST /api/org-templates`
**重命名**：`POST /api/org-templates/{orgName}/rename`
**删除**：`DELETE /api/org-templates/{orgName}`
**获取/更新 info.md**：`GET/PUT /api/org-templates/{orgName}/info`
**获取/更新 org.md**：`GET/PUT /api/org-templates/{orgName}/org`

### 2.10 文件上传 API

**上传文件**
- 端点：`POST /api/upload`
- Content-Type：`multipart/form-data`
- Form Fields：`file`, `workspaceId`, `path`, `filename`, `operator`
- 响应：`{ "ok": true, "path": "...", "metadata": { ... } }`
- 说明：文件保存到指定工作空间

### 2.11 事件查询 API

**拉取待消费事件**
- 端点：`GET /api/events?since={timestamp}`
- 响应：`{ "errors": [ ... ], "retries": [ ... ], "timestamp": "..." }`
- 说明：返回当前尚未被前端消费的错误和 LLM 重试事件，用于前端显示状态
- 语义：该接口为消费型队列语义；本次响应成功发送给页面后，服务端会删除本次返回的事件
- 约束：`since` 仅过滤当前待消费事件，不提供历史事件查询能力

### 2.12 UI 命令 API

**轮询命令**
- 端点：`GET /api/ui-commands/poll?timeout={ms}`
- 响应：`{ "commands": [ { "id", "type", "title", "message", "options" } ] }`
- 说明：长轮询，有新命令时立即返回，超时空返回

**提交结果**
- 端点：`POST /api/ui-commands/result`
- 请求体：`{ "commandId": "...", "result": "...", "cancelled": false }`
- 说明：用户响应后提交结果

### 2.13 静态文件服务

**Web 静态文件**：`GET /web/{path}`
**模块静态文件**：`GET /modules/{module}/{path}`
**工作空间文件**：`GET /workspace-files/{workspaceId}/{filePath}`

---

## 3. 消息数据结构

### 3.1 消息字段说明

**核心字段**
- `id`：消息唯一标识，UUID 格式
- `type`：消息类型，`text` | `tool_call` | `error`
- `from`：发送者智能体ID
- `to`：接收者智能体ID或 `"user"`
- `taskId`：关联的任务ID
- `payload`：消息内容，类型取决于消息类型
- `createdAt`：创建时间，ISO 8601 格式
- `deliveredAt`：实际投递时间（延迟消息）
- `scheduledDeliveryTime`：预计投递时间（延迟消息）
- `reasoning_content`：思考过程（如果模型支持）

**设计说明**

为什么使用 `from` 而不是 `sender`？因为 `from` 更简洁，且与 JavaScript 版本保持一致。

为什么消息内容放在 `payload` 而不是 `content`？因为 `payload` 可以容纳各种类型的数据（文本、工具调用、附件等），而 `content` 通常暗示字符串。

延迟消息为什么会有两个时间字段？`scheduledDeliveryTime` 是发送时设定的预计时间，`deliveredAt` 是实际投递时间。这两个时间可能不同，用于审计和调试。

### 3.2 消息类型详解

**Text 消息**
```json
{
  "type": "text",
  "payload": {
    "text": "消息文本",
    "usage": { "promptTokens": 100, "completionTokens": 50 }
  }
}
```

**Tool Call 消息**
```json
{
  "type": "tool_call",
  "payload": {
    "toolName": "send_message",
    "args": { "to": "agent-1", "message": "..." },
    "result": "工具执行结果",
    "usage": { ... }
  }
}
```

**Error 消息**
```json
{
  "type": "error",
  "payload": {
    "errorType": "llm_error",
    "message": "错误描述"
  }
}
```

---

## 4. API 实现规范

### 4.1 路由处理规范

**路径参数解码**

URL 路径中的参数（如 agentId）可能包含特殊字符，必须进行 URI 解码：
```python
agent_id = decodeURIComponent(pathname.slice("/api/agent/".length))
```

**方法匹配顺序**

路由匹配应该先匹配 HTTP 方法，再匹配路径：
```python
if method == "POST" and pathname == "/api/submit":
    # 处理提交
elif method == "GET" and pathname.startswith("/api/messages/"):
    # 处理查询
```

**动态路径匹配**

对于 `/api/agent/{agentId}/abort` 这样的路径，使用正则提取：
```python
match = pathname.match(r"^/api/agent/(.+)/abort$")
if match:
    agent_id = decodeURIComponent(match[1])
```

### 4.2 请求处理规范

**JSON 解析错误处理**

请求体解析失败时返回 400：
```python
try:
    body = json.loads(request_body)
except json.JSONDecodeError:
    return { "error": "invalid_json", "message": "请求体不是有效的 JSON" }
```

**参数验证**

必需参数缺失时返回 400：
```python
if not body.get("text"):
    return { "error": "missing_text", "message": "请求体必须包含 text 字段" }
```

**资源不存在**

智能体、岗位、文件等资源不存在时返回 404：
```python
if not runtime.get_agent(agent_id):
    return { "error": "not_found", "message": f"智能体不存在: {agent_id}" }
```

### 4.3 响应生成规范

**JSON 序列化**

确保中文字符正确编码：
```python
json.dumps(data, ensure_ascii=False)
```

**CORS 头**

所有响应（包括错误响应）必须包含 CORS 头：
```python
res.set_header("Access-Control-Allow-Origin", "*")
```

**Content-Type**

JSON 响应必须设置 Content-Type：
```python
res.set_header("Content-Type", "application/json")
```

### 4.4 错误处理规范

**异常捕获**

所有请求处理必须 try-except 包裹，防止未捕获异常导致进程崩溃：
```python
try:
    result = await handle_request(req, res)
except Exception as e:
    log.error(f"处理请求失败: {e}")
    return { "error": "internal_error", "message": str(e) }
```

**错误日志**

错误发生时记录详细日志，包括：
- 请求方法和 URL
- 错误信息和堆栈
- 相关上下文（agentId、taskId 等）

**敏感信息过滤**

错误信息中不能包含：
- API Key
- 文件系统绝对路径
- 内部实现细节

---

## 5. 前端兼容性说明

### 5.1 字段命名约定

**JSON 字段使用 camelCase**

与 TypeScript/JavaScript 代码风格一致：
```json
{ "agentId": "...", "createdAt": "...", "toolGroups": [] }
```

**Python 模型使用 snake_case**

通过 Pydantic alias 映射：
```python
agent_id: str = Field(alias="agentId")
```

### 5.2 布尔值表示

使用 JSON 布尔值，不要用字符串：
```json
{ "ok": true }  # 正确
{ "ok": "true" }  # 错误
```

### 5.3 空值处理

使用 `null` 表示空值，不要用空字符串或特殊值：
```json
{ "customName": null }  # 正确
{ "customName": "" }     # 错误，表示空字符串而非空值
```

### 5.4 数组和对象

空数组用 `[]`，空对象用 `{}`，不要用 `null`：
```json
{ "attachments": [] }  # 正确
{ "attachments": null }  # 错误
```

---

## 6. 性能考虑

### 6.1 响应大小限制

单个响应体大小限制为 10MB，超过时返回错误：
```python
if len(json_response) > 10 * 1024 * 1024:
    return { "error": "response_too_large" }
```

### 6.2 大文件处理

文件下载（`/workspace-files/`）使用流式传输，不加载整个文件到内存。

### 6.3 查询优化

消息查询支持分页（未来版本），目前前端轮询应控制频率（建议 1-2 秒）。

---

## 7. 安全考虑

### 7.1 路径遍历防护

所有文件路径必须规范化并验证在允许范围内：
```python
file_path = (base_path / relative_path).resolve()
if not str(file_path).startswith(str(base_path)):
    raise Forbidden("非法的文件路径")
```

### 7.2 请求大小限制

JSON 请求体限制 1MB，文件上传限制 100MB。

### 7.3 速率限制

API 请求默认限速：
- 普通 API：100 请求/分钟
- 文件上传：10 请求/分钟
- LLM 调用：由并发数控制（默认 2 并发）
