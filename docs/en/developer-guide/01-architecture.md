# Architecture Overview

## System Positioning

Agent Society is a self-organizing multi-agent collaboration platform. Its design goal: **the system provides only the most basic meta-capabilities for agents to run — no business capabilities**. How organizations form, how tasks are assigned, and how results are delivered are all decided autonomously by agents.

## Layered Model

```
┌─────────────────────────────────────────────────────────┐
│  Client      web/v3 (Vue 3 desktop)   web/mobile        │
├─────────────────────────────────────────────────────────┤
│  HTTP        src/platform/services/http/                │
│              Hono app: REST API + static + heartbeat    │
├─────────────────────────────────────────────────────────┤
│  Entry       core/agent_society.js                      │
│              init / submitRequirement / sendTextToAgent │
│              / graceful shutdown                        │
├─────────────────────────────────────────────────────────┤
│  Coordination  core/runtime.js (coordinator only)       │
│  ├─ runtime/ submodules: state, events, lifecycle,      │
│  │  message loop, tools, LLM, turn engine, scheduler…   │
├─────────────────────────────────────────────────────────┤
│  Services    services/ (independent domains, testable)  │
│  │  llm/ conversation/ workspace/ group_chat/ skills/   │
│  │  agent_memory/ knowledge_tree/ heartbeat/ mood/      │
│  │  org_templates/ proc_messaging/ process_events/ …    │
├─────────────────────────────────────────────────────────┤
│  Foundation  core/message_bus.js (async message bus)    │
│              core/org_primitives.js (role/agent persist)│
│              core/module_registry.js (declarative DI)   │
├─────────────────────────────────────────────────────────┤
│  Extension   extensions/module_loader.js (loads modules)│
│              extensions/tool_group_manager.js (groups)  │
├─────────────────────────────────────────────────────────┤
│  Utilities   utils/ (message, content, config, logger,  │
│              process, validate_params — pure helpers)   │
└─────────────────────────────────────────────────────────┘
        ▲
        │ dynamic loading
┌───────┴─────────────────────────────────────────────────┐
│  Modules    modules/ chrome·localcmd·ssh·ui_page·…      │
└─────────────────────────────────────────────────────────┘
```

## Directory Structure

```
src/
├── agents/
│   └── agent.js                 # Agent instance class: role info + message entry
└── platform/
    ├── core/                    # Core: irreplaceable
    │   ├── agent_society.js     #   System entry
    │   ├── runtime.js           #   Runtime coordinator
    │   ├── message_bus.js       #   Async message bus
    │   ├── org_primitives.js    #   Role/agent metadata & persistence
    │   ├── org_routes.js        #   Organization HTTP routes (mounted)
    │   ├── org_validation.js    #   Organization data validation
    │   └── module_registry.js   #   Declarative module init (DI)
    ├── services/                # Services: independent domains
    │   ├── llm/                 #   LLM client, registry, selector, concurrency…
    │   ├── conversation/        #   Conversation mgmt, auto-compression
    │   ├── workspace/           #   Workspace mgmt + file_access (auth/audit)
    │   ├── http/                #   HTTP server (routes split by domain)
    │   ├── group_chat/          #   Group chat service
    │   ├── skills/              #   Skills (custom/git repos, bindings, runtime)
    │   ├── agent_memory/        #   Vector memory
    │   ├── knowledge_tree/      #   Knowledge tree (extract/retrieve/maintain)
    │   ├── heartbeat/           #   Heartbeat broadcast queue
    │   ├── mood/                #   Mood colors
    │   ├── org_templates/       #   Organization template repository
    │   ├── proc_messaging/      #   Process messaging (hub/channel/bridge)
    │   └── process_events/      #   Process event pushing
    ├── runtime/                 # Runtime submodules (~30 files)
    │   ├── runtime_state.js     #   State: registries, compute status, interrupts
    │   ├── runtime_events.js    #   Event pub/sub
    │   ├── runtime_lifecycle.js #   Agent lifecycle
    │   ├── runtime_messaging.js #   Message processing loop
    │   ├── runtime_tools.js     #   Tool registration & dispatch
    │   ├── runtime_llm.js       #   LLM interaction loop
    │   ├── turn_engine.js       #   Turn engine (coroutine-style state machine)
    │   ├── compute_scheduler.js #   Compute scheduler (round-robin time slices)
    │   ├── tools_schema.js      #   Built-in tool schema assembly
    │   ├── tools_agent.js       #   Organization/agent tool implementations
    │   ├── tools_file.js        #   File tool implementations
    │   ├── javascript_executor.js        # JS sandbox executor
    │   ├── javascript_executor_worker.js # vm + Worker sandbox thread
    │   ├── bootstrap_manager.js #   Initialization flow
    │   ├── shutdown_manager.js  #   Graceful shutdown
    │   └── …
    ├── extensions/
    │   ├── module_loader.js     # Loads modules/ extensions
    │   └── tool_group_manager.js# Tool group registration & merging
    ├── utils/                   # Pure utilities (message/content/config/logger/process)
    └── prompt_loader.js         # System prompt loading & composition
```

Every directory ships a same-name `.md` description (overview / file list / subdirectory list) — read it before diving into the code.

## Core Flows

### Startup Flow

```
start.cmd / start.sh
  └─▶ start-wrapper.mjs        # earliest error capture + boot.log
      └─▶ start.js             # parse args → Config.loadApp()
          └─▶ AgentSociety.init()
              ├─▶ Runtime.init()          # BootstrapManager:
              │     load config → Logger → MessageBus → OrgPrimitives
              │     → LlmServiceRegistry → WorkspaceManager
              │     → ConversationManager → ModuleRegistry.ensureReady()
              │     → ModuleLoader.loadModules() → tool group registration
              ├─▶ register user endpoint agent (id="user")
              ├─▶ register Root agent (reads config/prompts/root.txt)
              ├─▶ start HTTP server (Hono)
              ├─▶ setupGracefulShutdown()  # SIGINT/SIGTERM
              ├─▶ AutoReplyManager.start()
              └─▶ Runtime.startProcessing() # message loop starts
```

### Message Processing Flow

```
user / agent / process sends a message
  └─▶ bus.send(to, from, payload, taskId)
      └─▶ MessageBus enqueues by recipient
          └─▶ RuntimeMessaging loop (producer-consumer)
              ├─ concurrency: different agents parallel, same agent serial
              ├─ interruption queue: messages arriving mid-processing
              └─▶ TurnEngine: abstracted as a Turn
                  ├─ step() returns one atomic action:
                  │   need_llm / need_tool / send / done
                  ├─ need_llm → RuntimeLlm: build context (system prompt +
                  │             role prompt + workspace guide + task + memory)
                  │             → LlmClient.chat() → parse tool calls/reply
                  ├─ need_tool → ToolExecutor runs → result into conversation
                  └─ send → bus.send(...)  # to user or another agent
```

### Tool Call Chain

```
LLM returns tool_calls
  └─▶ ToolExecutor.executeToolCall(ctx, name, args)
      ├─ built-in tools → implementations in runtime/tools_*.js
      ├─ run_javascript → JavaScriptExecutor (Worker + vm sandbox)
      └─ module tools → ModuleLoader.executeToolCall()
          └─▶ modules/<name>/index.js executeToolCall(ctx, name, args)
```

### Shutdown Flow

```
SIGINT/SIGTERM
  └─▶ ShutdownManager
      ├─ stop accepting new messages
      ├─ wait for in-flight processing (with timeout)
      ├─ persist organization state (org.json)
      ├─ persist conversation history
      └─▶ CleanupHookChain: 6-phase cleanup hooks (LifecycleRegistry
          releases resources — browsers, subprocesses, memory instances —
          cascading by owning agent)
```

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Runtime coordinates, never implements | All functionality lives in submodules/services; Runtime stays thin, avoiding a 5000-line god class |
| Declarative DI (ModuleRegistry) | Modules `declare({requires, provides, init})`; the registry initializes by dependency topology; dead/circular dependencies error at validate time |
| Single writer for conversations | Only TurnEngine writes an agent's conversation history, preventing concurrent write ordering bugs |
| Coroutine-style turn engine | step() never blocks; long operations use "start async → callback enqueues"; scheduler yields the event loop each round |
| Tool-group permission model | Role-level tool whitelists; agents only see/call tools in their groups |
| Files ≤ 500 lines (excluding comments) | Enforced modularity; high cohesion, low coupling |
| Null-value discipline | Injected functional components must not null-check (fail loudly); only external data gets tolerance |
| Every exception must log | Any catch outputs message + stack + business context; silent swallowing forbidden |

## Web Frontend

```
web/
├── index.html          # Entry: redirects by device to v3 or mobile
├── v3/                 # Desktop (Vue 3 + Vite + Pinia + PrimeVue + Tailwind 4)
│   └── src/
│       ├── components/ # By domain: chat/ agent/ artifacts/ skills/ modules/
│       │               #   settings/ overview/ file-viewer/ file-diff/ …
│       ├── services/   # API wrappers (api.ts, configApi.ts, skillApi.ts…)
│       ├── stores/     # Pinia: app/ chat/ agent/ org/ guide
│       └── types/ utils/
└── mobile/             # Mobile (same stack)
```

- Builds land in each `dist/`, served statically by the HTTP server (`/web/v3/dist/index.html`);
- Live updates ride the heartbeat: the frontend periodically `POST /api/heartbeat` with `lastMessageId`, draining incremental messages/events.

## Related Documents

- [Core Concepts & Data Model](02-concepts.md)
- [Messaging & Scheduling](03-messaging-scheduling.md)
- `src/platform/platform.md`, `core/core.md`, `runtime/runtime.md` (in-repo descriptions)
