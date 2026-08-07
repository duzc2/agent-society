# 系统结构

## 分层架构

系统采用四层架构：

**表现层（Presentation Layer）**
- HTTP Server：提供 REST API 接口
- 静态文件服务：Web 前端资源
- CORS 支持：允许浏览器跨域访问

**应用层（Application Layer）**
- AgentSociety：系统入口门面，协调各组件
- Runtime：运行时核心，管理智能体生命周期
- Message Processor：消息处理和调度
- Turn Engine：回合制处理引擎

**领域层（Domain Layer）**
- Agent：智能体实体
- Role：岗位定义
- Message：消息实体
- Organization：组织结构
- Task：任务实体

**服务层（Service Layer）**
- Config Service：通用配置管理
- LLM Service：大语言模型调用
- Conversation Service：对话历史管理
- Workspace Service：工作空间文件管理
- Skill Learning Service：技能学习管理

**基础设施层（Infrastructure Layer）**
- 文件系统访问
- 进程管理（代码执行）
- 浏览器自动化（Playwright）
- HTTP 客户端

## 核心组件关系

**AgentSociety 与 Runtime 的关系**
AgentSociety 是用户交互的门面，负责：
- 初始化系统
- 注册用户端点智能体
- 提供简洁的 API（submit_requirement、send_text_to_agent）
- 协调 Runtime 和 HTTP Server

Runtime 是核心引擎，负责：
- 智能体生命周期管理
- 消息总线
- 工具执行
- LLM 调用

**Runtime 内部模块划分**

Runtime 采用模块化设计，各子模块职责清晰：

- **RuntimeState**：状态管理。维护智能体注册表、运算状态、插话队列等。提供线程安全的状态访问。

- **RuntimeEvents**：事件系统。管理工具调用、错误、LLM 重试等事件的发布和订阅。

- **RuntimeLifecycle**：生命周期管理。处理智能体创建、恢复、注册、查询、中断等操作。

- **RuntimeMessaging**：消息处理。实现消息调度、处理循环、插话机制、并发控制。

- **RuntimeTools**：工具管理。维护工具定义、工具组权限、工具调用执行。

- **RuntimeLlm**：LLM 交互。处理 LLM 调用、上下文构建、错误重试、中断处理。

- **MessageBus**：消息总线。实现按收件人队列、延迟消息、中断通知。

- **OrgPrimitives**：组织原语。管理岗位创建删除、智能体组织关系、组织树构建。

## 数据流转

**消息发送流程**
1. 调用方调用 `runtime.send_message()`
2. MessageBus 检查目标智能体状态
3. 如果目标正在处理且非延迟消息，触发中断
4. 消息加入目标智能体的队列
5. 如果有等待中的消息处理器，唤醒它
6. 消息持久化到文件

**消息处理流程**
1. MessageProcessor 轮询各智能体队列
2. 获取到消息后，检查智能体状态
3. 如果智能体空闲，开始处理
4. 设置智能体状态为 COMPUTING
5. 调用智能体的 behavior 函数
6. behavior 内部可能调用工具、请求 LLM
7. 处理完成后，状态恢复为 IDLE
8. 如果队列中还有消息，继续处理

**智能体创建流程**
1. 父智能体调用 `create_role` 或 `spawn_agent_with_task` 工具
2. ToolExecutor 验证权限
3. RuntimeLifecycle 创建智能体实例
4. OrgPrimitives 注册组织关系
5. 如果指定了任务，发送初始消息
6. 智能体状态持久化
