# Runtime 核心概述

## 1. 概述

核心层包含系统最核心的运行时组件，负责智能体生命周期管理、消息处理、工具执行和 LLM 交互。核心层的设计原则是：**稳定、高效、可测试**。

### 1.1 核心层职责

- **智能体管理**：创建、恢复、注册、查询、删除智能体
- **消息处理**：消息调度、处理循环、延迟投递、中断处理
- **工具执行**：工具定义、权限控制、调用执行
- **LLM 交互**：上下文构建、API 调用、错误重试、流式响应
- **状态维护**：运行时状态、运算状态、中断状态管理

### 1.2 设计约束

- **线程安全**：RuntimeState 必须保证多协程访问安全
- **异步优先**：所有 I/O 操作必须是异步的
- **资源限制**：并发数、LLM 调用频率必须可控
- **可恢复性**：系统崩溃后可以从持久化状态恢复

## 2. Runtime 类设计

Runtime 是系统的中央控制器，协调各个子模块。它本身不实现具体逻辑，而是委托给专门的子模块处理。

### 2.1 组合而非继承

Runtime 类使用组合模式，将不同职责委托给专门的子模块：
- **RuntimeState**：状态管理
- **RuntimeEvents**：事件系统
- **RuntimeLifecycle**：生命周期
- **RuntimeMessaging**：消息处理
- **RuntimeTools**：工具管理
- **RuntimeLlm**：LLM 交互

这种方式的优势：
- 职责清晰，每个子模块只关注一件事
- 易于测试，可以单独测试子模块
- 易于替换，可以替换某个子模块而不影响其他部分

### 2.2 子模块职责

#### RuntimeState（状态管理）

维护系统运行时的各种状态，使用锁保证线程安全。

管理的状态包括：
- `_agents`：智能体注册表，agent_id -> Agent 对象
- `_agentQueues`：消息队列映射，agent_id -> List[Message]
- `_activeProcessingAgents`：正在活跃处理的智能体集合
- `_interruptionQueues`：插话队列映射，agent_id -> List[Message]
- `_agentComputeStatus`：智能体计算状态映射
- `_conversations`：对话历史映射

#### RuntimeEvents（事件系统）

提供事件的发布和订阅机制，用于模块间通信。

事件类型：
- `on_tool_call`：工具调用前后
- `on_tool_error`：工具执行出错
- `on_llm_retry`：LLM 调用重试
- `on_error`：其他错误

#### RuntimeLifecycle（生命周期）

处理智能体的创建、恢复、注册、查询、中断、删除等操作。

#### RuntimeMessaging（消息处理）

实现消息调度、处理循环、并发控制。

**调度策略**

采用"轮询+事件驱动"混合策略：
- 每个智能体有独立的消息队列
- 后台协程轮询所有队列，找到有待处理消息且空闲的智能体
- 开始处理后，该智能体进入"处理中"状态
- 处理完成（无论成功失败），检查队列是否还有消息

**并发控制**

使用 `asyncio.Semaphore` 限制并发处理数（默认 50）：
- 达到限制时，新消息等待
- 消息处理是异步的，不会阻塞发送方

#### RuntimeTools（工具管理）

维护工具定义、工具组权限、工具调用执行。

#### RuntimeLlm（LLM 交互）

处理 LLM API 调用、上下文构建、错误重试、中断处理。

### 2.3 核心数据流

#### 智能体发送消息

```
send_message() -> MessageBus.send() -> 加入队列 -> 触发调度
```

#### 智能体处理消息

```
调度器发现待处理消息 -> ComputeScheduler 调度 -> TurnEngine 推进 -> 
step() 返回 need_llm -> 调用 LLM -> 返回结果 -> 继续下一步
```

#### 工具调用

```
智能体调用工具 -> runtime.executeToolCall() -> 验证权限 -> 查找工具 -> 
执行处理函数 -> 返回结果 -> TurnEngine.onToolResult()
```

## 3. 状态分类

### 3.1 运行时状态（内存）

- 智能体实例
- 消息队列
- `_activeProcessingAgents` 集合
- `_interruptionQueues` 映射
- semaphore

### 3.2 持久化状态（文件）

- 智能体元数据
- 组织关系
- 消息历史
- 对话历史

### 3.3 配置状态（文件）

- 应用配置
- LLM 服务配置

## 4. 启动恢复流程

1. 加载组织关系（org.json）
2. 遍历 agents/ 目录，加载每个智能体的元数据
3. 恢复消息队列（从 JSON Lines 文件）
4. 恢复对话历史

恢复时机：系统启动时自动恢复，不需要手动触发。
