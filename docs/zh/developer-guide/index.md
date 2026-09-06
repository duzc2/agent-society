# Agent Society 开发者文档（中文）

> 版本基准：文档基于当前 `main` 分支代码编写

本套文档面向**开发者**：理解系统架构、阅读代码、开发扩展模块、参与贡献。

如果你只是想使用 Agent Society，请阅读 [用户文档](../user-guide/index.md)。

## 目录

### 理解系统

1. [架构总览](01-architecture.md) — 分层模型、核心流程、目录结构导览
2. [核心概念与数据模型](02-concepts.md) — Agent、Role、Task、Message、Workspace 的实现细节
3. [消息与调度](03-messaging-scheduling.md) — MessageBus、消息循环、回合引擎、计算调度器

### 服务层

4. [LLM 服务层](04-llm-services.md) — 客户端、注册表、选模器、并发控制、重试
5. [会话与上下文](05-conversation.md) — 会话管理、自动压缩、上下文阈值
6. [工作区与文件服务](06-workspace.md) — 工作区管理、文件访问授权、HTTP 文件服务

### 扩展开发

7. [HTTP API 参考](07-http-api.md) — 全部 REST 端点速查
8. [模块开发指南](08-module-development.md) — 模块接口契约、工具注册、Web 面板、路由
9. [工具系统](09-tools.md) — 68 个内置工具速查、工具组机制
10. [Proc 消息协议](10-proc-protocol.md) — 进程消息协议规范摘要

### 工程实践

11. [测试指南](11-testing.md) — 测试体系、运行方式、编写规范
12. [构建与发布](12-build-release.md) — Web 构建、exe 打包、安装包、桌面启动器
13. [提示词工程](13-prompts.md) — 系统提示词模板体系与组织模板
14. [开发规范](14-coding-standards.md) — 代码组织、异常处理、注释、测试约定

## 阅读路径建议

- **第一次接触代码**：[架构总览](01-architecture.md) → [核心概念](02-concepts.md) → 对照源码浏览 `src/platform/`
- **想写一个扩展模块**：[模块开发指南](08-module-development.md) → 参考 `modules/localcmd/` 与 `modules/chrome/` 现有实现
- **想调试/排查问题**：[测试指南](11-testing.md) → [数据与目录结构](../user-guide/10-data-directories.md)（日志位置）
- **想做前端**：[架构总览](01-architecture.md) 的 Web 前端节 → `web/v3/src/` 源码 → [HTTP API 参考](07-http-api.md)

## 扩展点总览

系统提供五个官方扩展点，设计细节见对应章节：

| 扩展点 | 能力 | 章节 |
|--------|------|------|
| **模块（Module）** | 工具组 + Web 面板 + HTTP 路由，动态加载/懒加载 | [模块开发指南](08-module-development.md) |
| **内置工具** | 在既有工具域中新增工具，或注册新工具域 | [工具系统](09-tools.md) |
| **Proc 协议** | 让外部进程接入消息通道与 HTTP 桥 | [Proc 消息协议](10-proc-protocol.md) |
| **声明式 DI（ModuleRegistry）** | 模块间/模块与服务间的服务交换，拓扑序初始化 | [模块开发指南](08-module-development.md) |
| **组织模板** | 以 `org/<模板名>/org.md` 定制组织生成方式 | [提示词工程](13-prompts.md) |

选择原则：给智能体加操作能力 → 模块；给系统加数据/流程能力 → 内置工具；让外部程序进入协作 → Proc 协议；定义一套团队结构 → 组织模板。

## 关键源码入口

| 想了解 | 看这里 |
|--------|--------|
| 系统入口与用户接口 | `src/platform/core/agent_society.js` |
| 运行时协调器 | `src/platform/core/runtime.js` |
| 消息总线 | `src/platform/core/message_bus.js` |
| 组织原语（岗位/智能体持久化） | `src/platform/core/org_primitives.js` |
| 声明式模块注册（DI） | `src/platform/core/module_registry.js` |
| 全部服务 | `src/platform/services/`（每个子目录有同名 `.md` 说明） |
| Runtime 子模块 | `src/platform/runtime/` |
| 模块加载器 | `src/platform/extensions/module_loader.js` |
| 工具 schema | `src/platform/runtime/tools_schema.js` 及 `tools_*.js` |
