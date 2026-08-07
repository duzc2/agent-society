# Agent Society 服务层设计

## 1. 服务层概述

服务层是系统的支撑层，提供通用的基础设施能力，被核心层和各模块使用。服务层的设计原则是：通用、可复用、与业务解耦。

### 1.1 服务层职责

服务层包含以下服务：
- **Config Service**：通用配置管理
- **LLM Service**：大语言模型调用
- **Conversation Service**：对话历史管理
- **Workspace Service**：工作空间文件管理
### 1.2 设计原则

**服务自治**
每个服务是独立的模块，有自己的职责和接口。服务之间不直接依赖，通过 Runtime 协调。

**通用接口**
服务提供的接口应该是通用的，不针对特定业务场景。例如 Config Service 提供 `get(file, key)`，而不是 `get_llm_config()`。

**配置驱动**
服务的行为可以通过配置调整，如 LLM 的超时时间、工作空间的大小限制等。

---

## 目录导航

| 文件 | 服务 | 说明 |
|------|------|------|
| [01-config.md](./01-config.md) | Config Service | 通用配置管理服务 |
| [02-llm.md](./02-llm.md) | LLM Service | 大语言模型调用服务 |
| [03-llm-modules-launcher.md](./03-llm-modules-launcher.md) | LLM-Modules Launcher | 本地 Embedding 服务启动器 |
| [04-conversation.md](./04-conversation.md) | Conversation Service | 对话历史管理服务 |
| [05-agent-memory.md](./05-agent-memory.md) | Agent Memory Service | 智能体长期记忆服务 |
| [06-content-router.md](./06-content-router.md) | Content Router Service | 多模态内容路由服务 |
| [07-workspace.md](./07-workspace.md) | Workspace Service | 工作空间文件管理服务 |
| [10-initialization-order.md](./10-initialization-order.md) | - | 服务初始化顺序说明 |
