# 模块开发指南

模块（Module）是扩展系统能力的标准方式。本篇给出模块接口契约与开发步骤。参考实现：`modules/localcmd/`（最完整的参考：工具+路由+面板+策略审核）、`modules/chrome/`（功能拆分风格）、`modules/ui_page/`（Web 组件注入）。

## 模块

- 代码位置：`modules/<模块名>/index.js`（入口约定）；
- 一个模块 = 一个**工具组**（给智能体用）+ 可选的 **Web 面板**（给用户用）+ 可选的 **HTTP 路由**（给前端/进程用）；
- 由 `ModuleLoader`（`src/platform/extensions/module_loader.js`）按 `config/modules.enabled.json` 动态加载。

## 必需接口

`ModuleLoader._validateModuleInterface` 要求 default 导出对象包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 模块名（唯一） |
| `init` | function | 初始化：`async init(runtime)`，运行时引用在此保存 |
| `getToolDefinitions` | function | 返回工具定义数组（OpenAI tools 格式） |
| `executeToolCall` | function | 执行工具：`async executeToolCall(ctx, toolName, args)` |
| `shutdown` | function | 关闭清理：`async shutdown()` |

## 可选接口

| 字段 | 类型 | 说明 |
|------|------|------|
| `toolGroupId` | string | 工具组 ID（缺省用模块名） |
| `toolGroupDescription` | string | 工具组描述（选模与岗位配置时展示） |
| `getWebComponent` | function | 返回 Web 面板定义：`{ moduleName, displayName, icon, panelPath }`，panelPath 指向模块内的 HTML |
| `getHttpHandler` | function | 返回 HTTP 处理函数：`async (req, res, pathParts, body) => result`，挂载在 `/api/modules/<name>/...` 之下 |
| 模块配置 | — | 在 init 中 `configService.registerModuleConfig(name, defaults)` 声明默认值，之后 `getModuleConfig(name)` 获得与 `config/modules/<name>.json` 合并后的配置 |

## 工具定义格式

与 OpenAI tools 完全一致：

```javascript
getToolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "my_tool",
        description: "工具说明（智能体据此决定何时用）",
        parameters: {
          type: "object",
          properties: {
            target: { type: "string", description: "参数说明" }
          },
          required: ["target"]
        }
      }
    }
  ];
}
```

工具名全局唯一；跨模块重名时**后加载者覆盖**并记录 warn 日志。

## executeToolCall 上下文

```javascript
async executeToolCall(ctx, toolName, args) {
  // ctx.agent    — 当前智能体（id、roleId、roleName…）
  // ctx.org      — OrgPrimitives（查询/创建岗位与智能体）
  // ctx.bus      — MessageBus（发消息）
  // ctx.runtime  — 运行时引用（init 时保存的 rt 也可用）
  // ctx.tools    — 内置工具能力（findRoleByName 等）
  switch (toolName) {
    case "my_tool":
      return await this._doWork(ctx, args);
    default:
      return { error: "unknown_tool", toolName };
  }
}
```

返回值约定：成功返回结果对象（会被格式化后写回会话），失败返回 `{ error, message }`。**不要抛异常**——工具失败是正常业务分支，返回结构化错误让 LLM 能读懂并调整。

## 开发步骤

```
modules/my-module/
├── index.js        # 入口：接口实现
├── tools.js        # 工具 schema 与实现（推荐拆出）
├── web/            # 可选：面板资源（panel.html/css/js）
└── my-module.md    # 目录说明文档（项目约定）
```

1. **写 index.js 骨架**（五个必需字段），`init` 里保存 runtime、拿 logger（`runtime.loggerRoot.forModule("my-module")`）；
2. **定义工具组**：`toolGroupId` + `toolGroupDescription` + `getToolDefinitions()`；
3. **实现 executeToolCall**：按 toolName 分发；
4. **测试**：`test/modules/my-module.test.js`，模拟 runtime 调用 executeToolCall（参考 `test/modules/chrome.test.js` 的做法）；
5. **注册启用**：`config/modules.json` 加默认配置条目；`config/modules.enabled.json` 的 enabled 数组加入模块名；
6. **人工验证**：启动系统，创建岗位时勾选 `my-module` 工具组，让智能体调用工具。

## 懒加载

`config/modules.json` 中该模块配置 `"lazy": true` 时，init 延迟到**首次工具调用**时执行（工具定义照常注册）。适合初始化开销大的模块（如 ssh）。

## 模块间通信（ModuleRegistry）

模块之间、模块与平台服务之间需要服务交换时，用 `core/module_registry.js` 的声明式机制，**不要直接 import 对方**：

```javascript
import { registry } from "../src/platform/core/module_registry.js";

// 提供服务
registry.declare({
  name: "my-module",
  requires: ["groupChatService"],       // 依赖他人提供的服务
  provides: ["myCapability"],
  init(deps) {                          // deps 里是已就绪的依赖实例
    this.api = { doSomething() { … } };
    return { myCapability: this.api };
  }
});
```

- 注册表在所有 `requires` 就绪时自动调用 `init`，**与声明顺序无关**；
- 死依赖（没人 provides）与循环依赖（互相等待）在 validate 阶段报错；
- 平台内部的群聊服务、proc 消息路由等已迁移到此机制，可参考 `src/platform/services/group_chat/group_routes.js`。

## Web 面板

`getWebComponent()` 返回：

```javascript
getWebComponent() {
  return {
    moduleName: "my-module",
    displayName: "我的模块",
    icon: "🔧",
    panelPath: "modules/my-module/web/panel.html"
  };
}
```

- 面板 HTML 及其引用的 css/js 放在 `web/` 子目录，经 `GET /modules/my-module/web/...` 访问（no-cache，改完刷新即生效）；
- 界面的"模块窗口"加载 panelPath 渲染；
- 面板与后端交互走自己的 HTTP 端点（getHttpHandler）或平台心跳/proc 通道。

## HTTP 端点

`getHttpHandler()` 返回的处理函数挂载在 `/api/modules/<name>/*` 路径下：

```javascript
getHttpHandler() {
  return async (req, res, pathParts, body) => {
    // pathParts — 模块名之后的路径段数组
    // body — POST 已解析的 JSON body
    const [resource, action] = pathParts;
    if (resource === "items" && req.method === "GET") {
      return { ok: true, items: this._list() };
    }
    return { error: "not_found" };
  };
}
```

需要更复杂路由（含 CORS、与 Hono 集成）时，改用 ModuleRegistry 声明路由（参考 proc_message_channel_routes.js 的做法）。

## 对齐清单

- [ ] 每个函数有中文注释（说明设计意图与关键约束，不只是复述代码）
- [ ] 模块目录有 `<模块名>.md` 说明文档
- [ ] 工具 schema 的 description 面向 LLM 写（它靠这个决定何时调用）
- [ ] executeToolCall 不抛异常，返回 `{error, message}`
- [ ] init 中的依赖（注入的服务对象）**不做空值兼容**，缺了直接报错；仅配置参数允许默认值
- [ ] 所有 catch 输出完整日志（message + stack + 业务上下文）
- [ ] 单文件 ≤ 500 行（不含注释），超了按职责拆文件
- [ ] shutdown 释放全部资源（进程、定时器、浏览器实例——可注册到 LifecycleRegistry 自动级联清理）

## 相关文档

- [工具系统](09-tools.md)
- [测试指南](11-testing.md)
- [Proc 消息协议](10-proc-protocol.md)（如果你的模块要启动进程）
