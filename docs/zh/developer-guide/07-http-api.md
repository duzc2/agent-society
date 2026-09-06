# HTTP API 参考

HTTP 服务基于 Hono（`src/platform/services/http/http_server/`），默认端口 3000。路由按域拆分在各文件中，通过 import 副作用注册到同一个 Hono app。所有请求/响应均为 JSON（静态资源除外）。

> 本篇为速查索引。各端点的详细参数以路由文件内注释与实现为准。

## 端点总览

### 消息与需求（agents.js / message-handlers.js）

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/submit` | 提交需求给根智能体（可带 workspacePath 绑定工作区） |
| POST | `/api/send` | 发送消息到指定智能体 |
| GET | `/api/messages/:taskId` | 按任务查询消息 |
| GET | `/api/agent-messages/:agentId` | 按智能体查询消息 |
| POST | `/api/agent/:agentId/abort` | 中断智能体的 LLM 调用 |

### 岗位与组织（roles.js / agents.js）

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/roles` | 列出所有岗位（含智能体数量与 toolGroups） |
| GET | `/api/role/:roleId` | 单个岗位详情 |
| DELETE | `/api/role/:roleId` | 软删除岗位 |
| POST | `/api/role/:roleId/tool-groups` | 更新岗位工具组 |
| POST | `/api/role/:roleId/agents` | 在岗位下创建智能体 |
| POST | `/api/role/:roleId/prompt` | 更新岗位提示词 |
| POST | `/api/role/:roleId/llm-service` | 更新岗位 LLM 服务（手动选模） |
| POST | `/api/role/:roleId/features` | 更新岗位功能开关 |
| PUT | `/api/roles/reorder` | 批量更新岗位排序 |
| GET | `/api/org/role-tree` | 岗位从属关系树 |
| POST | `/api/agent/:agentId/roles` | 为智能体创建子岗位 |
| POST | `/api/agent/:agentId/custom-name` | 设置智能体自定义名称 |
| GET | `/api/agent-custom-names` | 所有自定义名称 |
| POST | `/api/org/:agentId/name` | 设置组织显示名称 |
| GET | `/api/agent/:agentId/system-prompt` | 完整 system prompt |
| GET/PUT | `/api/agent/:agentId/system-prompt-appendix` | prompt 附录条目 |
| GET | `/api/agent/:agentId/todo-list` | 智能体待办列表 |
| GET | `/api/agent/:agentId/auto-reply` | 自动回复配置 |
| GET | `/api/debug/roles` | 调试：所有岗位 ID |

### 群聊（group_chat/group_routes.js）

| 方法 | 端点 | 说明 |
|------|------|------|
| GET/POST | `/api/groups` | 列出 / 创建群 |
| GET/DELETE | `/api/groups/:id` | 群详情 / 解散 |
| GET/POST | `/api/groups/:id/messages` | 群消息读取 / 发送 |
| PUT/DELETE | `/api/groups/:id/messages/:messageId` | 编辑 / 撤回消息 |
| POST/DELETE | `/api/groups/:id/members(/:memberId)` | 邀请 / 移出成员 |

### LLM 与配置（config.js）

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/config/status` | 配置状态（来源：local/default） |
| GET/POST | `/api/config/llm` | 读取 / 保存默认 LLM 配置 |
| POST | `/api/config/llm/set-default` | 设默认服务 |
| GET/POST | `/api/config/modules` | 模块配置 / 保存模块启停 |
| GET/POST | `/api/config/modules/:name` | 单模块配置 |
| GET/POST | `/api/config/app-settings` | 应用设置 |
| GET/POST | `/api/config/llm-services` | LLM 服务池 |
| GET | `/api/llm-services` | 服务列表（运行时视角） |
| POST/DELETE | `/api/config/llm-services(/:serviceId)` | 增 / 改 / 删服务条目 |

### 技能（skills.js）

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/skills` / `/api/skills/runtime` | 技能列表 / 运行时状态 |
| POST | `/api/skills/install` / `uninstall` | 安装 / 卸载 |
| GET | `/api/skills/:skillId` / `/content` | 详情 / 内容 |
| GET/PUT | `/api/role/:roleId/skills` | 岗位技能绑定 |
| GET/PUT | `/api/agent/:agentId/skills` | 智能体技能绑定 |
| CRUD | `/api/custom-skills(…)` | 自定义技能与内部文件/文件夹管理 |

### 组织模板（org-templates.js）

| 方法 | 端点 |
|------|------|
| GET/POST | `/api/org-templates` |
| POST | `/api/org-templates/:orgName/rename` |
| DELETE | `/api/org-templates/:orgName` |
| GET/PUT | `/api/org-templates/:orgName/info` |
| GET/PUT | `/api/org-templates/:orgName/org` |

### 工作区与文件（index.js + workspace/file_access/routes.js）

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/workspaces` | 工作区列表 |
| GET | `/api/workspaces/:workspaceId` | 文件列表 |
| GET | `/api/workspaces/:workspaceId/file?path=` | 文件元数据 |
| GET | `/api/workspaces/:workspaceId/meta` | 工作区元信息 |
| POST | `/api/workspaces/:workspaceId/directory` | 建目录 |
| CRUD | `/api/workspaces/file-access/folders` | 授权文件夹管理 |
| GET | `/api/workspaces/file-access/logs` / `stats` | 审计日志 / 统计 |
| GET/PUT | `/api/workspaces/file-access/settings/retention` | 日志留存设置 |
| GET | `/workspace-files/:workspaceId/*` | 工作区静态文件 |

### 模块（module-api.js）

| 方法 | 端点 |
|------|------|
| GET | `/api/modules` |
| GET | `/api/modules/:name` |
| GET | `/api/modules/:name/web-component` |

### 知识树（knowledge_tree.js）

| 方法 | 端点 |
|------|------|
| GET | `/api/agents/:agentId/knowledge-tree` |
| GET | `/api/agents/:agentId/knowledge-tree/search` |
| GET | `/api/agents/:agentId/knowledge-tree/entry` |
| POST | `/api/agents/:agentId/knowledge-tree` |

### 心跳（heartbeat.js）

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/heartbeat` | 携带 lastMessageId，drain 增量消息/事件（前端实时更新的通道） |
| POST | `/api/heartbeat/clear` | 清理已消费消息 |

### 进程消息（proc_messaging/）

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/proc-messaging/channel/connect` | 进程建立会话 |
| POST | `/api/proc-messaging/channel/poll` | 长轮询下行（挂起 ≤25s） |
| POST | `/api/proc-messaging/channel/up` | 上行消息/事件 |
| POST | `/api/proc-messaging/channel/disconnect` | 注销会话 |
| ANY | `/api/proc-http/:procName/*` | 网页 → 进程 HTTP 桥接 |

### 静态资源

| 端点 | 说明 |
|------|------|
| `GET /web/*` | 前端静态资源（`web/` 目录） |
| `GET /modules/*` | 模块 Web 面板资源（no-cache） |

## 通用约定

- 错误响应：`{ "error": "error_code", "message": "可读描述" }`，HTTP 状态码语义化（400 参数错误 / 404 不存在 / 500 内部错误）；
- 写操作的 body 为 JSON；空 body 视为 null；
- 心跳与长轮询端点不设缓存。

## 心跳协议要点

前端每若干秒 `POST /api/heartbeat`，body 携带 `lastMessageId`：

```json
{ "lastMessageId": 42 }
```

响应为增量消息数组（`messageId > lastMessageId` 且未过期）。HeartbeatBroker 无 clientId——所有客户端平等，多标签页/多端天然同步。消息可带 TTL，过期自动从 drain 结果排除。

## 相关文档

- [Proc 消息协议](10-proc-protocol.md)
- 路由源码：`src/platform/services/http/http_server/` 各文件头部注释
