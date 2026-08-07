# 服务初始化顺序

服务层各服务有依赖关系，必须按顺序初始化：

1. **Config Service**：最先初始化，其他服务需要读取配置
2. **LLM Service**：依赖 Config Service 读取 LLM 配置
3. **LLM-Modules Launcher**：如果使用本地 Embedding，先启动服务
4. **Conversation Service**：依赖 Config Service
5. **Workspace Service**：依赖 Config Service
6. **Skill Learning Service**：依赖 Config Service
7. **Agent Memory Service**：依赖 Config Service、LLM Service 和 LLM-Modules Launcher
8. **Content Router Service**：依赖 LLM Service

初始化后，各服务注册到 Runtime，核心层通过 Runtime 访问服务。

## 依赖关系图

```
Config Service
    │
    ├──> LLM Service
    │       │
    │       ├──> LLM-Modules Launcher (可选)
    │       │
    │       ├──> Agent Memory Service
    │       │
    │       └──> Content Router Service
    │
    ├──> Conversation Service
    │
    ├──> Workspace Service
    │
    ├──> Skill Learning Service
    │
    └──> Agent Memory Service
```

## 初始化阶段

| 阶段 | 服务 | 说明 |
|------|------|------|
| 1 | Config Service | 基础配置，所有服务的依赖 |
| 2 | LLM Service | 需要配置来确定 LLM 端点 |
| 3 | LLM-Modules Launcher | 本地 Embedding 服务（如需要）|
| 4 | Conversation/Workspace/Skill | 独立的基础服务 |
| 5 | Agent Memory | 依赖 LLM 和可选的本地服务 |
| 6 | Content Router | 依赖 LLM 服务 |
