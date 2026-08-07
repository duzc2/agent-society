/**
 * KnowledgeTreeSystem - 知识树子系统统一入口
 *
 * 持有 Manager / Agent 实例，
 * 对外暴露 initialize / checkAndExtract / extractKnowledge /
 * checkAndMaintain / maintainKnowledge / getKnowledgeContext 六个方法。
 *
 * @module services/knowledge_tree/knowledge_tree_system
 */

import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { KnowledgeTreeManager } from "./knowledge_tree_manager.js";

export class KnowledgeTreeSystem {
  /**
   * @param {object} runtime - Runtime 实例引用
   */
  constructor(runtime) {
    this.runtime = runtime;

    /** @type {KnowledgeTreeManager} */
    this.manager = new KnowledgeTreeManager(runtime);

    /** @type {object|null} Agent 实例，defer 到首次使用时初始化 */
    this._agent = null;

    /** @type {object|null} */
    this._config = null;
  }

  // -------------------------------------------------------------------------
  // 初始化
  // -------------------------------------------------------------------------

  /**
   * 加载配置、初始化 Manager
   */
  async initialize() {
    try {
      // 加载独立配置文件
      const configPath = path.join(this.runtime.dataDir, "..", "config", "knowledge_tree.json");
      try {
        const raw = await readFile(configPath, "utf-8");
        this._config = JSON.parse(raw);
      } catch {
        this._config = { enabled: true };
        this.runtime.log.info("[KnowledgeTree] 配置文件不存在，使用默认值");
      }

      if (this._config.enabled === false) {
        this.runtime.log.info("[KnowledgeTree] 已禁用");
        return;
      }

      await this.manager.initialize();
      this.runtime.log.info("[KnowledgeTree] 初始化完成");
    } catch (err) {
      this._config = null;
      this.runtime.log.warn("[KnowledgeTree] 初始化失败", { error: err.message, stack: err.stack, name: err?.name, code: err?.code });
    }
  }

  // -------------------------------------------------------------------------
  // 提取游标
  // -------------------------------------------------------------------------

  /**
   * 读取提取游标
   */
  async _getExtractionState(agentId) {
    const dir = path.join(this.runtime.dataDir, "agents", agentId, "knowledge-tree");
    const stateFile = path.join(dir, "_extraction_state.json");
    try {
      const raw = await readFile(stateFile, "utf-8");
      const state = JSON.parse(raw);
      return {
        lastExtractedIdx: state.lastExtractedIdx ?? -1,
        lastExtractedAt: state.lastExtractedAt ?? null,
      };
    } catch {
      return { lastExtractedIdx: -1, lastExtractedAt: null };
    }
  }

  // -------------------------------------------------------------------------
  // 公开方法
  // -------------------------------------------------------------------------

  /**
   * 每个对话回合结束后调用，自动检查是否需要提取
   * @param {string} agentId
   */
  async checkAndExtract(agentId) {
    // 如果已禁用或未初始化则跳过
    if (!this._config) return;

    // 跳过 root 和 user 这两个内置智能体
    if (agentId === "root" || agentId === "user") return;

    try {
      const trigger = this._config.extractionTrigger ?? {};
      const minMsg = trigger.minMessageCount ?? 20;
      const minChar = trigger.minCharCount ?? 5000;
      const minInterval = trigger.minIntervalMinutes ?? 30;

      // 读取游标，获取增量消息
      const state = await this._getExtractionState(agentId);
      const conv = this.runtime._conversations.get(agentId);
      const allMessages = conv ?? [];

      // 过滤 user / assistant 角色的消息（排除 system / tool）
      const meaningfulMessages = allMessages.filter(m => m.role === "user" || m.role === "assistant");
      const lastIdx = state.lastExtractedIdx ?? -1;
      const newMessages = meaningfulMessages.slice(lastIdx + 1);

      this.runtime.log.info("[KnowledgeTree] 回合结束检查", {
        agentId,
        totalConv: allMessages.length,
        meaningfulTotal: meaningfulMessages.length,
        lastExtractedIdx: lastIdx,
        newCount: newMessages.length,
        minMsg,
        minChar,
        newCharCount: newMessages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0),
        lastExtractedAt: state.lastExtractedAt,
        minInterval,
      });

      if (newMessages.length === 0) return;

      // 阈值检查
      const msgCountOk = newMessages.length >= minMsg;
      const newCharCount = newMessages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
      const charCountOk = newCharCount >= minChar;
      const intervalOk = state.lastExtractedAt
        ? (Date.now() - new Date(state.lastExtractedAt).getTime()) / 60000 >= minInterval
        : true;

      if (!msgCountOk && !charCountOk && !intervalOk) {
        this.runtime.log.info("[KnowledgeTree] 阈值未满足，跳过提取", {
          agentId, msgCountOk, charCountOk, intervalOk, newCount: newMessages.length,
        });
        return;
      }

      // 前置轻量检查
      if (newMessages.every(m => m.role === "tool")) return;

      // 触发提取
      this.runtime.log.info("[KnowledgeTree] 触发知识提取", { agentId, newCount: newMessages.length });
      const result = await this.extractKnowledge(agentId, newMessages);

      // 提取成功后更新游标
      if (result.ok) {
        await this._saveExtractionState(agentId, {
          lastExtractedIdx: meaningfulMessages.length - 1,
          lastExtractedAt: new Date().toISOString(),
        });
        this.runtime.log.info("[KnowledgeTree] 提取完成", {
          agentId,
          report: result.report?.slice(0, 100),
          changeCount: result.changes?.length ?? 0,
        });
      } else {
        this.runtime.log.warn("[KnowledgeTree] 提取失败", { agentId, error: result.error, stack: result.stack });
      }
    } catch (err) {
      this.runtime.log.warn("[KnowledgeTree] checkAndExtract 失败", { agentId, error: err.message, stack: err.stack, name: err?.name, code: err?.code });
    }
  }

  /**
   * 从指定智能体的对话中提取知识
   * @param {string} agentId
   * @param {object[]} messages 对话消息数组
   * @returns {Promise<{ ok: boolean, report?: string, changes?: object[], error?: string }>}
   */
  async extractKnowledge(agentId, messages) {
    if (!this._config) return { ok: false, error: "知识树未启用" };

    // 获取 LLM 客户端（提取用默认 LLM）
    const llmClient = this.runtime.llm ?? null;
    if (!llmClient) return { ok: false, error: "无可用的 LLM 客户端" };

    const agent = await this._getOrCreateAgent();
    return await agent.extractKnowledge(agentId, llmClient, messages);
  }

  /**
   * 从知识树检索上下文，注入到对话消息中
   * @param {string} agentId
   * @param {string} query 检索关键词
   * @returns {Promise<string|null>} 格式化文本或 null
   */
  async getKnowledgeContext(agentId, query) {
    if (!this._config) return null;
    if (this._config.retrieval?.enabled === false) return null;

    const llmClient = this.runtime.llm ?? null;
    if (!llmClient) return null;

    try {
      const recentMessages = this.runtime._conversations.get(agentId)?.slice(-20) ?? [];
      const agent = await this._getOrCreateAgent();
      const rawResult = await agent.retrieveKnowledge(agentId, llmClient, recentMessages, query);
      const result = rawResult?.replace(/^【检索结果】/, '【知识树上下文】');
      return result;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 公开：维护存量
  // -------------------------------------------------------------------------

  /**
   * 每个对话回合结束后调用，自动检查是否需要维护存量条目
   * 与提取不同：维护不需要增量消息，只看 INDEX.md 判断条目总量和结构
   * @param {string} agentId
   */
  async checkAndMaintain(agentId) {
    if (!this._config) return;
    if (agentId === "root" || agentId === "user") return;

    try {
      const trigger = this._config.maintenanceTrigger ?? {};
      const minMsg = trigger.minMessageCount ?? 100;
      const minInterval = trigger.minIntervalMinutes ?? 240; // 默认每 4 小时

      // 读取维护游标
      const state = await this._getMaintenanceState(agentId);

      // 计算与上次维护的消息增量
      const conv = this.runtime._conversations.get(agentId);
      const allMessages = conv ?? [];
      const meaningfulMessages = allMessages.filter(m => m.role === "user" || m.role === "assistant");
      const lastIdx = state.lastMaintainedIdx ?? -1;
      const newMessages = meaningfulMessages.slice(lastIdx + 1);

      if (newMessages.length === 0) return;

      const msgCountOk = newMessages.length >= minMsg;
      const intervalOk = state.lastMaintainedAt
        ? (Date.now() - new Date(state.lastMaintainedAt).getTime()) / 60000 >= minInterval
        : true;

      if (!msgCountOk && !intervalOk) {
        return;
      }

      // 前置检查：知识树条目太少则跳过
      const indexPath = path.join(this.runtime.dataDir, "agents", agentId, "knowledge-tree", "INDEX.md");
      try {
        const indexContent = await readFile(indexPath, "utf-8");
        const entryLines = indexContent.split("\n").filter(l => l.startsWith("- **"));
        if (entryLines.length < trigger.minEntryCount ?? 20) {
          // 条目太少，无需维护
          await this._saveMaintenanceState(agentId, {
            lastMaintainedIdx: meaningfulMessages.length - 1,
            lastMaintainedAt: new Date().toISOString(),
          });
          return;
        }
      } catch {
        // INDEX.md 不存在，跳过
        return;
      }

      this.runtime.log.info("[KnowledgeTree] 触发知识树维护", { agentId, newSinceLast: newMessages.length });
      const result = await this.maintainKnowledge(agentId);

      if (result.ok) {
        await this._saveMaintenanceState(agentId, {
          lastMaintainedIdx: meaningfulMessages.length - 1,
          lastMaintainedAt: new Date().toISOString(),
        });
        this.runtime.log.info("[KnowledgeTree] 维护完成", {
          agentId,
          report: result.report?.slice(0, 100),
          changeCount: result.changes?.length ?? 0,
        });
      } else {
        this.runtime.log.warn("[KnowledgeTree] 维护失败", { agentId, error: result.error, stack: result.stack });
      }
    } catch (err) {
      this.runtime.log.warn("[KnowledgeTree] checkAndMaintain 失败", { agentId, error: err.message, stack: err.stack, name: err?.name, code: err?.code });
    }
  }

  /**
   * 执行存量知识条目的维护（合并、归档、删除）
   * @param {string} agentId
   * @returns {Promise<{ ok: boolean, report?: string, changes?: object[], error?: string }>}
   */
  async maintainKnowledge(agentId) {
    if (!this._config) return { ok: false, error: "知识树未启用" };

    const llmClient = this.runtime.llm ?? null;
    if (!llmClient) return { ok: false, error: "无可用的 LLM 客户端" };

    const agent = await this._getOrCreateAgent();
    return await agent.maintainKnowledge(agentId, llmClient);
  }

  // -------------------------------------------------------------------------
  // 私有：维护游标
  // -------------------------------------------------------------------------

  async _getMaintenanceState(agentId) {
    const dir = path.join(this.runtime.dataDir, "agents", agentId, "knowledge-tree");
    const stateFile = path.join(dir, "_maintenance_state.json");
    try {
      const raw = await readFile(stateFile, "utf-8");
      const state = JSON.parse(raw);
      return {
        lastMaintainedIdx: state.lastMaintainedIdx ?? -1,
        lastMaintainedAt: state.lastMaintainedAt ?? null,
      };
    } catch {
      return { lastMaintainedIdx: -1, lastMaintainedAt: null };
    }
  }

  async _saveMaintenanceState(agentId, state) {
    try {
      const dir = path.join(this.runtime.dataDir, "agents", agentId, "knowledge-tree");
      await mkdir(dir, { recursive: true });
      const stateFile = path.join(dir, "_maintenance_state.json");
      await writeFile(stateFile, JSON.stringify(state, null, 2), "utf-8");
    } catch {
      // 保存失败不影响主流程
    }
  }

  // -------------------------------------------------------------------------
  // 私有：Agent 延迟初始化
  // -------------------------------------------------------------------------

  async _getOrCreateAgent() {
    if (!this._agent) {
      const { KnowledgeTreeAgent } = await import("./knowledge_tree_agent.js");
      const promptsDir = path.join(path.dirname(new URL(import.meta.url).pathname), "prompts");
      this._agent = new KnowledgeTreeAgent({
        manager: this.manager,
        promptsDir,
      });
    }
    return this._agent;
  }

  // -------------------------------------------------------------------------
  // 私有：提取游标持久化
  // -------------------------------------------------------------------------

  /**
   * 保存提取游标状态
   */
  async _saveExtractionState(agentId, state) {
    try {
      const dir = path.join(this.runtime.dataDir, "agents", agentId, "knowledge-tree");
      await mkdir(dir, { recursive: true });
      const stateFile = path.join(dir, "_extraction_state.json");
      await writeFile(stateFile, JSON.stringify(state, null, 2), "utf-8");
    } catch {
      // 保存失败不影响主流程
    }
  }
}
