# HTTP API Reference

The HTTP server is built on Hono (`src/platform/services/http/http_server/`), default port 3000. Routes are split by domain across files, registered onto one Hono app via import side effects. All request/response bodies are JSON (static resources excepted).

> This page is a quick index. Per-endpoint details live in the route files' comments and implementations.

## Endpoint Overview

### Messages & Requirements (agents.js / message-handlers.js)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/submit` | Submit a requirement to Root (optional workspacePath binds a workspace) |
| POST | `/api/send` | Send a message to a specific agent |
| GET | `/api/messages/:taskId` | Query messages by task |
| GET | `/api/agent-messages/:agentId` | Query messages by agent |
| POST | `/api/agent/:agentId/abort` | Abort an agent's LLM call |

### Roles & Organization (roles.js / agents.js)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/roles` | List all roles (with agent counts and toolGroups) |
| GET | `/api/role/:roleId` | Single role details |
| DELETE | `/api/role/:roleId` | Soft-delete a role |
| POST | `/api/role/:roleId/tool-groups` | Update role tool groups |
| POST | `/api/role/:roleId/agents` | Spawn an agent under a role |
| POST | `/api/role/:roleId/prompt` | Update the role prompt |
| POST | `/api/role/:roleId/llm-service` | Update the role's LLM service (manual selection) |
| POST | `/api/role/:roleId/features` | Update role feature switches |
| PUT | `/api/roles/reorder` | Batch-update role ordering |
| GET | `/api/org/role-tree` | Role hierarchy tree |
| POST | `/api/agent/:agentId/roles` | Create a sub-role for an agent |
| POST | `/api/agent/:agentId/custom-name` | Set an agent's custom name |
| GET | `/api/agent-custom-names` | All custom names |
| POST | `/api/org/:agentId/name` | Set the organization display name |
| GET | `/api/agent/:agentId/system-prompt` | Full system prompt |
| GET/PUT | `/api/agent/:agentId/system-prompt-appendix` | Prompt appendix entries |
| GET | `/api/agent/:agentId/todo-list` | Agent todo list |
| GET | `/api/agent/:agentId/auto-reply` | Auto-reply configuration |
| GET | `/api/debug/roles` | Debug: all role IDs |

### Group Chat (group_chat/group_routes.js)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET/POST | `/api/groups` | List / create groups |
| GET/DELETE | `/api/groups/:id` | Group details / dissolve |
| GET/POST | `/api/groups/:id/messages` | Read / post group messages |
| PUT/DELETE | `/api/groups/:id/messages/:messageId` | Edit / retract a message |
| POST/DELETE | `/api/groups/:id/members(/:memberId)` | Invite / remove members |

### LLM & Configuration (config.js)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/config/status` | Config status (source: local/default) |
| GET/POST | `/api/config/llm` | Read / save default LLM config |
| POST | `/api/config/llm/set-default` | Set the default service |
| GET/POST | `/api/config/modules` | Module config / save enable state |
| GET/POST | `/api/config/modules/:name` | Single module config |
| GET/POST | `/api/config/app-settings` | Application settings |
| GET/POST | `/api/config/llm-services` | LLM service pool |
| GET | `/api/llm-services` | Service list (runtime view) |
| POST/DELETE | `/api/config/llm-services(/:serviceId)` | Add / update / delete entries |

### Skills (skills.js)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/skills` / `/api/skills/runtime` | Skill list / runtime status |
| POST | `/api/skills/install` / `uninstall` | Install / uninstall |
| GET | `/api/skills/:skillId` / `/content` | Details / content |
| GET/PUT | `/api/role/:roleId/skills` | Role skill bindings |
| GET/PUT | `/api/agent/:agentId/skills` | Agent skill bindings |
| CRUD | `/api/custom-skills(…)` | Custom skills and internal file/folder management |

### Organization Templates (org-templates.js)

| Method | Endpoint |
|--------|----------|
| GET/POST | `/api/org-templates` |
| POST | `/api/org-templates/:orgName/rename` |
| DELETE | `/api/org-templates/:orgName` |
| GET/PUT | `/api/org-templates/:orgName/info` |
| GET/PUT | `/api/org-templates/:orgName/org` |

### Workspace & Files (index.js + workspace/file_access/routes.js)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/workspaces` | Workspace list |
| GET | `/api/workspaces/:workspaceId` | File list |
| GET | `/api/workspaces/:workspaceId/file?path=` | File metadata |
| GET | `/api/workspaces/:workspaceId/meta` | Workspace metadata |
| POST | `/api/workspaces/:workspaceId/directory` | Create directory |
| CRUD | `/api/workspaces/file-access/folders` | Authorized folder management |
| GET | `/api/workspaces/file-access/logs` / `stats` | Audit logs / stats |
| GET/PUT | `/api/workspaces/file-access/settings/retention` | Log retention settings |
| GET | `/workspace-files/:workspaceId/*` | Workspace static files |

### Modules (module-api.js)

| Method | Endpoint |
|--------|----------|
| GET | `/api/modules` |
| GET | `/api/modules/:name` |
| GET | `/api/modules/:name/web-component` |

### Knowledge Tree (knowledge_tree.js)

| Method | Endpoint |
|--------|----------|
| GET | `/api/agents/:agentId/knowledge-tree` |
| GET | `/api/agents/:agentId/knowledge-tree/search` |
| GET | `/api/agents/:agentId/knowledge-tree/entry` |
| POST | `/api/agents/:agentId/knowledge-tree` |

### Heartbeat (heartbeat.js)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/heartbeat` | Carries lastMessageId; drains incremental messages/events (the frontend live-update channel) |
| POST | `/api/heartbeat/clear` | Clear consumed messages |

### Process Messaging (proc_messaging/)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/proc-messaging/channel/connect` | Process establishes a session |
| POST | `/api/proc-messaging/channel/poll` | Long-poll downstream (suspends ≤25s) |
| POST | `/api/proc-messaging/channel/up` | Upstream message/event |
| POST | `/api/proc-messaging/channel/disconnect` | Deregister session |
| ANY | `/api/proc-http/:procName/*` | Web page → process HTTP bridge |

### Static Resources

| Endpoint | Description |
|----------|-------------|
| `GET /web/*` | Frontend static assets (`web/` directory) |
| `GET /modules/*` | Module web panel assets (no-cache) |

## Conventions

- Error responses: `{ "error": "error_code", "message": "readable description" }`, with semantic HTTP status codes (400 bad request / 404 not found / 500 internal);
- Write operations take JSON bodies; empty bodies are treated as null;
- Heartbeat and long-poll endpoints set no caching.

## Heartbeat Protocol Essentials

Every few seconds the frontend calls `POST /api/heartbeat` with a `lastMessageId`:

```json
{ "lastMessageId": 42 }
```

The response is the incremental message array (`messageId > lastMessageId`, unexpired). HeartbeatBroker has no clientId — all clients are equal, so multiple tabs/devices sync naturally. Messages may carry a TTL; expired ones drop out of drain results automatically.

## Related Documents

- [Proc Messaging Protocol](10-proc-protocol.md)
- Route sources: header comments in each file under `src/platform/services/http/http_server/`
