/**
 * MoodService — 智能体心情颜色模块
 *
 * 职责：
 * - 监听 computeStatusChange 事件（idle），每5轮触发心情请求
 * - 通过独立 LLM 服务分析对话历史生成 5 个 CSS RGB 颜色
 * - 持久化 {colors, roundCount} 到磁盘（每次直接读写文件，不缓存）
 * - 通过心跳广播 mood_colors 消息给前端
 *
 * 设计原则：
 * - 纯消费模块：只监听事件、产生副作用，不暴露接口给外部调用
 * - 通过 ModuleRegistry DI 获取所有依赖，零耦合
 */

import { registry } from "../../core/module_registry.js";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export class MoodService {
  constructor({ logRoot, configService, heartbeatBroker, runtimeEvents, llmConversations, agentLlmClients, dataDir }) {
    this.log = logRoot.forModule("mood");
    this.configService = configService;
    this.heartbeatBroker = heartbeatBroker;
    this.runtimeEvents = runtimeEvents;
    this.llmConversations = llmConversations;
    this.agentLlmClients = agentLlmClients;
    this.dataDir = dataDir;

    /** @type {Map<string, number>} agentId -> 上次广播的 heartbeat messageId */
    this._moodMessageIds = new Map();
  }

  /**
   * 初始化：监听 idle 事件，在每轮对话结束后触发轮次计数。
   */
  async init() {
    this.runtimeEvents.onComputeStatusChange((event) => {
      if (event.status !== "idle") return;
      this._onAgentIdle(event.agentId);
    });
  }

  /**
   * agent 进入 idle 时：递增轮次计数，每5轮触发一次心情请求。
   * @param {string} agentId
   */
  async _onAgentIdle(agentId) {
    if (agentId === "root" || agentId === "user") return;

    const config = this.configService.getLoadedApp();
    if (!config?.moodColors?.enabled) return;

    try {
      const moodPath = path.join(this.dataDir, "agents", agentId, "mood.json");
      let data;
      try {
        const raw = await readFile(moodPath, "utf8");
        const parsed = JSON.parse(raw);
        // 兼容旧格式（数组）→ 新格式（对象）
        if (Array.isArray(parsed)) {
          // 旧格式：5×N 滑动网格，取每行最后一列作为当前颜色
          const colors = [];
          for (const row of parsed) {
            if (Array.isArray(row) && row.length > 0) {
              colors.push(row[row.length - 1]);
            }
          }
          // 如果取不满5个，补透明
          while (colors.length < 5) colors.push("transparent");
          data = { colors: colors.slice(0, 5), roundCount: 0 };
        } else {
          data = { colors: parsed.colors || [], roundCount: parsed.roundCount || 0 };
        }
      } catch {
        data = { colors: [], roundCount: 0 };
      }

      data.roundCount += 1;
      await mkdir(path.dirname(moodPath), { recursive: true });
      await writeFile(moodPath, JSON.stringify(data, null, 2), "utf8");

      if (data.roundCount % 5 === 0) {
        void this._requestMood(agentId);
      }
    } catch (err) {
      void this.log.error("[MoodService] 轮次计数失败", {
        agentId,
        message: err?.message ?? String(err),
        stack: err?.stack ?? "(no stack)"
      });
    }
  }

  /**
   * 请求独立 LLM 分析对话生成心情颜色。
   * fire-and-forget，不阻塞主流程。
   * @param {string} agentId
   */
  async _requestMood(agentId) {
    try {
      void this.log.info("[MoodService] 开始心情请求", { agentId });

      // 获取对话历史最后 5 组 (user, assistant) 对，排除 tool 消息
      const conv = this.llmConversations.getConversation(agentId) ?? [];
      const pairs = [];
      for (let i = conv.length - 1; i >= 0 && pairs.length < 5; i--) {
        if (conv[i].role === "tool") continue;
        if (conv[i].role === "assistant") {
          let userIdx = i - 1;
          while (userIdx >= 0 && conv[userIdx].role !== "user") userIdx--;
          if (userIdx >= 0) {
            pairs.unshift({ assistant: conv[i], user: conv[userIdx] });
            i = userIdx;
          }
        }
      }
      if (pairs.length === 0) {
        void this.log.info("[MoodService] 没有足够的对话对，跳过心情请求", { agentId, convLength: conv.length });
        return;
      }

      const historyMessages = [];
      for (const pair of pairs) {
        historyMessages.push({ role: "user", content: typeof pair.user.content === "string" ? pair.user.content.slice(0, 2000) : "" });
        historyMessages.push({ role: "assistant", content: typeof pair.assistant.content === "string" ? pair.assistant.content.slice(0, 2000) : "" });
      }

      const system = "你是一个心情颜色助手。你必须只调用 set_mood 工具来提交 5 个 CSS RGB 颜色，不要输出任何文字回复。颜色应反映以下对话的情感倾向：温暖色调表示积极/热情，冷色调表示冷静/分析，暗色调表示严肃/深入。";

      // 使用独立的 LLM 服务（不与 agent 争资源）
      const config = this.configService.getLoadedApp();
      const serviceId = config?.moodColors?.llmServiceId ?? null;
      const llmClient = serviceId ? await this.agentLlmClients.getClientForService(serviceId) : null;
      if (!llmClient) {
        void this.log.warn("[MoodService] 无法获取独立的 LLM 客户端", { agentId, serviceId });
        return;
      }

      const msg = await llmClient.chatSimple({
        messages: historyMessages,
        system,
        tools: [{
          type: "function",
          function: {
            name: "set_mood",
            description: "设置智能体当前心情的 5 个 CSS RGB 颜色",
            parameters: {
              type: "object",
              properties: {
                colors: {
                  type: "array",
                  items: { type: "string" },
                  minItems: 5,
                  maxItems: 5
                }
              },
              required: ["colors"]
            }
          }
        }]
      });

      void this.log.info("[MoodService] 心情 LLM 已返回", {
        agentId,
        hasToolCalls: Boolean(msg?.tool_calls?.length),
        toolCount: msg?.tool_calls?.length ?? 0
      });

      // msg 来自 LLM 外部数据，允许 ?. 检查
      if (msg?.tool_calls && msg.tool_calls.length > 0) {
        const moodCall = msg.tool_calls.find(tc => tc.function?.name === "set_mood");
        if (moodCall) {
          let args = moodCall.function?.arguments;
          if (typeof args === "string") {
            try { args = JSON.parse(args); } catch { args = null; }
          }
          if (args?.colors && Array.isArray(args.colors) && args.colors.length === 5) {
            const colors = args.colors.filter(c => typeof c === "string");
            if (colors.length === 5) {
              void this._applyMoodColors(agentId, colors);
              void this.log.info("[MoodService] 心情颜色已更新", { agentId, colors });
            } else {
              void this.log.info("[MoodService] 颜色参数校验失败（非字符串）", { agentId, colors });
            }
          } else {
            void this.log.info("[MoodService] set_mood 参数无效", { agentId });
          }
        }
      }
    } catch (err) {
      void this.log.error("[MoodService] 心情请求异常", {
        agentId,
        message: err?.message ?? String(err),
        stack: err?.stack ?? "(no stack)"
      });
    }
  }

  /**
   * 整体替换：读取 mood.json，更新 colors，写回文件并广播。
   * @param {string} agentId
   * @param {string[]} colors - 5 个 CSS RGB 颜色字符串
   */
  async _applyMoodColors(agentId, colors) {
    try {
      const moodPath = path.join(this.dataDir, "agents", agentId, "mood.json");
      let data;
      try {
        const raw = await readFile(moodPath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          data = { colors: [], roundCount: 0 };
        } else {
          data = { colors: parsed.colors || [], roundCount: parsed.roundCount || 0 };
        }
      } catch {
        data = { colors: [], roundCount: 0 };
      }

      data.colors = colors;
      await mkdir(path.dirname(moodPath), { recursive: true });
      await writeFile(moodPath, JSON.stringify(data, null, 2), "utf8");
      this._broadcastColors(agentId, colors);
    } catch (err) {
      void this.log.error("[MoodService] 应用心情颜色失败", {
        agentId,
        message: err?.message ?? String(err),
        stack: err?.stack ?? "(no stack)"
      });
    }
  }

  /**
   * 通过心跳广播心情颜色给所有前端客户端。
   * 清除同 agent 的旧消息，确保同一时刻只有一个 mood_colors 消息。
   * @param {string} agentId
   * @param {string[]} colors - 5 个 CSS RGB 颜色字符串
   */
  _broadcastColors(agentId, colors) {
    if (!colors) return;
    const prevId = this._moodMessageIds.get(agentId);
    if (prevId != null) {
      this.heartbeatBroker.clearMessage(prevId);
    }
    const newId = this.heartbeatBroker.broadcast("mood_colors", { agentId, colors });
    this._moodMessageIds.set(agentId, newId);
  }
}

registry.declare({
  name: "mood-service",
  requires: ["logRoot", "configService", "heartbeatBroker", "runtimeEvents", "llmConversations", "agentLlmClients", "dataDir"],
  provides: ["moodService"],
  async init(deps) {
    const service = new MoodService(deps);
    await service.init();
    return { moodService: service };
  }
});
