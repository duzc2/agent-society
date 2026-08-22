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

/**
 * 构造 workspaceId(= agent id) → 归属显示名「组织名 / 最上层agent名」的映射。
 * 沿 parentAgentId 链向上找最上层 agent（链上父级缺失时以当前节点为准）；
 * 组织名未设置时只显示最上层 agent 名，两者都拿不到回退原始 id。
 * org 是运行时必建组件，缺失（异常初始化/测试 mock 未提供）返回空映射——显示降级不影响列表功能。
 */
function _buildAgentDisplayMap() {
  const org = runtime?.org;
  if (!org || typeof org.listAgents !== "function") return new Map();
  const agents = org.listAgents();
  const byId = new Map(agents.map((a) => [a.id, a]));
  const map = new Map();
  for (const a of agents) {
    let head = a;
    const seen = new Set();
    while (head.parentAgentId && !seen.has(head.parentAgentId)) {
      seen.add(head.parentAgentId);
      const parent = byId.get(head.parentAgentId);
      if (!parent) break;
      head = parent;
    }
    const orgName = org.getOrgName?.(a.id) ?? null;
    const headName = head.name ?? null;
    map.set(a.id, [orgName, headName].filter(Boolean).join(" / ") || a.id);
  }
  return map;
}

/** 给条目附加 agentName（归属显示名），未命中回退原始 workspaceId */
function _withAgentNames(items, displayMap) {
  return items.map((it) => ({ ...it, agentName: displayMap.get(it.workspaceId) ?? it.workspaceId }));
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
        // 必填参数兜底校验（schema required 已声明，模型不遵守时此处强制）：
        // 缺失时报错返回给模型，由模型补充参数后重试；否则前端保存提示拿不到目的/建议文件名
        if (typeof args?.purpose !== "string" || !args.purpose.trim()) {
          return { error: "invalid_params", message: "ui_page_eval_js 缺少必填参数 purpose（本次执行脚本的目的，面向用户展示的简短说明），请补充后再调用" };
        }
        if (typeof args?.suggestedFilename !== "string" || !args.suggestedFilename.trim()) {
          return { error: "invalid_params", message: "ui_page_eval_js 缺少必填参数 suggestedFilename（建议的保存文件名，不含 .js 后缀），请补充后再调用" };
        }
        const script = String(args?.script ?? "");
        const wsId = runtime.findWorkspaceIdForAgent(ctx.agent?.id) ?? ctx.agent?.id ?? null;
        // purpose/suggestedFilename 透传给前端保存提示框：展示目的 + 预填建议文件名
        const result = await _dispatchAndWait(
          "eval_js",
          {
            script,
            _ws: wsId,
            purpose: args?.purpose ?? null,
            suggestedFilename: args?.suggestedFilename ?? null
          },
          timeoutMs
        );
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
   * scripts/candidates 带 description（脚本文件头部 // purpose: 注释解析而来，面板展示用；
   * 缺失/读取失败为空字符串）与 agentName（归属显示名「组织名 / 最上层agent名」，来自 org 树，
   * 未命中回退 workspaceId）；POST 返回的 scripts 同样富化，保证面板操作后描述/归属不消失。
   *
   * GET  auto-load-scripts                 → { ok, scripts }
   * GET  auto-load-scripts/available       → { ok, candidates }（所有工作区 ui_page_js/ 下可添加的脚本，排除已注册，含 description/agentName）
   * GET  auto-load-scripts/executables     → { ok, scripts, errors }（前端页面加载时拉取执行）
   * POST auto-load-scripts {id, enabled}   → 启用/禁用，返回全量列表
   * POST auto-load-scripts {id, remove}    → 移除记录（不删文件），返回全量列表
   * POST auto-load-scripts {id, run}       → 已注册条目运行预览（读内容→心跳广播 eval_js），返回 {ok, path}
   * POST auto-load-scripts {workspaceId, path} → 添加脚本，返回全量列表
   * POST auto-load-scripts {workspaceId, path, run} → 候选条目运行预览（未注册也可运行），返回 {ok, path}
   */
  getHttpHandler() {
    return async (req, res, pathParts, body) => {
      const registry = autoLoadRegistry;
      const [resource, action] = pathParts;

      if (resource !== "auto-load-scripts") {
        return { error: "not_found", message: `未知资源: ${resource}` };
      }

      try {
        const displayMap = _buildAgentDisplayMap();
        if (req.method === "GET") {
          if (!action) {
            return { ok: true, scripts: _withAgentNames(await registry.listWithDescriptions(), displayMap) };
          }
          if (action === "executables") {
            const { scripts, errors } = await registry.getExecutables();
            return { ok: true, scripts, errors };
          }
          if (action === "available") {
            const candidates = await registry.getAvailableCandidates();
            return { ok: true, candidates: _withAgentNames(candidates, displayMap) };
          }
          return { error: "not_found", message: `未知子路径: ${action}` };
        }

        if (req.method === "POST" && !action) {
          const { id, enabled, remove, run, workspaceId, path: scriptPath } = body ?? {};

          if (typeof id === "string") {
            // 运行预览：读脚本内容 → 心跳广播 eval_js（_preview 标记，前端不弹保存提示）
            if (run === true) {
              const content = await registry.getScriptContent(id);
              if (!content.ok) {
                return { error: content.error, message: content.message ?? `未找到记录: ${id}` };
              }
              const enq = getBroker().enqueueToActive({
                type: "eval_js",
                payload: { script: content.script, _ws: content.entry.workspaceId, _preview: true }
              });
              if (!enq.ok) {
                return { error: "dispatch_failed", message: enq.error };
              }
              // 预览命令客户端不回传结果（前端 _preview 跳过 sendResult），消息需由服务端延迟清理，
              // 防止 60s TTL 内刷新页面被 drain 重复执行
              setTimeout(() => {
                const b = getBroker();
                if (b) b.clearCommand(enq.commandId);
              }, 10_000).unref?.();
              return { ok: true, run: true, path: content.entry.path };
            }
            // 按 id 启停/删除
            if (remove === true) {
              if (!(await registry.remove(id))) {
                return { error: "not_found", message: `未找到记录: ${id}` };
              }
            } else if (typeof enabled === "boolean") {
              await registry.setEnabled(id, enabled);
            } else {
              return { error: "invalid_params", message: "需提供 enabled 布尔值、remove: true 或 run: true" };
            }
          } else if (typeof workspaceId === "string" && typeof scriptPath === "string") {
            if (!scriptPath.startsWith("ui_page_js/") || !scriptPath.endsWith(".js")) {
              return { error: "invalid_params", message: "path 需位于 ui_page_js/ 目录且以 .js 结尾" };
            }
            if (run === true) {
              // 候选列表运行预览（条目未注册也可运行）：读文件 → 心跳广播 eval_js
              const content = await registry.getFileContent(workspaceId, scriptPath);
              if (!content.ok) {
                return { error: content.error, message: content.message ?? "读取脚本失败" };
              }
              const enq = getBroker().enqueueToActive({
                type: "eval_js",
                payload: { script: content.script, _ws: workspaceId, _preview: true }
              });
              if (!enq.ok) {
                return { error: "dispatch_failed", message: enq.error };
              }
              // 预览命令客户端不回传结果（前端 _preview 跳过 sendResult），消息需由服务端延迟清理，
              // 防止 60s TTL 内刷新页面被 drain 重复执行
              setTimeout(() => {
                const b = getBroker();
                if (b) b.clearCommand(enq.commandId);
              }, 10_000).unref?.();
              return { ok: true, run: true, path: scriptPath };
            }
            // 按 workspaceId+path 添加脚本（面板"添加脚本"入口）
            await registry.add({ workspaceId, path: scriptPath });
          } else {
            return { error: "missing_params", message: "需提供 id（启停/删除）或 workspaceId+path（添加）" };
          }
          return { ok: true, scripts: _withAgentNames(await registry.listWithDescriptions(), displayMap) };
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

