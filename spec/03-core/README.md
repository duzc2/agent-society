# Agent Society 核心层设计

## 概述

核心层包含系统最核心的运行时组件，负责智能体生命周期管理、消息处理、工具执行和 LLM 交互。核心层的设计原则是：**稳定、高效、可测试**。

## 核心层职责

- **智能体管理**：创建、恢复、注册、查询、删除智能体
- **消息处理**：消息调度、处理循环、延迟投递、中断处理
- **工具执行**：工具定义、权限控制、调用执行
- **LLM 交互**：上下文构建、API 调用、错误重试、流式响应
- **状态维护**：运行时状态、运算状态、中断状态管理

## 设计约束

- **线程安全**：RuntimeState 必须保证多协程访问安全
- **异步优先**：所有 I/O 操作必须是异步的
- **资源限制**：并发数、LLM 调用频率必须可控
- **可恢复性**：系统崩溃后可以从持久化状态恢复

## 目录导航

| 文件 | 内容 |
|------|------|
| [01-runtime-overview.md](./01-runtime-overview.md) | Runtime 核心概述、子模块职责、数据流 |
| [02-message-bus.md](./02-message-bus.md) | Message Bus 消息总线、延迟消息 |
| [03-interruption.md](./03-interruption.md) | 插话机制、中断处理流程 |
| [04-compute-scheduler.md](./04-compute-scheduler.md) | ComputeScheduler 计算调度器 |
| [05-turn-engine.md](./05-turn-engine.md) | TurnEngine 回合引擎 |
| [06-agent-cancel-manager.md](./06-agent-cancel-manager.md) | AgentCancelManager 取消管理器 |
| [07-runtime-state.md](./07-runtime-state.md) | RuntimeState 运行时状态管理 |
| [08-context-builder.md](./08-context-builder.md) | ContextBuilder 上下文构建器 |
| [09-tool-system.md](./09-tool-system.md) | Tool System 工具系统 |
| [10-conversation.md](./10-conversation.md) | Conversation Manager 对话管理 |
| [11-error-handling.md](./11-error-handling.md) | 错误处理策略 |
| [12-performance.md](./12-performance.md) | 性能考虑 |

## 核心组件关系

```
┌─────────────────────────────────────────────────────────┐
│                        Runtime                          │
├─────────────┬─────────────┬─────────────┬───────────────┤
│RuntimeState │RuntimeEvents│RuntimeLifecycle│RuntimeTools │
├─────────────┴─────────────┴─────────────┴───────────────┤
│                   ComputeScheduler                      │
├─────────────────────────┬───────────────────────────────┤
│       TurnEngine        │      AgentCancelManager       │
├─────────────────────────┼───────────────────────────────┤
│       MessageBus        │      ConversationManager      │
└─────────────────────────┴───────────────────────────────┘
```
