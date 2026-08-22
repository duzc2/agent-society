import { getToolDefinitions } from "./tools.js";
import { getBroker } from "./broker.js";
import { createAutoLoadRegistry, _setAutoLoadRegistry } from "./auto_load.js";

let runtime = null;
let log = null;

/** @type {object|null} 自动加载脚本注册表实例 */
let autoLoadRegistry = null;

function _getBroker() {
  const broker = getBroker();
  if (!broker) return { ok: false, error: "ui_broker_unavailable" };
  return { ok: true, broker };
}

async function _dispatchAndWait(type, payload, timeoutMs) {
  const brokerResult = _getBroker();
  if (!brokerResult.ok) return brokerResult;

  const enq = brokerResult.broker.enqueueToActive({ type, payload });
  if (!enq.ok) return enq;

  try {
    const resp = await brokerResult.broker.waitForResult(enq.commandId, timeoutMs);
    if (resp?.ok === true) {
      return { ok: true, result: resp.result ?? null };
    }
    return { error: "ui_execute_error", message: resp?.error?.message ?? resp?.error ?? "unknown", details: resp?.error ?? null };
  } catch (err) {
    if (err?.code === "ui_timeout" || err?.message === "ui_timeout") {
      return { error: "ui_timeout" };
    }
    return { error: "ui_dispatch_failed", message: err?.message ?? String(err) };
  }
}

export default {
  name: "ui_page",
  toolGroupId: "ui_page",
  toolGroupDescription: "面向本软件 Web UI 页面上下文的工具（执行 JS/读取内容/临时修改 DOM）",

  async init(rt) {
    runtime = rt;
    log = runtime.loggerRoot.forModule("ui_page");

    // 自动加载注册表：configService 缺失时直接抛错暴露初始化顺序问题（铁律：禁止空值兼容）
    autoLoadRegistry = createAutoLoadRegistry({ configService: rt.configService, log });
    await autoLoadRegistry.load();
    _setAutoLoadRegistry(autoLoadRegistry);

    log.info("ui_page 模块初始化完成");
  },

  getToolDefinitions() {
    return getToolDefinitions();
  },

  async executeToolCall(ctx, toolName, args) {
    const timeoutMs = Number(args?.timeoutMs ?? 10000);

    switch (toolName) {
      case "ui_page_eval_js": {
        if(!args.script){
          return;
        }
        const script = String(args?.script ?? "");
        const wsId = runtime.findWorkspaceIdForAgent(ctx.agent?.id) ?? ctx.agent?.id ?? null;
        const result = await _dispatchAndWait("eval_js", { script, _ws: wsId }, timeoutMs);
        return result;
      }
      case "ui_page_get_content":
        return await _dispatchAndWait(
          "get_content",
          {
            selector: args?.selector ?? null,
            format: args?.format ?? "summary",
            maxChars: Number(args?.maxChars ?? 20000)
          },
          timeoutMs
        );
      case "ui_page_dom_patch":
        return await _dispatchAndWait(
          "dom_patch",
          { operations: Array.isArray(args?.operations) ? args.operations : [] },
          timeoutMs
        );
      default:
        return { error: "unknown_tool", toolName };
    }
  },

  /**
   * Web 管理面板（模块管理窗口 → ui_page → Web JS 自动加载）
   */
  getWebComponent() {
    return {
      moduleName: "ui_page",
      displayName: "Web JS 自动加载",
      icon: "📄",
      panelPath: "modules/ui_page/web/panel.html"
    };
  },

  /**
   * 自动加载脚本管理 API（pathParts 不含模块名；只有 POST 会解析 body）
   *
   * GET  auto-load-scripts                 → { ok, scripts }
   * GET  auto-load-scripts/available       → { ok, candidates }（所有工作区 ui_page_js/ 下可添加的脚本，排除已注册）
   * GET  auto-load-scripts/executables     → { ok, scripts, errors }（前端页面加载时拉取执行）
   * POST auto-load-scripts {id, enabled}   → 启用/禁用，返回全量列表
   * POST auto-load-scripts {id, remove}    → 移除记录（不删文件），返回全量列表
   * POST auto-load-scripts {workspaceId, path} → 添加脚本，返回全量列表
   */
  getHttpHandler() {
    return async (req, res, pathParts, body) => {
      const registry = autoLoadRegistry;
      const [resource, action] = pathParts;

      if (resource !== "auto-load-scripts") {
        return { error: "not_found", message: `未知资源: ${resource}` };
      }

      try {
        if (req.method === "GET") {
          if (!action) {
            return { ok: true, scripts: registry.list() };
          }
          if (action === "executables") {
            const { scripts, errors } = await registry.getExecutables();
            return { ok: true, scripts, errors };
          }
          if (action === "available") {
            const candidates = await registry.getAvailableCandidates();
            return { ok: true, candidates };
          }
          return { error: "not_found", message: `未知子路径: ${action}` };
        }

        if (req.method === "POST" && !action) {
          const { id, enabled, remove, workspaceId, path: scriptPath } = body ?? {};

          if (typeof id === "string") {
            // 按 id 启停/删除
            if (remove === true) {
              if (!(await registry.remove(id))) {
                return { error: "not_found", message: `未找到记录: ${id}` };
              }
            } else if (typeof enabled === "boolean") {
              await registry.setEnabled(id, enabled);
            } else {
              return { error: "invalid_params", message: "需提供 enabled 布尔值或 remove: true" };
            }
          } else if (typeof workspaceId === "string" && typeof scriptPath === "string") {
            // 按 workspaceId+path 添加脚本（面板"添加脚本"入口）
            if (!scriptPath.startsWith("ui_page_js/") || !scriptPath.endsWith(".js")) {
              return { error: "invalid_params", message: "path 需位于 ui_page_js/ 目录且以 .js 结尾" };
            }
            await registry.add({ workspaceId, path: scriptPath });
          } else {
            return { error: "missing_params", message: "需提供 id（启停/删除）或 workspaceId+path（添加）" };
          }
          return { ok: true, scripts: registry.list() };
        }

        return { error: "invalid_method" };
      } catch (err) {
        log.error("自动加载 API 处理失败", { pathParts, error: err?.message ?? String(err), stack: err?.stack });
        return { error: "auto_load_handler_failed", message: err?.message ?? String(err) };
      }
    };
  },

  async shutdown() {
    log.info("ui_page 模块关闭");
    _setAutoLoadRegistry(null);
    autoLoadRegistry = null;
    runtime = null;
    log = null;
  }
};

