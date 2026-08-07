/**
 * ReplyManager - 智能体回复管理器
 *
 * 职责：管理智能体回复的重新生成、建议回复等功能。
 *
 * @module runtime/reply_manager
 */

import { randomUUID } from "node:crypto";
import { getErrorMessage } from "../utils/error_utils.js";

export class ReplyManager {
  constructor(runtime) {
    this.runtime = runtime;
  }

  /**
   * 重新生成指定智能体最后一条 assistant 回复。
   * 该流程会先截断会话中的最后一条 assistant 消息，再复用现有调度器重新发起 LLM 回合。
   * @param {string} agentId
   * @param {string} messageId
   * @param {{responseTarget?:string|null, taskId?:string|null}} [options]
   * @returns {Promise<{ok:boolean, turnId?:string, removedMessageIds?:string[], error?:string, status?:string, message?:string}>}
   */
  async regenerateLastAssistantReply(agentId, messageId, options = {}) {
    const normalizedAgentId = String(agentId ?? "").trim();
    const normalizedMessageId = String(messageId ?? "").trim();

    if (!normalizedAgentId) {
      return { ok: false, error: "missing_agent_id" };
    }
    if (!normalizedMessageId) {
      return { ok: false, error: "missing_message_id" };
    }

    const agent = this.runtime._agents.get(normalizedAgentId);
    if (!agent) {
      return { ok: false, error: "agent_not_found" };
    }

    const status = this.runtime.getAgentComputeStatus(normalizedAgentId);
    if (status !== "idle") {
      return { ok: false, error: "agent_not_idle", status: status ?? "unknown" };
    }

    const conversationManager = this.runtime._conversationManager;
    if (!conversationManager) {
      return { ok: false, error: "conversation_manager_not_initialized" };
    }

    const truncateResult = await conversationManager.truncateLastAssistantMessage(
      normalizedAgentId,
      normalizedMessageId
    );
    if (!truncateResult?.ok) {
      return { ok: false, error: truncateResult?.error || "truncate_failed" };
    }

    try {
      const ctx = this.runtime._buildAgentContext(agent);
      const turnId = await this.runtime._turnEngine.enqueueRegenerateTurn(normalizedAgentId, ctx, {
        responseTarget: options.responseTarget ?? "user",
        taskId: options.taskId ?? null
      });

      /**
       * 这里提前设置为 processing。
       * 需求是 idle 时出现按钮，点击后按钮应立即消失，不应等待下一轮调度再切换状态。
       */
      this.runtime._state.setAgentComputeStatus(normalizedAgentId, "processing");
      this.runtime._computeScheduler.scheduleAgent(normalizedAgentId);

      return {
        ok: true,
        turnId,
        removedMessageIds: truncateResult.removedMessageIds ?? []
      };
    } catch (err) {
      void this.runtime.log.error("重新生成最后一条回复失败", {
        agentId: normalizedAgentId,
        messageId: normalizedMessageId,
        error: err?.message ?? String(err),
        stack: err?.stack ?? null,
        name: err?.name,
        code: err?.code
      });

      await conversationManager.restoreTruncatedMessages(
        normalizedAgentId,
        truncateResult.truncatedFromIndex ?? 0,
        truncateResult.removedMessages ?? []
      );
      this.runtime._state.setAgentComputeStatus(normalizedAgentId, "idle");

      return {
        ok: false,
        error: "regenerate_enqueue_failed",
        message: err?.message ?? String(err)
      };
    }
  }

  /**
   * 对用户最后一条消息生成回复。
   * - 如果有用户消息且有 assistant 回复，使用 enqueueRegenerateTurn 重新生成
   * - 如果有用户消息但没有 assistant 回复，触发调度器继续处理（不重复添加消息）
   * - 如果没有用户消息，使用 bus.send() 发送新消息
   * @param {string} agentId
   * @param {string} [messageContent] - 用户消息内容（可选）
   * @returns {Promise<{ok:boolean, turnId?:string, error?:string, status?:string, message?:string}>}
   */
  async generateReplyForLastUserMessage(agentId, messageContent) {
    const normalizedAgentId = String(agentId ?? "").trim();

    if (!normalizedAgentId) {
      return { ok: false, error: "missing_agent_id" };
    }

    const agent = this.runtime._agents.get(normalizedAgentId);
    if (!agent) {
      return { ok: false, error: "agent_not_found" };
    }

    const status = this.runtime.getAgentComputeStatus(normalizedAgentId);
    if (status !== "idle") {
      return { ok: false, error: "agent_not_idle", status: status ?? "unknown" };
    }

    const ctx = this.runtime._buildAgentContext(agent);
    const conversation = this.runtime._ensureConversation(normalizedAgentId);

    const hasUserMessage = conversation?.some(m => m.role === "user");
    const hasAssistantReply = conversation?.some(m => m.role === "assistant");

    // 情况1：对话中已有用户消息和助手回复，使用 enqueueRegenerateTurn 重新生成
    if (hasUserMessage && hasAssistantReply) {
      const turnId = await this.runtime._turnEngine.enqueueRegenerateTurn(normalizedAgentId, ctx, {
        responseTarget: "user"
      });
      this.runtime._state.setAgentComputeStatus(normalizedAgentId, "processing");
      this.runtime._computeScheduler.scheduleAgent(normalizedAgentId);
      return { ok: true, turnId };
    }

    // 情况2：对话中有用户消息但没有助手回复，需要继续处理
    // 使用 enqueueRegenerateTurn 来创建一个新的处理回合
    if (hasUserMessage && !hasAssistantReply) {
      const turnId = await this.runtime._turnEngine.enqueueRegenerateTurn(normalizedAgentId, ctx, {
        responseTarget: "user"
      });
      this.runtime._state.setAgentComputeStatus(normalizedAgentId, "processing");
      this.runtime._computeScheduler.scheduleAgent(normalizedAgentId);
      return { ok: true, turnId };
    }

    // 情况3：对话中没有用户消息（可能对话被清空了或未加载）
    // 根据用户要求：conversation 里没有而页面上有，就要补发这个消息
    if (!messageContent) {
      return { ok: false, error: "need_resend_message" };
    }

    // 直接通过 enqueueMessageTurn 触发处理，不通过 bus.send()
    // 这样消息不会重复存储到 _messagesByAgent
    const message = {
      id: randomUUID(),
      from: "user",
      to: normalizedAgentId,
      payload: { text: messageContent },
      taskId: randomUUID()
    };
    await this.runtime._turnEngine.enqueueMessageTurn(normalizedAgentId, ctx, message);

    this.runtime._state.setAgentComputeStatus(normalizedAgentId, "processing");
    this.runtime._computeScheduler.scheduleAgent(normalizedAgentId);

    return { ok: true };
  }

  /**
   * 为指定智能体生成推荐回复建议。
   *
   * 【设计原则】
   * 1. 上下文隔离：此调用完全绕过 TurnEngine、ConversationManager、ComputeScheduler
   * 2. 只读上下文：从对话管理器中读取最近几条消息作为上下文，不修改任何对话状态
   * 3. 同模型服务：使用智能体相同的 LlmClient 实例（相同模型、提供商、API 密钥）
   *
   * @param {string} agentId - 智能体ID
   * @returns {Promise<{ok: boolean, suggestions: string[], error?: string}>}
   */
  async suggestRepliesForAgent(agentId) {
    const normalizedAgentId = String(agentId ?? "").trim();

    if (!normalizedAgentId) {
      return { ok: false, error: "missing_agent_id" };
    }

    const agent = this.runtime._agents.get(normalizedAgentId);
    if (!agent) {
      return { ok: false, error: "agent_not_found" };
    }

    try {
      // 使用智能体相同的 LlmClient
      const llmClient = await this.runtime.getLlmClientForAgent(normalizedAgentId);
      if (!llmClient) {
        return { ok: false, error: "no_llm_client" };
      }

      // 获取对话上下文（只读）
      const conversation = this.runtime._conversationManager.getConversation(normalizedAgentId);
      const recentExchanges = [];
      if (conversation && Array.isArray(conversation)) {
        // 取最近 16 条消息（8 轮对话）
        const contextMessages = conversation.slice(-16);
        for (const msg of contextMessages) {
          if (msg.role === "user" || msg.role === "assistant") {
            const content = typeof msg.content === "string" ? msg.content : "";
            // 跳过纯工具消息
            if (content && content.trim()) {
              recentExchanges.push({ role: msg.role, content: content.trim() });
            }
          }
        }
      }

      // 构建提示词（system 作为独立字段，不混入 messages 数组）
      const systemPrompt = "You are a helpful suggestion engine. Based on the conversation context, suggest 2-4 natural language replies the user could send next. Each suggestion should be concise (1-2 sentences), directly relevant to the conversation, and written in the same language as the conversation. Output ONLY the numbered suggestions, one per line, in the format: 1. <suggestion>";

      const messages = [];

      if (recentExchanges.length > 0) {
        messages.push({
          role: "user",
          content: "Here is the recent conversation context:\n\n" +
            recentExchanges.map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n") +
            "\n\nBased on the conversation above, suggest 2-4 natural replies the user could send next."
        });
      } else {
        messages.push({
          role: "user",
          content: "The conversation has just started. Suggest 2-4 natural opening messages the user could send to start the conversation with the AI assistant."
        });
      }

      // 初始化客户端并发送完全隔离的 LLM 调用
      const response = await llmClient.chat({ messages, system: systemPrompt, temperature: 0.7 });

      // 提取回复文本
      let responseText = "";
      if (typeof response === "string") {
        responseText = response;
      } else if (response?.content) {
        responseText = response.content;
      } else if (response?.choices?.[0]?.message?.content) {
        responseText = response.choices[0].message.content;
      } else if (response?.text) {
        responseText = response.text;
      }

      // 按行号和分隔符拆分建议
      const suggestions = responseText
        .split(/\n/)
        .map(line => line.replace(/^\d+[\.\)]\s*/, "").trim())
        .filter(s => s.length > 0)
        .slice(0, 4); // 最多 4 条

      if (suggestions.length === 0) {
        return { ok: true, suggestions: [] };
      }

      return { ok: true, suggestions };
    } catch (err) {
      const message = getErrorMessage(err);
      void this.runtime.log.warn("生成推荐回复建议失败", {
        agentId: normalizedAgentId,
        error: message,
        stack: err?.stack,
        name: err?.name,
        code: err?.code
      });
      return { ok: false, error: message, suggestions: [] };
    }
  }
}
