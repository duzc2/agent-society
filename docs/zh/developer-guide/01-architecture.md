# 架构总览

## 系统定位

Agent Society 是一个自组织多智能体协作平台。设计目标是：**系统只提供智能体运行的最基本元能力，不提供任何业务能力**——组织如何建立、任务如何分配、结果如何交付，全部由智能体自主决策。

## 分层模型

```
┌─────────────────────────────────────────────────────────┐
│  客户端层    web/v3 (Vue 3 桌面端)   web/mobile (移动端)   │
├─────────────────────────────────────────────────────────┤
│  HTTP 层     src/platform/services/http/                │
│              Hono 应用：REST API + 静态服务 + 心跳通道     │
├─────────────────────────────────────────────────────────┤
│  入口层      core/agent_society.js                      │
│              面向用户的系统入口：init/submitRequirement/   │
│              sendTextToAgent/优雅关闭                     │
├─────────────────────────────────────────────────────────┤
│  协调层      core/runtime.js（协调器，只协调不实现）       │
│  ├─ runtime/ 子模块：状态、事件、生命周期、消息循环、       │
│  │  工具、LLM、回合引擎、调度器、关闭管理……               │
├─────────────────────────────────────────────────────────┤
│  服务层      services/ （独立功能域，可独立测试）          │
│  │  llm/ conversation/ workspace/ group_chat/ skills/    │
│  │  agent_memory/ knowledge_tree/ heartbeat/ mood/       │
│  │  org_templates/ proc_messaging/ process_events/ …     │
├─────────────────────────────────────────────────────────┤
│  基础层      core/message_bus.js（异步消息总线）           │
│              core/org_primitives.js（岗位/智能体持久化）   │
│              core/module_registry.js（声明式 DI 容器）     │
├─────────────────────────────────────────────────────────┤
│  扩展层      extensions/module_loader.js（加载 modules/） │
│              extensions/tool_group_manager.js（工具组）    │
├─────────────────────────────────────────────────────────┤
│  工具层      utils/（message、content、config、logger、  │
│              process、validate_params 等纯工具）          │
└─────────────────────────────────────────────────────────┘
        ▲
        │ 动态加载
┌───────┴─────────────────────────────────────────────────┐
│  模块层     modules/ chrome·localcmd·ssh·ui_page·…      │
└─────────────────────────────────────────────────────────┘
```

## 目录结构

```
src/
├── agents/
│   └── agent.js                 # Agent 实例类：岗位信息 + 消息处理入口
└── platform/
    ├── core/                    # 核心：不可替换
    │   ├── agent_society.js     #   系统入口
    │   ├── runtime.js           #   运行时协调器
    │   ├── message_bus.js       #   异步消息总线
    │   ├── org_primitives.js    #   岗位/智能体元数据与持久化
    │   ├── org_routes.js        #   组织相关 HTTP 路由（挂载）
    │   ├── org_validation.js    #   组织数据校验
    │   └── module_registry.js   #   声明式模块初始化（DI）
    ├── services/                # 服务：独立功能域
    │   ├── llm/                 #   LLM 客户端、注册表、选模、并发、重试、截断…
    │   ├── conversation/        #   会话管理、自动压缩、工具调用对压缩
    │   ├── workspace/           #   工作区管理 + file_access（授权/审计）
    │   ├── http/                #   HTTP 服务器（http_server/ 按域拆分路由）
    │   ├── group_chat/          #   群聊服务
    │   ├── skills/              #   技能服务（custom/git 仓库、绑定、运行时）
    │   ├── agent_memory/        #   向量记忆
    │   ├── knowledge_tree/      #   知识树（抽取/检索/维护）
    │   ├── heartbeat/           #   心跳广播队列
    │   ├── mood/                #   心情颜色
    │   ├── org_templates/       #   组织模板仓库
    │   ├── proc_messaging/      #   进程消息协议（hub/channel/bridge）
    │   └── process_events/      #   进程事件推送
    ├── runtime/                 # Runtime 子模块（约 30 个文件）
    │   ├── runtime_state.js     #   状态：注册表、运算状态、插话队列
    │   ├── runtime_events.js    #   事件发布订阅
    │   ├── runtime_lifecycle.js #   智能体生命周期
    │   ├── runtime_messaging.js #   消息处理循环
    │   ├── runtime_tools.js     #   工具注册与调度
    │   ├── runtime_llm.js       #   LLM 交互循环
    │   ├── turn_engine.js       #   回合引擎（协程式状态机）
    │   ├── compute_scheduler.js #   计算调度器（round-robin 时间片）
    │   ├── tools_schema.js      #   内置工具 schema 总装
    │   ├── tools_agent.js       #   组织/智能体工具实现
    │   ├── tools_file.js        #   文件工具实现
    │   ├── javascript_executor.js        # JS 沙箱执行器
    │   ├── javascript_executor_worker.js # vm + Worker 沙箱线程
    │   ├── bootstrap_manager.js #   初始化流程
    │   ├── shutdown_manager.js  #   优雅关闭
    │   └── …
    ├── extensions/
    │   ├── module_loader.js     # 加载 modules/ 下的模块
    │   └── tool_group_manager.js# 工具组注册与合并
    ├── utils/                   # 纯工具（message/content/config/logger/process）
    └── prompt_loader.js         # 系统提示词装载与组装
```

每个目录配有同名 `.md` 说明文件（目录综述/文件列表/子目录列表），阅读源码前先看它。

## 核心流程

### 启动流程

```
start.cmd / start.sh
  └─▶ start-wrapper.mjs        # 最早的错误捕获 + boot.log
      └─▶ start.js             # 解析参数 → Config.loadApp()
          └─▶ AgentSociety.init()
              ├─▶ Runtime.init()          # BootstrapManager：
              │     加载配置 → Logger → MessageBus → OrgPrimitives
              │     → LlmServiceRegistry → WorkspaceManager
              │     → ConversationManager → ModuleRegistry.ensureReady()
              │     → ModuleLoader.loadModules() → 工具组注册
              ├─▶ 注册 user 端点智能体（id="user"）
              ├─▶ 注册 Root 智能体（读 config/prompts/root.txt）
              ├─▶ 启动 HTTP 服务器（Hono）
              ├─▶ setupGracefulShutdown()  # SIGINT/SIGTERM
              ├─▶ AutoReplyManager.start()
              └─▶ Runtime.startProcessing() # 消息循环启动
```

### 消息处理流程

```
用户/智能体/进程 发消息
  └─▶ bus.send(to, from, payload, taskId)
      └─▶ MessageBus 按 to 入队
          └─▶ RuntimeMessaging 消息循环（生产者-消费者）
              ├─ 并发控制：不同智能体并行，同一智能体串行
              ├─ 插话队列：处理中收到的消息进入插话通道
              └─▶ TurnEngine：抽象为 Turn（回合）
                  ├─ step() 返回原子动作：need_llm / need_tool / send / done
                  ├─ need_llm → RuntimeLlm：构建上下文（系统提示词+
                  │             岗位提示词+工作区指南+任务+记忆召回）
                  │             → LlmClient.chat() → 解析工具调用/回复
                  ├─ need_tool → ToolExecutor 执行 → 结果写回会话
                  └─ send → bus.send(...)  # 可能发给 user 或其他智能体
```

### 工具调用链

```
LLM 返回 tool_calls
  └─▶ ToolExecutor.executeToolCall(ctx, name, args)
      ├─ 内置工具 → runtime/tools_*.js 中的实现（组织、文件、技能、群聊…）
      ├─ run_javascript → JavaScriptExecutor（Worker + vm 沙箱）
      └─ 模块工具 → ModuleLoader.executeToolCall()
          └─▶ modules/<name>/index.js 的 executeToolCall(ctx, name, args)
```

### 关闭流程

```
SIGINT/SIGTERM
  └─▶ ShutdownManager
      ├─ 停止接收新消息
      ├─ 等待活跃消息处理完成（带超时）
      ├─ 持久化组织状态（org.json）
      ├─ 持久化会话历史
      └─▶ CleanupHookChain：6 阶段清理钩子（资源注册表逐项释放：
          浏览器、子进程、记忆实例……按所属智能体级联清理）
```

## 关键设计决策

| 决策 | 理由 |
|------|------|
| Runtime 只协调不实现 | 具体功能全部下沉到子模块/服务，Runtime 保持薄，避免 5000 行巨类 |
| 声明式 DI（ModuleRegistry） | 模块用 `declare({requires, provides, init})` 声明依赖，注册表按依赖拓扑自动初始化；死依赖/循环依赖在 validate 阶段报错 |
| 消息单写者 | 同一智能体的会话历史只允许 TurnEngine 写，杜绝并发写乱序 |
| 回合引擎协程式 | step() 无阻塞，长操作"启动异步→完成回调入队"，调度器每轮让出事件循环 |
| 工具组权限模型 | 岗位级工具白名单，智能体只能看到/调用组内工具 |
| 文件 ≤ 500 行（不含注释） | 强制模块化，高内聚低耦合 |
| 空值纪律 | 注入的功能组件禁止空值兼容（直接报错暴露 bug）；仅外部数据允许容错 |
| 全局异常必须日志 | 任何 catch 必须输出 message + stack + 业务上下文，禁止静默吞异常 |

## Web 前端

```
web/
├── index.html          # 入口：按设备跳转 v3 或 mobile
├── v3/                 # 桌面端（Vue 3 + Vite + Pinia + PrimeVue + Tailwind 4）
│   └── src/
│       ├── components/ # 按域组织：chat/ agent/ artifacts/ skills/ modules/
│       │               #        settings/ overview/ file-viewer/ file-diff/ …
│       ├── services/   # API 封装（api.ts、configApi.ts、skillApi.ts…）
│       ├── stores/     # Pinia：app/ chat/ agent/ org/ guide
│       └── types/ utils/
└── mobile/             # 移动端（同构栈）
```

- 构建产物在各 `dist/`，由 HTTP 服务以静态文件形式提供（`/web/v3/dist/index.html`）；
- 实时更新走心跳：前端定时 `POST /api/heartbeat` 携带 `lastMessageId`，服务端 drain 出增量消息/事件。

## 相关文档

- [核心概念与数据模型](02-concepts.md)
- [消息与调度](03-messaging-scheduling.md)
- `src/platform/platform.md`、`core/core.md`、`runtime/runtime.md`（源码内置说明）
