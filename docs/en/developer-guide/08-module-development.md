# Module Development

Modules are the standard way to extend the system. This chapter covers the module interface contract and development steps. Reference implementations: `modules/localcmd/` (the most complete: tools + routes + panel + policy review), `modules/chrome/` (split-file style), `modules/ui_page/` (web component injection).

## Module

- Code location: `modules/<name>/index.js` (entry convention);
- One module = one **tool group** (for agents) + optional **web panel** (for users) + optional **HTTP routes** (for frontend/processes);
- Loaded dynamically by `ModuleLoader` (`src/platform/extensions/module_loader.js`) per `config/modules.enabled.json`.

## Required Interface

`ModuleLoader._validateModuleInterface` requires the default export object to contain:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Module name (unique) |
| `init` | function | Initialization: `async init(runtime)`; store the runtime reference here |
| `getToolDefinitions` | function | Returns the tool definition array (OpenAI tools format) |
| `executeToolCall` | function | Executes a tool: `async executeToolCall(ctx, toolName, args)` |
| `shutdown` | function | Cleanup: `async shutdown()` |

## Optional Interface

| Field | Type | Description |
|-------|------|-------------|
| `toolGroupId` | string | Tool group ID (defaults to the module name) |
| `toolGroupDescription` | string | Tool group description (shown in selection and role configuration) |
| `getWebComponent` | function | Returns the web panel definition: `{ moduleName, displayName, icon, panelPath }`; panelPath points to an HTML file inside the module |
| `getHttpHandler` | function | Returns an HTTP handler: `async (req, res, pathParts, body) => result`, mounted under `/api/modules/<name>/...` |
| Module config | — | In `init`, call `configService.registerModuleConfig(name, defaults)`; then `getModuleConfig(name)` returns the config merged with `config/modules/<name>.json` |

## Tool Definition Format

Identical to OpenAI tools:

```javascript
getToolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "my_tool",
        description: "What the tool does (the agent decides when to call based on this)",
        parameters: {
          type: "object",
          properties: {
            target: { type: "string", description: "Parameter description" }
          },
          required: ["target"]
        }
      }
    }
  ];
}
```

Tool names are globally unique; on cross-module conflicts the **later-loaded module overrides** and a warn is logged.

## executeToolCall Context

```javascript
async executeToolCall(ctx, toolName, args) {
  // ctx.agent    — current agent (id, roleId, roleName…)
  // ctx.org      — OrgPrimitives (query/create roles and agents)
  // ctx.bus      — MessageBus (send messages)
  // ctx.runtime  — runtime reference (the rt saved in init also works)
  // ctx.tools    — built-in tool capabilities (findRoleByName etc.)
  switch (toolName) {
    case "my_tool":
      return await this._doWork(ctx, args);
    default:
      return { error: "unknown_tool", toolName };
  }
}
```

Return convention: on success return a result object (formatted and written back to the conversation); on failure return `{ error, message }`. **Do not throw** — tool failure is a normal business branch; a structured error lets the LLM read it and adjust.

## Development Steps

```
modules/my-module/
├── index.js        # Entry: interface implementation
├── tools.js        # Tool schema and implementation (recommended split)
├── web/            # Optional: panel assets (panel.html/css/js)
└── my-module.md    # Directory doc (project convention)
```

1. **Write the index.js skeleton** (five required fields); in `init`, save the runtime and get a logger (`runtime.loggerRoot.forModule("my-module")`);
2. **Define the tool group**: `toolGroupId` + `toolGroupDescription` + `getToolDefinitions()`;
3. **Implement executeToolCall**: dispatch by toolName;
4. **Test**: `test/modules/my-module.test.js`, calling executeToolCall with a mock runtime (see `test/modules/chrome.test.js`);
5. **Register & enable**: add a default config entry in `config/modules.json`; add the module name to the `enabled` array in `config/modules.enabled.json`;
6. **Manual verification**: start the system, check the `my-module` tool group when creating a role, have an agent call the tool.

## Lazy Loading

With `"lazy": true` in `config/modules.json`, `init` is deferred until the **first tool call** (tool definitions register as usual). Suited to modules with expensive initialization (e.g. ssh).

## Inter-module Communication (ModuleRegistry)

When modules need each other's services — or platform services — use the declarative mechanism in `core/module_registry.js`; **do not import the other module directly**:

```javascript
import { registry } from "../src/platform/core/module_registry.js";

// Provide a service
registry.declare({
  name: "my-module",
  requires: ["groupChatService"],       // Services provided by others
  provides: ["myCapability"],
  init(deps) {                          // deps holds ready dependency instances
    this.api = { doSomething() { … } };
    return { myCapability: this.api };
  }
});
```

- The registry calls `init` automatically once all `requires` are ready — **declaration order is irrelevant**;
- Dead dependencies (nothing provides them) and circular dependencies (mutual waiting) error out at the validate stage;
- Platform internals (group chat service, proc message routes) already use this mechanism — see `src/platform/services/group_chat/group_routes.js`.

## Web Panel

`getWebComponent()` returns:

```javascript
getWebComponent() {
  return {
    moduleName: "my-module",
    displayName: "My Module",
    icon: "🔧",
    panelPath: "modules/my-module/web/panel.html"
  };
}
```

- Panel HTML and its css/js live in the `web/` subdirectory, served at `GET /modules/my-module/web/...` (no-cache — refresh applies changes);
- The interface's "module window" loads panelPath and renders;
- The panel talks to the backend through its own HTTP endpoints (getHttpHandler) or the platform's heartbeat/proc channels.

## HTTP Endpoints

The handler returned by `getHttpHandler()` mounts under `/api/modules/<name>/*`:

```javascript
getHttpHandler() {
  return async (req, res, pathParts, body) => {
    // pathParts — path segments after the module name
    // body — POST body, already parsed JSON
    const [resource, action] = pathParts;
    if (resource === "items" && req.method === "GET") {
      return { ok: true, items: this._list() };
    }
    return { error: "not_found" };
  };
}
```

For more complex routing (CORS, Hono integration), declare routes through ModuleRegistry instead (see `proc_message_channel_routes.js`).

## Alignment Checklist

- [ ] Every function has a Chinese comment (design intent and key constraints, not restating code)
- [ ] The module directory has a `<name>.md` doc
- [ ] Tool schema descriptions are written for the LLM (it decides when to call based on them)
- [ ] executeToolCall doesn't throw; returns `{error, message}`
- [ ] Dependencies from init (injected service objects) get **no null-tolerance** — missing ones fail loudly; only config parameters allow defaults
- [ ] Every catch logs fully (message + stack + business context)
- [ ] Single file ≤ 500 lines (excluding comments); split by responsibility beyond that
- [ ] shutdown releases all resources (processes, timers, browser instances — register with LifecycleRegistry for cascading cleanup)

## Related Documents

- [Tools](09-tools.md)
- [Testing](11-testing.md)
- [Proc Protocol](10-proc-protocol.md) (if your module launches processes)
