/**
 * 本地命令执行模块
 * 提供在本地执行命令行命令的能力，支持长期运行的交互式进程。
 * 所有输出写入文件，通过 seek 读取不同位置。
 *
 * v2: 集成命令审核 — 基于心跳框架的策略检查 + 确认钩子
 */

import { ProcessManager } from "./process_manager.js";
import { getToolDefinitions } from "./tools.js";
import { checkPolicy } from "./policy_engine.js";
import { PolicyStore } from "./policy_store.js";
import { ProcessEventPusher } from "../../src/platform/services/process_events/event_pusher.js";
import { getWorkspaceManager } from "../../src/platform/services/workspace/workspace_manager.js";

/** @type {ProcessManager|null} */
let processManager = null;

/** @type {PolicyStore|null} */
let policyStore = null;

/** @type {ProcessEventPusher|null} */
let processEventPusher = null;

/** @type {any} */
let runtime = null;

/** @type {any} */
let log = null;

/**
 * 待处理的确认请求
 * Map<messageId, { resolve: (allowed: boolean) => void, reject: (err: Error) => void }>
 */
const pendingConfirmations = new Map();

/**
 * LocalCmd 模块导出
 */
export default {
  name: "localcmd",

  // 工具组标识符
  toolGroupId: "localcmd",

  // 工具组描述
  toolGroupDescription: "本地命令执行工具，支持长期运行的交互式进程，输出写入文件；进程可接入消息协议（proc.send 进你会话、proc.notifyWeb 推网页进程）。仅当要给用户制作可交互的网页界面时，才需搭配 \"ui_page\" 工具组：界面由 ui_page 注入，本组进程按需经 proc.onRequest 提供后端数据。",

  /**
   * 初始化模块
   * @param {any} rt - 运行时实例
   * @returns {Promise<void>}
   */
  async init(rt) {
    runtime = rt;
    log = runtime.loggerRoot.forModule("localcmd");

    // 从 runtime 获取数据目录
    const dataDir = runtime.dataDir;

    processManager = new ProcessManager({
      log,
      runtime,
      dataDir
    });

    // 初始化进程事件推送器：进程状态变化与日志更新主动推送给所属智能体
    processEventPusher = new ProcessEventPusher({
      runtime,
      log,
      intervalMs: 30000
    });
    processManager.onProcessEvent((evt) => {
      processEventPusher.onEvent(evt);
    });
    log.info("[LocalCmd] 进程事件推送器已就绪", { intervalMs: 30000 });

    // 初始化策略存储
    policyStore = new PolicyStore(dataDir, log);
    await policyStore.load();
    log.info("[LocalCmd] 策略存储已加载");

    // 注册系统提示词注入
    if (runtime.registerSystemPromptProvider) {
      runtime.registerSystemPromptProvider("localcmd", () => {
        return _buildSystemPrompt();
      });
      log.info("[LocalCmd] 已注册系统提示词注入");
    }

    // 进程消息协议格式化器：进程 msg → 【服务器进程消息·<进程名>】插入会话（可回溯，同页面通知语义）
    if (runtime._llm && typeof runtime._llm.registerMessageFormatter === "function") {
      runtime._llm.registerMessageFormatter(
        (message) => message?.extras?.kind === "proc_msg",
        (message) => {
          const procName = message.extras?.procName ?? "服务器进程";
          const payload = message.payload;
          let body;
          if (typeof payload === "string") {
            body = payload;
          } else if (payload && typeof payload.text === "string") {
            body = payload.text;
          } else {
            try { body = JSON.stringify(payload ?? {}); } catch { body = "[载荷不可序列化]"; }
          }
          return `【服务器进程消息·${procName}】${body.slice(0, 500)}`;
        }
      );
      log.info("[LocalCmd] 已注册进程消息格式化器");
    }

    log.info("[LocalCmd] 模块初始化完成", {
      systemInfo: processManager.getSystemInfo()
    });
  },

  /**
   * 获取工具定义列表
   * @returns {Array<{type: string, function: object}>}
   */
  getToolDefinitions() {
    return getToolDefinitions();
  },

  /**
   * 执行工具调用
   * @param {any} ctx - 调用上下文
   * @param {string} toolName - 工具名称
   * @param {any} args - 工具参数
   * @returns {Promise<any>}
   */
  async executeToolCall(ctx, toolName, args) {
    try {
      switch (toolName) {
        case "localcmd_spawn": {
          // --- 策略检查 ---
          const agentId = ctx.agent.id;
          const orgId = ctx.runtime.findWorkspaceIdForAgent(agentId);
          const resolvedCwd = args.cwd ?? (orgId ? getWorkspaceManager().getWorkspacePath(orgId) : undefined);

          const policy = policyStore.get(orgId);
          const cmdStr = [args.command, ...(args.args ?? [])].join(" ");

          const policyResult = checkPolicy(cmdStr, policy);

          // 白名单：直接放行
          if (policyResult.action === "allow") {
            return await processManager.spawn(
              args.command,
              args.args ?? [],
              { cwd: resolvedCwd, env: args.env, agentId, pushEvents: args.pushEvents !== false, procName: args.procName }
            );
          }

          // 黑名单：拒绝
          if (policyResult.action === "reject") {
            log.info("[LocalCmd] 命令被策略拒绝", {
              command: args.command,
              cmdStr,
              matchEntry: policyResult.matchEntry,
              segment: policyResult.segment,
              orgId
            });
            return {
              error: "command_blocked_by_policy",
              command: args.command,
              matchEntry: policyResult.matchEntry
            };
          }

          // 需要确认：广播确认请求
          if (policyResult.action === "confirm") {
            const broker = runtime.heartbeatBroker;
            if (!broker) {
              // 没有心跳框架，回退到允许
              log.warn("[LocalCmd] 心跳框架不可用，命令跳过确认", { command: args.command });
              return await processManager.spawn(
                args.command,
                args.args ?? [],
                { cwd: resolvedCwd, env: args.env, agentId, pushEvents: args.pushEvents !== false, procName: args.procName }
              );
            }

            // orgId 就是顶层智能体ID（workspace只对root的直接子节点创建）
            // 通过 getAgent(orgId) 直接拿到顶层智能体的 name
            const headAgent = orgId ? ctx.runtime.org.getAgent(orgId) : null;

            const debugPayload = {
              command: args.command,
              args: args.args ?? [],
              cwd: resolvedCwd,
              env: args.env,
              cmdStr,
              orgId,
              agentId,
              intent: args.intent,
              agentName: ctx.agent.name,
              orgName: ctx.runtime.org.getOrgName(orgId),
              headAgentName: headAgent?.name ?? null,
            matchPattern: cmdStr
            };

            log.info("[LocalCmd] 广播命令确认 payload", debugPayload);

            const messageId = broker.broadcast("cmd_confirm", debugPayload);

            log.info("[LocalCmd] 等待命令确认", {
              command: args.command,
              messageId,
              orgId
            });

            // 等待前端确认
            try {
              const allowed = await new Promise((resolve, reject) => {
                pendingConfirmations.set(messageId, { resolve, reject });
              });

              if (allowed) {
                return await processManager.spawn(
                  args.command,
                  args.args ?? [],
                  { cwd: resolvedCwd, env: args.env, agentId, pushEvents: args.pushEvents !== false, procName: args.procName }
                );
              } else {
                return {
                  error: "command_denied_by_user",
                  command: args.command
                };
              }
            } finally {
              broker.clearMessage(messageId);
              pendingConfirmations.delete(messageId);
            }
          }

          // 不应该到这里
          return { error: "unexpected_policy_result", action: policyResult.action };
        }

        case "localcmd_send_input":
          return processManager.sendInput(args.processId, args.input);

        case "proc_send": {
          // 进程消息协议：向已接入消息中枢的服务器进程发送结构化消息（P3）
          // 原则：系统能自动匹配的信息（归属智能体、进程身份）不让智能体提供——
          // processId 缺省时自动匹配当前智能体唯一接入进程；多个时提示传 processId
          const agentId = ctx?.agent?.id ?? null;
          const processId = typeof args?.processId === "string" ? args.processId.trim() : "";
          const hub = runtime.procMessageHub;
          if (!hub || typeof hub.sendToProcess !== "function" || typeof hub.listProcsByAgent !== "function") {
            log.error("[LocalCmd] proc_send 调用时消息中枢不可用", { agentId, processId, toolName });
            return { error: "proc_hub_unavailable" };
          }
          // 校验：text/payload 至少一项；payload 须为普通对象（字符串会被展开成 {0:'h',1:'i'} 乱码）
          const hasText = typeof args?.text === "string" && args.text.length > 0;
          const hasPayload = args?.payload !== undefined && args?.payload !== null;
          if (!hasText && !hasPayload) {
            return { error: "proc_empty_message", message: "text 与 payload 至少提供一个" };
          }
          if (hasPayload && (typeof args.payload !== "object" || Array.isArray(args.payload))) {
            return { error: "proc_invalid_payload", message: "payload 必须是对象（如 { url: '...' }），不能是字符串或数组" };
          }
          const payload = {
            ...(hasPayload ? args.payload : {}),
            ...(hasText ? { text: args.text } : {})
          };
          let result;
          if (processId) {
            result = hub.sendToProcess(processId, { payload });
          } else {
            const candidates = hub.listProcsByAgent(agentId ?? "");
            if (candidates.length === 0) {
              return { error: "proc_offline", message: "当前没有接入消息协议的在线进程（普通 stdin/stdout 进程请使用 localcmd_send_input）" };
            }
            if (candidates.length > 1) {
              // 错误信息直接给出各进程的 processId（智能体无需再查 localcmd_list 匹配）
              return {
                error: "proc_ambiguous",
                message: "当前有多个接入进程：" + candidates.map((c) => `${c.procName} (processId=${c.processId ?? "未知"})`).join(", ") + "，请传其中一个 processId"
              };
            }
            result = hub.sendToProc(candidates[0].addr, { payload });
          }
          log.info("[LocalCmd] proc_send 结果", { agentId, processId, result });
          return { ok: result.ok === true, ...(result.ok === true ? {} : { error: result.error, processId: result.processId ?? null, addr: result.addr ?? null }) };
        }

        case "localcmd_read_output":
          return await processManager.readOutput(args.processId, {
            offset: args.offset,
            window: args.window
          });

        case "localcmd_get_status": {
          const process = processManager.getProcess(args.processId);
          if (!process) {
            return { ok: false, error: "process_not_found" };
          }
          return { ok: true, process };
        }

        case "localcmd_list":
          return {
            ok: true,
            processes: processManager.listProcesses()
          };

        case "localcmd_kill": {
          // 防御：processManager 未初始化或 kill 不可用时给出明确错误（曾出现 "processManager.kill is not a function"）
          if (!processManager || typeof processManager.kill !== "function") {
            log.error("[LocalCmd] processManager 不可用，无法终止进程", { processId: args.processId });
            return { error: "tool_error", toolName, message: "localcmd 未初始化，无法终止进程" };
          }
          return processManager.kill(args.processId);
        }

        default:
          return { error: "unknown_tool", toolName };
      }
    } catch (err) {
      const message = err?.message ?? String(err);
      log.error("[LocalCmd] 工具调用失败", { toolName, error: message });
      return { error: "tool_error", toolName, message };
    }
  },

  /**
   * 获取系统提示词注入
   * @returns {string}
   */
  getSystemPromptSection() {
    if (!processManager) return "";
    return _buildSystemPrompt();
  },

  /**
   * 启动由外部"进程样对象"驱动的受管进程（remote 模块把 SSH 远程进程桥接为
   * 本地进程的统一入口）。与本地进程共享完全一致的生命周期：日志文件、
   * 自适应解码、live 状态、历史查询、终止语义。
   * @param {string} command - 要执行的命令
   * @param {string[]} [args] - 命令参数
   * @param {{agentId?: string, pushEvents?: boolean, childProcess: object}} options
   * @returns {Promise<{ok: boolean, processId?: string, error?: string}>}
   */
  async spawnExternalProcess(command, args, options) {
    if (!processManager) {
      return { ok: false, error: "localcmd_not_initialized" };
    }
    return processManager.spawnExternalProcess(command, args, options);
  },

  /**
   * 终止指定 agent 的全部运行中进程（remote 删除映射时清理该 agent 的远程进程用）
   * @param {string} agentId - 智能体 ID
   * @returns {{ok: boolean, killed: number}}
   */
  killByAgent(agentId) {
    if (!processManager) {
      return { ok: false, killed: 0, error: "localcmd_not_initialized" };
    }
    return processManager.killByAgent(agentId);
  },

  /**
   * 获取 HTTP API 路由处理器
   * @returns {Function}
   */
  getHttpHandler() {
    return async (req, res, pathParts, body) => {
      const [resource, id, action] = pathParts;

      try {
        // ---- 策略管理 API ----
        if (resource === "policies") {
          // GET /api/modules/localcmd/policies
          if (req.method === "GET" && !id) {
            const all = policyStore.getAll();
            const orgs = {};
            for (const [orgId, policy] of Object.entries(all.orgs)) {
              const agent = runtime.org.getAgent(orgId);
              orgs[orgId] = {
                whitelist: policy.whitelist,
                blacklist: policy.blacklist,
                name: agent?.name || null,
                orgName: runtime.org.getOrgName(orgId) || agent?.name || orgId
              };
            }
            return {
              ok: true,
              orgs,
              defaults: all.defaults
            };
          }

          // POST /api/modules/localcmd/policies/defaults
          if (req.method === "POST" && id === "defaults") {
            await policyStore.setDefaults(body ?? {});
            return { ok: true };
          }

          // POST /api/modules/localcmd/policies/:orgId
          if (req.method === "POST" && id && id !== "defaults") {
            await policyStore.set(id, body ?? {});
            return { ok: true };
          }

          // DELETE /api/modules/localcmd/policies/:orgId
          if (req.method === "DELETE" && id) {
            await policyStore.remove(id);
            return { ok: true };
          }

          return { error: "method_not_allowed", method: req.method, resource };
        }

        // ---- 确认响应 ----
        if (resource === "confirm-response") {
          if (req.method === "POST") {
            const { messageId, allowed, rememberChoice, matchEntry } = body ?? {};

            if (messageId == null) {
              return { error: "missing_messageId" };
            }

            const pending = pendingConfirmations.get(messageId);
            if (!pending) {
              return { error: "confirmation_not_found", messageId };
            }
            pendingConfirmations.delete(messageId);

            // 记住选择：更新策略
            if (rememberChoice && matchEntry) {
              try {
                const currentOrgId = body?.orgId ?? null;
                const current = policyStore.get(currentOrgId);

                if (allowed) {
                  // 加入白名单
                  const whitelist = current.whitelist.filter(
                    e => e.pattern !== matchEntry
                  );
                  whitelist.push({ type: "glob", pattern: matchEntry });
                  // 从黑名单中移除（去重）
                  const blacklist = current.blacklist.filter(
                    e => e.pattern !== matchEntry
                  );
                  const newPolicy = { whitelist, blacklist };
                  if (currentOrgId) {
                    await policyStore.set(currentOrgId, newPolicy);
                  } else {
                    await policyStore.setDefaults(newPolicy);
                  }
                } else {
                  // 加入黑名单
                  const blacklist = current.blacklist.filter(
                    e => e.pattern !== matchEntry
                  );
                  blacklist.push({ type: "glob", pattern: matchEntry });
                  // 从白名单中移除（去重）
                  const whitelist = current.whitelist.filter(
                    e => e.pattern !== matchEntry
                  );
                  const newPolicy = { whitelist, blacklist };
                  if (currentOrgId) {
                    await policyStore.set(currentOrgId, newPolicy);
                  } else {
                    await policyStore.setDefaults(newPolicy);
                  }
                }
              } catch (err) {
                log.error("[LocalCmd] 保存策略失败", {
                  error: err?.message ?? String(err),
                  stack: err?.stack ?? "(no stack)",
                  matchEntry,
                  allowed
                });
              }
            }

            pending.resolve(!!allowed);
            return { ok: true };
          }

          return { error: "method_not_allowed", method: req.method };
        }

        // ---- 历史命令查询 API ----
        if (resource === "history") {
          const url = new URL(req.url, "http://localhost");
          const toInt = (v, d) => { const x = parseInt(v, 10); return Number.isFinite(x) && x >= 0 ? x : d; };

          // GET /api/modules/localcmd/history?agentId=xxx&offset=0&limit=50&search=
          if (req.method === "GET" && !id) {
            const agentId = url.searchParams.get("agentId");
            if (!agentId) {
              return { error: "missing_agentId" };
            }
            const limit = Math.min(toInt(url.searchParams.get("limit"), 50), 200);
            const offset = toInt(url.searchParams.get("offset"), 0);
            const search = url.searchParams.get("search") ?? "";
            const { items, total } = await processManager.listHistory(agentId, { offset, limit, search });
            return { ok: true, items, total, offset, limit };
          }

          // GET /api/modules/localcmd/history/:processId/output?offset=0&window=65536
          if (req.method === "GET" && id && action === "output") {
            const window = Math.min(toInt(url.searchParams.get("window"), 65536), 1024 * 1024);
            const offset = toInt(url.searchParams.get("offset"), 0);
            return await processManager.readOutputByFile(id, { offset, window });
          }

          // DELETE /api/modules/localcmd/history?agentId=xxx
          if (req.method === "DELETE" && !id) {
            const agentId = url.searchParams.get("agentId");
            if (!agentId) {
              return { error: "missing_agentId" };
            }
            return await processManager.deleteHistoryByAgent(agentId);
          }

          return { error: "method_not_allowed", method: req.method, resource };
        }

        // ---- 原有进程查询 API ----
        if (resource === "processes") {
          if (req.method === "GET" && !id) {
            return {
              ok: true,
              processes: processManager.listProcesses()
            };
          }

          if (req.method === "GET" && id) {
            const process = processManager.getProcess(id);
            if (!process) {
              return { error: "process_not_found", processId: id };
            }
            return { ok: true, process };
          }

          // POST /api/modules/localcmd/processes/:processId/input — 面板 stdin 输入
          if (req.method === "POST" && id && action === "input") {
            const input = typeof body?.input === "string" ? body.input : null;
            if (input === null) {
              return { error: "missing_input" };
            }
            return processManager.sendInput(id, input);
          }

          return { error: "method_not_allowed", method: req.method, resource };
        }

        return { error: "not_found", path: pathParts.join("/") };
      } catch (err) {
        const message = err?.message ?? String(err);
        log.error("[LocalCmd] HTTP 处理器错误", { error: message });
        return { error: "handler_error", message };
      }
    };
  },

  /**
   * 获取 Web 组件信息（模块管理面板）
   * @returns {{moduleName: string, displayName: string, icon: string, panelPath: string}}
   */
  getWebComponent() {
    return {
      moduleName: "localcmd",
      displayName: "命令执行管理",
      icon: "\uD83D\uDCBB",
      panelPath: "modules/localcmd/web/panel.html"
    };
  },

  /**
   * 关闭模块并释放资源
   * @returns {Promise<void>}
   */
  async shutdown() {
    log.info("[LocalCmd] 模块开始关闭");

    // 拒绝所有待处理的确认
    for (const [messageId, pending] of pendingConfirmations) {
      pending.reject(new Error("module_shutdown"));
    }
    pendingConfirmations.clear();

    // 先推送剩余批次，再终止子进程（killAll 触发的 close 事件在推送器关闭后被忽略）
    if (processEventPusher) {
      processEventPusher.shutdown();
      processEventPusher = null;
    }

    if (processManager) {
      await processManager.killAll();
    }

    processManager = null;
    policyStore = null;
    runtime = null;

    log.info("[LocalCmd] 模块已关闭");
  }
};

/**
 * 将 PolicyEntry 格式化为可读的字符串
 * - regex: "regex:pattern"
 * - glob: "pattern"
 * - 旧字符串兼容: 原样返回
 * @param {any} entry
 * @returns {string}
 */
function formatEntry(entry) {
  if (!entry) return "";
  if (typeof entry === "string") return entry;
  if (entry.type === "regex") return "regex:" + entry.pattern;
  return entry.pattern || "";
}

/**
 * 构建系统提示词（包含策略信息）
 * @returns {string}
 */
function _buildSystemPrompt() {
  let prompt = processManager.getSystemPromptSection();

  // 使用优先级（重要）：工作区自动化文件处理应优先使用 sandbox
  prompt += "\n\n【使用优先级（重要）】\n" +
    "工作区内和已授权的路径下自动化文件处理（读取、转换、生成、批量修改文件等）应优先使用 sandbox（沙箱 JS），而不是 localcmd。\n" +
    "localcmd 需要权限审核，可能被拒绝或需要用户确认而中断流程；sandbox 无需权限、直接读写工作区文件。\n" +
    "仅在 sandbox 无法完成（需要网络、需要调用外部命令、需要运行非 JavaScript 程序）时才使用 localcmd。";

  // 服务器进程消息协议（P3）：告知智能体创建的进程可接入消息总线。
  // 写法以「完整可照抄的模板」为核心——LLM 对代码骨架的遵循远好于对要点描述的遵循（真实 LLM 验证结论）。
  prompt += "\n\n【服务器进程消息协议】\n" +
    "你用 localcmd_spawn 启动长期运行的进程时，传 procName 参数（如 procName=\"监控\"，名下唯一）即可接入消息协议，\n" +
    "平台自动注入全部连接配置（禁止自造 stdin/stdout 协议）。进程代码模板：\n" +
    "```js\n" +
    "// ---- 接入部分：原样保留，只有这一行 ----\n" +
    "const { proc } = await import(process.env.SOCIETY_PROC_GLUE_URL);\n" +
    "// ---- 业务部分：按需修改 ----\n" +
    "proc.onMessage((msg) => {                 // 收我下发的指令，msg = { ...payload, text }\n" +
    "  if (msg.text === \"开始\") proc.send({ text: \"已开始\" });\n" +
    "});\n" +
    "proc.notifyWeb(\"progress\", { percent: 0 }); // 定时调用即可向网页推送进度\n" +
    "```\n" +
    "【proc 对象只有以下四个方法，不存在其他任何方法（没有 proc.log / proc.sendTo 等），不要自己发明】：\n" +
    "- proc.send({ text })：发给你（智能体），以【服务器进程消息·进程名】进你的会话；\n" +
    "- proc.notifyWeb(event, data)：把事件实时推送到网页——这是进程把信息送到用户屏幕的唯一途径；页面 JS 也能直接订阅收到，见下文【网页页面 ⇄ 进程双向通信】；\n" +
    "- proc.onRequest(handler)：收网页发来的 HTTP 请求（handler 收 {method,path,query,headers,body}，返回 {status,headers?,body?}，可异步）；\n" +
    "- await proc.close()：进程退出前调用。\n" +
    "凡是要让用户在网页上看到的进度/状态/结果，必须用 proc.notifyWeb；\n" +
    "proc_send 工具是你向进程下发指令的方式：名下只有一个接入进程时禁止传 processId（系统自动匹配），多个接入进程时才传。\n" +
    "未接入的普通进程仍走 localcmd_send_input / localcmd_read_output，两种方式可并存。\n" +
    "\n" +
    "【网页页面 ⇄ 进程双向通信（双向都是实时推送，无需任何轮询）】\n" +
    "页面 ⇄ 进程的界面由 ui_page 工具组的 JS 注入实现（未配 ui_page 组时你没有创建页面的能力）。\n" +
    "两个方向都有平台内建推送，页面代码禁止自造 /api/poll 之类的轮询接口：\n" +
    "① 进程 → 页面（推送）：进程调 proc.notifyWeb(event, data) 后，页面 JS 订阅 window 的 \"proc-event\" 事件即可实时收到——\n" +
    "```html\n" +
    "<script>\n" +
    "  window.addEventListener(\"proc-event\", (e) => {\n" +
    "    const p = e.detail.payload;        // { procName, event, data, ts }\n" +
    "    if (p.event === \"progress\") updateProgress(p.data);   // 例：更新进度条\n" +
    "  });\n" +
    "</script>\n" +
    "```\n" +
    "② 页面 → 进程（请求）：页面 fetch 同源相对路径即达进程（经平台 HTTP 桥转发，进程不监听端口）——fetch(\"/api/proc-http/进程名/路径\")：\n" +
    "```html\n" +
    "<script>\n" +
    "  const r = await fetch(\"/api/proc-http/widget-server/api/data\", {\n" +
    "    method: \"POST\",\n" +
    "    headers: { \"Content-Type\": \"application/json\" },\n" +
    "    body: JSON.stringify({ text: \"用户输入\" })\n" +
    "  });\n" +
    "  const data = await r.json();   // 进程 onRequest 返回的 {status, body}\n" +
    "</script>\n" +
    "```\n" +
    "进程侧用 proc.onRequest 接住这些请求：\n" +
    "```js\n" +
    "proc.onRequest(async (req) => {            // req = { method, path, query, headers, body }\n" +
    "  if (req.path === \"/api/data\") {\n" +
    "    return { status: 200, body: { ok: true, received: req.body } };\n" +
    "  }\n" +
    "  return { status: 404, body: { error: \"not_found\" } };\n" +
    "});\n" +
    "```\n" +
    "页面经此通道发出的内容不会进你的会话（那是 proc.send 的通道）；要让页面上的用户输入同时给你处理，\n" +
    "在 onRequest 里收到后用 proc.send 转发给你——不要发明自定义文本标记协议来路由消息。";

  // 附加策略信息
  if (policyStore) {
    const all = policyStore.getAll();
    const allBlacklist = new Set();
    const allWhitelist = new Set();

    for (const policy of Object.values(all.orgs)) {
      for (const entry of (policy.blacklist || [])) allBlacklist.add(formatEntry(entry));
      for (const entry of (policy.whitelist || [])) allWhitelist.add(formatEntry(entry));
    }
    for (const entry of (all.defaults.blacklist || [])) allBlacklist.add(formatEntry(entry));
    for (const entry of (all.defaults.whitelist || [])) allWhitelist.add(formatEntry(entry));

    const policyLines = [];

    if (allBlacklist.size > 0) {
      policyLines.push("- 自动拒绝: " + [...allBlacklist].join(", "));
    }
    if (allWhitelist.size > 0) {
      policyLines.push("- 自动放行: " + [...allWhitelist].join(", "));
    }
    if (policyLines.length > 0) {
      policyLines.unshift("【命令策略】以下命令会受到管控，请不要重复尝试已被拒绝的命令：");
      prompt += "\n\n" + policyLines.join("\n");
    }
  }

  return prompt;
}
