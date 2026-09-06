# 核心概念与数据模型

本篇给出关键领域对象的实现细节与持久化格式。源码参照：`src/platform/core/org_primitives.js`、`src/agents/agent.js`、`src/platform/core/message_bus.js`。

## Role（岗位）

岗位是角色定义，不绑定具体执行者。同岗位可挂多个智能体。

```javascript
{
  id: "role-uuid",           // 岗位 ID
  name: "前端工程师",         // 岗位名（可按名查找 find_role_by_name）
  rolePrompt: "…",           // 岗位职责提示词（同岗位智能体共享）
  orgPrompt: "…",            // 组织架构提示词（仅 root 用；下级岗位继承）
  toolGroups: ["chrome"],    // 工具组白名单；null/undefined = 全部
  skillBindings: [           // 技能绑定
    { skillId: "custom:custom:xxx", enabled: true }
  ],
  parentId: null,            // 父岗位（构成岗位树）
  createdBy: "agent-id",     // 创建者智能体
  status: "active"           // active | deleted（软删除）
}
```

校验逻辑在 `org_primitives.js` 顶部的 `validateRole()`：id/name/rolePrompt 必填，toolGroups 必须是字符串数组或 null，skillBindings 条目必须含 skillId 与 enabled。

## Agent（智能体）

`src/agents/agent.js` 定义实例结构，运行时注册表与持久化状态共同描述一个智能体：

```javascript
{
  id: "agent-uuid",
  roleId: "role-uuid",       // 所属岗位
  roleName: "前端工程师",
  rolePrompt: "…",           // 创建时从岗位快照
  name: null,                // 智能体名（可自定义）
  behavior: Function,        // 消息处理入口（运行时注入，不持久化）
  systemPromptAppendix: [],  // system prompt 附录条目（智能体自管理）
  skillPromptCache: null,    // 技能总览缓存（仅运行时）
  lastMemoryMessageId: null, // 记忆系统处理进度指针（持久化）
  todoList: [],              // 待办事项（工具 add/update/delete_todo_item 管理）
  autoReplyConfig: null,     // 空闲自动回复配置
  status: "active"           // active | deleted；运算状态另存 runtime_state
}
```

**运算状态**（`runtime/runtime_state.js`）独立于持久化状态：

| 状态 | 含义 |
|------|------|
| `idle` | 空闲，等待消息 |
| `waiting_llm` | 已发起 LLM 请求，等待响应 |
| `processing` | 正在处理消息或执行工具 |
| `terminated` | 已终止 |

## Organization（组织）

组织不是独立对象，而是岗位树 + 智能体集合，整体持久化在 `<dataDir>/org/org.json`：

- `OrgPrimitives` 提供创建/查询岗位与智能体、记录终止事件、父子链维护；
- 组织树支持任意深度；智能体创建子岗位与子智能体是最基本的自组织原语（`create_role`、`spawn_agent_with_task`）；
- 删除是**级联**的：删除岗位会级联删除该岗位下所有智能体及其创建的子岗位/子智能体。

## User 端点与 Root

`AgentSociety.init()` 注册两个特殊智能体：

- **user**（id=`"user"`）：代表用户的端点智能体。只处理 `to="user"` 的消息，收到即写入用户收件箱并通知监听器；用户发的消息**直接发送到目标智能体**，不经 user 端点转发；
- **root**：入口智能体，系统提示词来自 `config/prompts/root.txt`。硬约束"单需求单子智能体"写在该提示词中——Root 对每个需求只创建 1 个直属岗位 + 1 个需求负责人。

## Message（消息）

消息总线上的信封结构：

```javascript
{
  id: "msg-uuid",
  to: "agent-id",            // 收件智能体
  from: "sender-id",         // 发送者（智能体 id、"user"、模块名等）
  taskId: "task-uuid",       // 关联任务（可空）
  payload: {                 // 载荷
    text: "…",
    message_type: "task_assignment" | "introduction" | "collaboration_*"
                 | "status_report" | …,
    …                        // 各 message_type 有各自的结构化字段
  },
  createdAt: "ISO 时间"
}
```

- `message_type` 校验：`utils/message/message_validator.js` 按 `VALID_MESSAGE_TYPES` 校验载荷结构；
- **插话**（interruption）：目标智能体正在处理时，新消息进入插话队列，在当前回合的合适时机注入；
- **延迟投递**：`bus.send` 可带延迟，`MessageBus` 内部按 `deliverAt` 排序到期投递。

## Task 与 TaskBrief（任务委托书）

- 用户每次 `submitRequirement` 生成一个 `taskId`（UUID），绑定工作区；
- 上级创建子智能体时**必须**提供 TaskBrief（`utils/message/task_brief.js`）：

```javascript
{
  objective: "目标描述",          // 必填
  constraints: ["约束1"],        // 必填（数组）
  inputs: "输入说明",            // 必填
  outputs: "输出要求",           // 必填
  completion_criteria: "完成标准", // 必填（兼容 camelCase）
  collaborators: [ { agentId, role, description } ], // 可选
  references: ["doc-ref"],       // 可选
  priority: "high"               // 可选
}
```

`validateTaskBrief()` 校验必填字段，`formatTaskBrief()` 生成注入子智能体上下文的文本。这是任务分解质量的机制保证：不写清目标/约束/验收标准，子智能体创建不出来。

## Workspace（工作区）

- 每个任务绑定一个工作区目录：`<workspacesDir>/<workspaceId>/`，懒加载创建；
- `WorkspaceManager`（单例，`getWorkspaceManager()`）：绑定/分配工作区、文件读写、目录列举、路径安全校验（拒绝绝对路径与 `..`）；
- `Workspace` 实例：文件操作 + 元数据持久化 + MIME 检测；
- 工作区对智能体暴露为 `file_*` 系列工具的操作根；对浏览器暴露为 `/workspace-files/<workspaceId>/<path>` 静态服务。

## Organization Prompt（orgPrompt）

组织架构提示词记录在岗位上：Root 创建首个岗位时写入；该岗位创建下级岗位时**默认继承**。它定义整个组织的目标与分工原则，配合 `org/<模板名>/org.md` 模板体系使用。

## 知识树（Knowledge Tree）

每个智能体可拥有一棵知识树（`services/knowledge_tree/`）：

- **抽取**：对话累计达到阈值（消息数/字数/间隔，`config/knowledge_tree.json`）后，用 LLM 从对话抽取知识条目；
- **检索**：处理消息时按相关度召回知识注入上下文（`minConfidence` 控制）;
- **维护**：定期让 LLM 整理树结构（合并/归档过期条目）。

## 记忆指针与增量处理

`agent.lastMemoryMessageId` 记录记忆系统已处理到的消息位置，避免重复摘要。配合 `agent_memory` 服务实现"对话持续发生，记忆增量生长"。

## 相关文档

- [消息与调度](03-messaging-scheduling.md)
- [工作区与文件服务](06-workspace.md)
