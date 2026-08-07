import { getToolDefinitions } from "./tools.js";
import { getBroker } from "./broker.js";

let runtime = null;
let log = null;

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

  async shutdown() {
    log.info("ui_page 模块关闭");
    runtime = null;
    log = null;
  }
};

