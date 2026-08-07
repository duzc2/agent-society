# src

## 综述
该目录存放项目的 Node.js 源码。

本目录按职责拆分为两个子目录：
- agents/：智能体实例与行为定义。
- platform/：运行时、消息、工件、配置、模块加载与 HTTP 服务等平台基础设施。

本目录本层级仅包含本说明文档，不包含可执行入口文件。

## 文件列表
- src.md: 功能：本目录说明文档。责任：描述本目录的综述、文件列表与子目录列表。内部结构：包含“综述 / 文件列表 / 子目录列表”。

## 子目录列表
- agents: 功能：智能体实例与行为相关实现。责任：提供智能体对象与示例行为构造函数，供平台运行时创建与调度。内部结构：以 agent.js 与 behaviors.js 为核心，并包含目录说明文档。（详见 agents/agents.md）
- platform: 功能：平台核心实现。责任：提供 AgentSociety/Runtime、消息通道、组织原语、LLM 交互、工件与工作空间管理、模块系统与 HTTP API。内部结构：直接文件提供平台服务实现；core/ 与 runtime/ 包含核心实现代码；services/、utils/、extensions/ 为功能分组说明文档。（详见 platform/platform.md）
