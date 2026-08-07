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
import { getWorkspaceManager } from "../../src/platform/services/workspace/workspace_manager.js";

/** @type {ProcessManager|null} */
let processManager = null;

/** @type {PolicyStore|null} */
let policyStore = null;

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
  toolGroupDescription: "本地命令执行工具，支持长期运行的交互式进程，输出写入文件",

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
              { cwd: resolvedCwd, env: args.env, agentId }
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
                { cwd: resolvedCwd, env: args.env, agentId }
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
                  { cwd: resolvedCwd, env: args.env, agentId }
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

        case "localcmd_kill":
          return processManager.kill(args.processId);

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
