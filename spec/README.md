# Agent Society Python 版 SPEC 文档

## 文档概述

本文档集合定义了 Agent Society Python 版本的完整规范，包括架构设计、API 定义、模块规范、数据模型和部署指南。

## 文档结构

```
python-spec/
├── README.md                      # 本文档 - 索引和概述
├── 00-overview.md                 # 项目概述（快速开始）
├── 01-http-api.md                 # HTTP API 规范
├── 02-architecture/               # 架构设计
│   ├── README.md                  # 架构文档索引
│   ├── 01-design-principles.md    # 设计原则与核心概念
│   ├── 02-system-structure.md     # 系统架构
│   ├── 03-tech-decisions.md       # 关键技术决策
│   ├── 04-interruption.md         # 插话机制
│   ├── 05-memory.md               # 智能体记忆设计
│   ├── 06-extensibility.md        # 扩展性设计
│   ├── 07-state-management.md     # 状态管理
│   ├── 08-security.md             # 安全设计
│   ├── 09-performance.md          # 性能设计
│   ├── 10-deployment.md           # 部署架构
│   ├── 11-testing.md              # 测试策略
│   └── 12-dev-specs.md            # 开发规范
├── 03-core/                       # 核心层设计
│   ├── README.md                  # 核心层索引
│   ├── 01-runtime-overview.md     # Runtime 核心概述
│   ├── 02-message-bus.md          # 消息总线
│   ├── 03-interruption.md         # 插话机制
│   ├── 04-compute-scheduler.md    # 计算调度器
│   ├── 05-turn-engine.md          # 回合引擎
│   ├── 06-agent-cancel-manager.md # 取消管理器
│   ├── 07-runtime-state.md        # 运行时状态
│   ├── 08-context-builder.md      # 上下文构建器
│   ├── 09-tool-system.md          # 工具系统
│   ├── 10-conversation.md         # 对话管理
│   ├── 11-error-handling.md       # 错误处理
│   └── 12-performance.md          # 性能考虑
├── 04-services/                   # 服务层设计
│   ├── README.md                  # 服务层索引
│   ├── 01-config.md               # 配置服务
│   ├── 02-llm.md                  # LLM 服务
│   ├── 03-llm-modules-launcher.md # LLM-Modules 启动器
│   ├── 04-conversation.md         # 对话服务
│   ├── 05-agent-memory.md         # 智能体记忆服务
│   ├── 06-content-router.md       # 内容路由服务
│   ├── 07-workspace.md            # 工作空间服务
│   └── 10-initialization-order.md # 服务初始化顺序
├── 05-executors/                  # 执行器模块
│   ├── README.md                  # 执行器索引
│   ├── 01-tool-executor.md        # 工具执行器
│   ├── 02-python-executor.md      # Python 执行器
│   ├── 03-browser-executor.md     # 浏览器执行器
│   ├── 04-message-validator.md    # 消息验证器
│   ├── 05-memory-monitor.md       # 内存监控器
│   └── 06-execution-flow.md       # 执行流程示例
├── 06-persistence.md              # 持久化设计
└── 07-implementation-plan.md      # 实现计划
```

## 快速导航

### 对于架构师

1. [项目概述](00-overview.md) - 项目愿景、核心特性
2. [架构设计目录](02-architecture/) - 设计原则、系统架构、技术决策
3. [核心层目录](03-core/) - Runtime、MessageBus、插话机制

### 对于后端开发者

1. [HTTP API 规范](01-http-api.md) - REST API 完整定义
2. [核心层目录](03-core/) - Runtime、调度器、引擎
3. [服务层目录](04-services/) - 各服务实现
4. [执行器目录](05-executors/) - 工具执行器

### 对于运维人员

1. [部署架构](02-architecture/10-deployment.md) - 部署指南
2. [持久化设计](06-persistence.md) - 数据存储
3. [实现计划](07-implementation-plan.md) - 里程碑

## 不包含的功能

以下 Bun 版本中的功能在 Python 重写中**不实现**：

- **Model Selector（模型选择器）**：根据提示词自动选择 LLM 服务的功能。Python 版本直接使用配置的默认服务，简化架构。

## 技术栈

- **Python**: 3.11+
- **Web 框架**: FastAPI + Uvicorn
- **异步框架**: asyncio
- **数据验证**: Pydantic v2
- **LLM SDK**: OpenAI, Anthropic
- **浏览器自动化**: Playwright
- **测试**: pytest + pytest-asyncio

## HTTP API 兼容性保证

Python 版本保证与前端 Web 接口完全兼容：

- URL 路径完全一致
- 请求/响应格式一致
- HTTP 状态码使用一致
- 错误响应格式一致
