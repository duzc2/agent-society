# Agent Society 开发者文档

本文档面向开发者，详细描述 Agent Society 的技术架构、模块设计和开发规范。

---

## 目录

- [架构概览](#架构概览)
- [模块组织](#模块组织)
- [核心模块](#核心模块)
- [服务模块](#服务模块)
- [Runtime 子模块](#runtime-子模块)
- [工具模块](#工具模块)
- [扩展模块](#扩展模块)
- [消息流转](#消息流转)
- [智能体生命周期](#智能体生命周期)
- [开发规范](#开发规范)

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        AgentSociety                             │
│                      (core/agent_society.js)                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ • submitRequirement()  - 提交需求                        │   │
│  │ • sendTextToAgent()    - 发送消息                        │   │
│  │ • waitForUserMessage() - 等待回复                        │   │
│  │ • onUserMessage()      - 注册回调                        │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ┌────────────────────── HTTPServer ───────────────────────┐   │
│  │              (services/http/http_server.js)             │   │
│  │ • /api/agents, /api/messages, /api/modules              │   │
│  │ • Static File Serving (Web UI, Workspaces)              │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                          Runtime                                │
│                      (core/runtime.js)                          │
│                                                                 │
│  ┌──────────────── 核心模块 (core/) ─────────────────┐         │
│  │  MessageBus   │ OrgPrimitives │                   │         │
│  │  (消息总线)    │  (组织原语)    │                   │         │
│  └───────────────────────────────────────────────────┘         │
│                                                                 │
│  ┌──────────────── 服务模块 (services/) ─────────────┐         │
│  │ • workspace/    - 工作区管理、文件操作、内容路由   │         │
│  │ • llm/          - LLM客户端、服务注册、模型选择    │         │
│  │ • conversation/ - 会话管理、上下文压缩            │         │
│  │ • http/         - HTTP服务器、HTTP客户端          │         │
│  │ • ui/           - UI命令代理                      │         │
│  │ • org_templates/- 组织模板存储                    │         │
│  └───────────────────────────────────────────────────┘         │
│                                                                 │
│  ┌──────────────── Runtime子模块 (runtime/) ─────────┐         │
│  │ • runtime_state.js           - 状态管理           │         │
│  │ • runtime_events.js          - 事件系统           │         │
│  │ • runtime_lifecycle.js       - 智能体生命周期     │         │
│  │ • runtime_messaging.js       - 消息处理循环       │         │
│  │ • runtime_tools.js           - 工具管理           │         │
│  │ • runtime_llm.js             - LLM交互            │         │
│  │ • agent_manager.js           - 智能体管理器       │         │
│  │ • agent_cancel_manager.js    - 智能体取消管理     │         │
│  │ • message_processor.js       - 消息处理器         │         │
│  │ • tool_executor.js           - 工具执行器         │         │
│  │ • llm_handler.js             - LLM处理器          │         │
│  │ • context_builder.js         - 上下文构建器       │         │
│  │ • turn_engine.js             - 回合引擎           │         │
│  │ • compute_scheduler.js       - 计算调度器         │         │
│  │ • javascript_executor.js     - JS执行器           │         │
│  │ • browser_javascript_executor.js - 浏览器JS执行器 │         │
│  │ • shutdown_manager.js        - 关闭管理器         │         │
│  └───────────────────────────────────────────────────┘         │
│                                                                 │
│  ┌──────────────── 工具模块 (utils/) ────────────────┐         │
│  │ • message/  - 消息格式化、验证、任务委托书         │         │
│  │ • content/  - 内容适配、能力路由                  │         │
│  │ • config/   - 配置加载、配置服务                  │         │
│  │ • logger/   - 日志系统                            │         │
│  └───────────────────────────────────────────────────┘         │
│                                                                 │
│  ┌──────────────── 扩展模块 (extensions/) ───────────┐         │
│  │ • module_loader.js      - 模块加载器              │         │
│  │ • tool_group_manager.js - 工具组管理器            │         │
│  └───────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Agent Instances                            │
│  ┌─────────┐                                                    │
│  │  User   │◄──────────────────────────────────────────────┐   │
│  │Endpoint │                                                │   │
│  └─────────┘                                                │   │
│       ▲                                                     │   │
│       │                                                     │   │
│  ┌─────────┐      ┌─────────┐      ┌─────────┐             │   │
│  │  Root   │─────▶│ Agent A │─────▶│ Agent C │─────────────┘   │
│  │         │      │         │      │         │                  │
│  └─────────┘      └─────────┘      └─────────┘                  │
│                         │                                       │
│                         ▼                                       │
│                   ┌─────────┐                                   │
│                   │ Agent B │                                   │
│                   │         │                                   │
│                   └─────────┘                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 模块组织

源码位于 `src/platform/`，按功能域分层组织：

```
src/platform/
├── core/           # 核心模块 - 系统基础，不可替换
├── services/       # 服务模块 - 独立功能，可独立测试
├── runtime/        # Runtime子模块 - Runtime职责拆分
├── utils/          # 工具模块 - 辅助功能，可复用
├── extensions/     # 扩展模块 - 可插拔扩展
├── localllm/       # 本地LLM工具
├── prompt_loader.js
└── index.js
```

### 设计原则

- **单一职责**：每个模块只负责一项功能
- **高内聚低耦合**：相关功能集中，模块间依赖最小化
- **代码行数限制**：每个文件不超过500行（不含注释）
- **目录层级限制**：不超过3层
- **向后兼容**：提供兼容性导出，保持API接口稳定

---

## 核心模块 (core/)

### AgentSociety (agent_society.js)

用户入口类，隐藏运行时与根智能体的构建细节。

**职责：**
- 初始化系统与运行时
- 提供用户交互接口
- 启动/停止 HTTP 服务器
- 管理用户端点智能体与根智能体

**关键方法：**
```javascript
async init()                    // 初始化系统
async submitRequirement(text)   // 提交需求
async sendTextToAgent(to, text) // 发送消息
async shutdown()                // 优雅关闭
```

### Runtime (runtime.js)

运行时核心，连接平台能力与智能体行为。作为协调器，将职责分散到各个子模块。

**职责：**
- 初始化和配置管理
- 协调各个服务模块
- 组合和管理 Runtime 子模块
- 提供统一的公共接口

### MessageBus (message_bus.js)

异步消息总线，实现智能体间通信。

**特性：**
- 按智能体 ID 隔离队列
- 支持消息排队与投递
- 提供 `waitForMessage` 和 `receiveNext` 接口

### OrgPrimitives (org_primitives.js)

组织构建原语，管理岗位与智能体实例的元数据。

**功能：**
- 创建/查询岗位 (Role)
- 创建智能体实例 (Agent)
- 维护父子链关系与层级结构
- 持久化组织状态

---

## 服务模块 (services/)

### 工作区服务 (workspace/)

- **workspace_manager.js** - 工作区生命周期管理
- **workspace.js** - 工作区实例，提供文件操作、元数据管理
- **content_router.js** - 内容路由，处理多模态内容、文件到提示词的转换

### LLM服务 (llm/)

- **llm_client.js** - LLM客户端，与LLM服务通信
- **llm_service_registry.js** - LLM服务注册表，管理多个LLM服务配置
- **model_selector.js** - 模型选择器，基于岗位提示词自动选择最匹配的LLM服务
- **concurrency_controller.js** - 并发控制器，保护LLM服务不被过载

### 会话服务 (conversation/)

- **conversation_manager.js** - 会话管理器，负责LLM对话历史的维护与优化
- **auto_compression_manager.js** - 自动压缩管理
- **auto_compression_config.js** - 自动压缩配置

### HTTP服务 (http/)

- **http_server.js** - HTTP服务器，提供REST API和静态资源服务
- **http_client.js** - HTTP客户端

### UI服务 (ui/)

- **ui_command_broker.js** - UI命令代理，处理前端命令

### 组织模板服务 (org_templates/)

- **org_template_repository.js** - 组织模板存储库

---

## Runtime 子模块 (runtime/)

### 状态管理 (runtime_state.js)

维护 Runtime 运行时状态：
- 智能体注册表 (agents)
- 运算状态 (computingAgents)
- 插话队列 (interruptionQueues)
- 最近错误 (recentErrors)
- 消息重试事件 (retryEvents)

### 事件系统 (runtime_events.js)

提供事件发布订阅机制：
- 工具调用事件
- LLM 调用事件
- 错误事件
- 生命周期事件

### 生命周期 (runtime_lifecycle.js)

管理智能体生命周期：
- 创建智能体
- 恢复智能体
- 注册/注销智能体
- 终止智能体
- 状态查询

### 消息循环 (runtime_messaging.js)

消息处理主循环：
- 消息调度
- 消息处理
- 插话处理
- 并发控制

### 工具管理 (runtime_tools.js)

工具注册与执行：
- 工具定义管理
- 工具组管理
- 工具权限检查
- 工具执行调度

### LLM交互 (runtime_llm.js)

LLM调用封装：
- 调用LLM
- 构建上下文
- 错误处理
- 结果解析

### 回合引擎 (turn_engine.js)

任务调度引擎：
- 管理智能体回合
- 调度任务执行
- 处理任务优先级

### 计算调度器 (compute_scheduler.js)

计算资源调度：
- 管理计算资源分配
- 调度计算任务

---

## 工具模块 (utils/)

### 消息工具 (message/)

- **message_formatter.js** - 消息格式化与附件辅助函数
- **message_validator.js** - 消息类型校验
- **task_brief.js** - TaskBrief 结构与格式化

### 内容工具 (content/)

- **content_adapter.js** - 将不支持的附件转换为文本描述
- **content_router.js** - 内容路由
- **content_type_utils.js** - 内容类型工具函数

### 配置工具 (config/)

- **config.js** - 读取并解析平台配置

### 日志工具 (logger/)

- **logger.js** - 日志系统，支持结构化日志与生命周期追踪

---

## 扩展模块 (extensions/)

### 模块加载器 (module_loader.js)

模块化系统的核心，负责加载外部扩展模块。

**功能：**
- 动态加载 `modules/` 目录下的插件
- 注册模块提供的工具 (Tools)
- 注册模块提供的 Web 组件
- 注册模块提供的 HTTP 路由

### 工具组管理器 (tool_group_manager.js)

- 注册内置工具组与动态工具组
- 维护工具名到工具组的映射
- 按工具组集合返回合并后的工具定义

---

## 消息流转

### 消息结构

```javascript
{
  id: "msg-uuid",           // 消息 ID
  to: "agent-id",           // 目标智能体
  from: "sender-id",        // 发送者智能体
  taskId: "task-uuid",      // 任务 ID
  payload: {                // 消息载荷
    text: "消息内容",
    message_type: "task_assignment",
    // ... 其他结构化数据
  }
}
```

### 任务委托书 (Task Brief)

标准化的任务分发载体：

```javascript
{
  objective: "目标描述",
  constraints: ["约束1", "约束2"],
  inputs: "输入说明",
  outputs: "输出要求",
  completion_criteria: "完成标准",
  collaborators: [
    { agentId: "agent-x", role: "reviewer", description: "代码审查人" }
  ],
  references: ["doc-ref-1"],
  priority: "high"
}
```

---

## 智能体生命周期

### 状态定义

- `idle` - 空闲，等待消息
- `waiting_llm` - 已发起 LLM 请求，正在等待响应
- `processing` - 正在处理消息或执行工具调用
- `terminated` - 已终止，不再处理消息

### 状态流转

```
        ┌─────────┐
        │  idle   │◄─────────────────┐
        └────┬────┘                  │
             │ receive message       │
             ▼                       │
        ┌─────────┐     LLM call     │
        │processing│───────────────►│waiting_llm│
        └────┬────┘◄─────────────────┘
             │ LLM response
             │
             ▼
        ┌─────────┐
        │terminated│
        └─────────┘
```

---

## 开发规范

### 代码组织

- 每个文件不超过 500 行（不含注释）
- 模块内部尽量不复制、使用领域对象
- 模块之间遵循最小知道原则
- 功能的所有代码应该集中在一个文件里

### 接口设计

- 先设计工作流程，再设计接口
- 从使用者角度设计接口
- 优先考虑模块之间的配合、工作流程、交接界面

### 错误处理

1. 遇到异常首先用编程语言最基本的方式打印日志
2. 维护现场保证异常不扩散
3. 在协议和 UI 传递友好的错误信息

### 测试规范

- 测试代码包含单元测试、集成测试、端到端测试
- 需要通信的多端工程需要测试通信协议
- 测试参数要满足多样性：合理参数、随机参数、错误参数、边界参数

### 注释规范

- 每个函数都要写注释
- 重点算法函数内也要写注释
- 代码的设计、需求背景、关键约束、关键保护点都要写在注释里

### 文件命名

- 源码中每个文件夹用一个单独的纯文本文件描述此文件夹的作用
- 文件名为 `[文件夹名.md]`

---

## 模块依赖关系

```
core/
├── agent_society.js
│   └─→ runtime.js
├── runtime.js
│   ├─→ message_bus.js
│   ├─→ org_primitives.js
│   ├─→ services/*
│   ├─→ runtime/*
│   ├─→ utils/*
│   └─→ extensions/*
├── message_bus.js
└── org_primitives.js

services/
├── workspace/
│   ├── workspace_manager.js
│   ├── workspace.js
│   └── content_router.js
├── llm/
│   ├── llm_client.js
│   ├── llm_service_registry.js
│   ├── model_selector.js
│   └── concurrency_controller.js
├── conversation/
│   └── conversation_manager.js
├── http/
│   ├── http_server.js
│   └── http_client.js

runtime/
├── runtime_state.js
├── runtime_events.js
├── runtime_lifecycle.js
├── runtime_messaging.js
├── runtime_tools.js
├── runtime_llm.js
├── agent_manager.js
├── agent_cancel_manager.js
├── message_processor.js
├── tool_executor.js
├── llm_handler.js
├── context_builder.js
├── turn_engine.js
├── compute_scheduler.js
├── javascript_executor.js
├── browser_javascript_executor.js
└── shutdown_manager.js

utils/
├── message/
│   ├── message_formatter.js
│   ├── message_validator.js
│   └── task_brief.js
├── content/
│   ├── content_adapter.js
│   ├── content_router.js
│   └── content_type_utils.js
├── config/
│   └── config.js
└── logger/
    └── logger.js

extensions/
├── module_loader.js
└── tool_group_manager.js
```

---

监控启动 .\start_monitor.cmd --include-terminate --procdump-path ".\tools\procdump\procdump64.exe"


---

## 相关文档

- [架构设计](./docs/architecture.md) - 更详细的架构说明
- [API 参考](./docs/api-reference.md) - 完整接口文档
- [配置说明](./docs/configuration.md) - 配置项详解
- [AGENTS.md](./AGENTS.md) - 项目规范和设计原则
