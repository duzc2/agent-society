# Core Concepts & Data Model

Implementation details of the key domain objects. Source references: `src/platform/core/org_primitives.js`, `src/agents/agent.js`, `src/platform/core/message_bus.js`.

## Role

A role defines duties and owns no executor itself. Multiple agents can share one role.

```javascript
{
  id: "role-uuid",           // role ID
  name: "Frontend Engineer", // role name (findable via find_role_by_name)
  rolePrompt: "…",           // duty prompt (shared by agents on the role)
  orgPrompt: "…",            // org prompt (root-only; inherited by child roles)
  toolGroups: ["chrome"],    // tool group whitelist; null/undefined = all
  skillBindings: [           // skill bindings
    { skillId: "custom:custom:xxx", enabled: true }
  ],
  parentId: null,            // parent role (forms the role tree)
  createdBy: "agent-id",     // creating agent
  status: "active"           // active | deleted (soft delete)
}
```

Validation lives in `validateRole()` at the top of `org_primitives.js`: id/name/rolePrompt required; toolGroups must be a string array or null; skillBindings entries must carry skillId and enabled.

## Agent

`src/agents/agent.js` defines the instance shape; the runtime registry plus persisted state describe an agent:

```javascript
{
  id: "agent-uuid",
  roleId: "role-uuid",       // owning role
  roleName: "Frontend Engineer",
  rolePrompt: "…",           // snapshotted from the role at creation
  name: null,                // agent name (customizable)
  behavior: Function,        // message entry point (runtime-injected, not persisted)
  systemPromptAppendix: [],  // prompt appendix entries (agent-managed)
  skillPromptCache: null,    // skill overview cache (runtime only)
  lastMemoryMessageId: null, // memory progress pointer (persisted)
  todoList: [],              // todos (managed via *_todo_item tools)
  autoReplyConfig: null,     // idle auto-reply configuration
  status: "active"           // active | deleted; compute status lives in runtime_state
}
```

**Compute status** (`runtime/runtime_state.js`) is separate from persisted state:

| Status | Meaning |
|--------|---------|
| `idle` | Idle, waiting for messages |
| `waiting_llm` | LLM request in flight |
| `processing` | Processing a message or executing tools |
| `terminated` | Terminated |

## Organization

The organization is not a standalone object but the role tree + agent set, persisted as a whole at `<dataDir>/org/org.json`:

- `OrgPrimitives` provides role/agent create/query, termination recording, and parent-child chain maintenance;
- Trees may reach any depth; agents creating sub-roles and sub-agents is the fundamental self-organization primitive (`create_role`, `spawn_agent_with_task`);
- Deletion **cascades**: deleting a role deletes all agents under it plus their sub-roles/sub-agents.

## User Endpoint and Root

`AgentSociety.init()` registers two special agents:

- **user** (id=`"user"`): the endpoint agent representing you. It only handles messages `to="user"`; on receipt it enters the user inbox and notifies listeners. Messages you send go **directly to the target agent** — no relaying through the user endpoint;
- **root**: the entry agent, system prompt from `config/prompts/root.txt`. The hard constraint "one requirement, one direct sub-agent" is written into that prompt — Root creates exactly 1 direct role + 1 requirement owner per requirement.

## Message

The envelope on the message bus:

```javascript
{
  id: "msg-uuid",
  to: "agent-id",            // recipient agent
  from: "sender-id",         // sender (agent id, "user", module name, …)
  taskId: "task-uuid",       // associated task (optional)
  payload: {                 // payload
    text: "…",
    message_type: "task_assignment" | "introduction" | "collaboration_*"
                 | "status_report" | …,
    …                        // structured fields per message_type
  },
  createdAt: "ISO timestamp"
}
```

- `message_type` validation: `utils/message/message_validator.js` checks payload structure against `VALID_MESSAGE_TYPES`;
- **Interruption**: if the target is busy, the new message enters its interruption queue and is injected at the next suitable boundary;
- **Delayed delivery**: `bus.send` supports delays; `MessageBus` sorts by `deliverAt` and delivers when due.

## Task and TaskBrief

- Every `submitRequirement` mints a `taskId` (UUID) bound to a workspace;
- Superior agents **must** provide a TaskBrief when spawning sub-agents (`utils/message/task_brief.js`):

```javascript
{
  objective: "goal description",     // required
  constraints: ["constraint 1"],     // required (array)
  inputs: "input notes",             // required
  outputs: "expected outputs",       // required
  completion_criteria: "done-when",  // required (camelCase accepted)
  collaborators: [ { agentId, role, description } ], // optional
  references: ["doc-ref"],           // optional
  priority: "high"                   // optional
}
```

`validateTaskBrief()` enforces required fields; `formatTaskBrief()` renders it into the sub-agent's context. This is the mechanism guaranteeing decomposition quality: without goal/constraints/acceptance criteria, the sub-agent cannot be created.

## Workspace

- Each task binds one workspace directory: `<workspacesDir>/<workspaceId>/`, created lazily;
- `WorkspaceManager` (singleton via `getWorkspaceManager()`): bind/assign, file I/O, directory listing, path safety (absolute paths and `..` rejected);
- `Workspace` instance: file ops + metadata persistence + MIME detection;
- Exposed to agents as the root for `file_*` tools; to browsers at `/workspace-files/<workspaceId>/<path>`.

## Organization Prompt (orgPrompt)

The organization prompt lives on a role: Root writes it when creating the first role; roles created beneath **inherit it by default**. It defines the organization's goal and division of labor, and pairs with the `org/<template>/org.md` template system.

## Knowledge Tree

Each agent may own a knowledge tree (`services/knowledge_tree/`):

- **Extraction**: once conversation volume crosses thresholds (message count / char count / interval, per `config/knowledge_tree.json`), an LLM extracts knowledge entries from the conversation;
- **Retrieval**: while processing messages, relevant entries are recalled into context (gated by `minConfidence`);
- **Maintenance**: an LLM periodically tidies the tree (merging, archiving stale entries).

## Memory Pointer & Incremental Processing

`agent.lastMemoryMessageId` marks where the memory system last processed, preventing duplicate summaries. Combined with `agent_memory`, conversations keep flowing while memory grows incrementally.

## Related Documents

- [Messaging & Scheduling](03-messaging-scheduling.md)
- [Workspace & File Services](06-workspace.md)
