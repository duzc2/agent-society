import { randomUUID } from "node:crypto";
import {
  getUnprocessedMessages,
  updateAgentMemory as _updateAgentMemoryFn,
  maybeUpdateMemory as _maybeUpdateMemoryFn,
} from "./turn_engine_memory.js";
import { extractProviderErrorMessage } from "../utils/error_utils.js";

/**
 * TurnEngine - 回合引擎（协程式：显式状态机 + 续跑）
 *
 * 职责：
 * - 将“处理一条入站消息”抽象为 Turn（回合），并以 step 的方式推进；
 * - 一个 step 只返回一个原子动作：need_llm / need_tool / send / done / noop。
 *
 * 设计约束：
 * - 同一 agent 的对话历史（conv）只允许 TurnEngine 写（单写者），避免并发写入导致乱序；
 * - step() 必须无阻塞：不能直接 await LLM/tool；由外部调度器负责启动异步并在完成后回调。
 */
export class TurnEngine {
  /**
   * @param {any} runtime
   */
  constructor(runtime) {
    this.runtime = runtime;
    /** @type {Map<string, {queue: any[], activeTurn: any|null}>} */
    this._byAgentId = new Map();
  }

  /**
   * 为 agent 入队一条消息回合（支持单条消息或批量消息）。
   * @param {string} agentId
   * @param {any} ctx
   * @param {any|any[]} messages - 单条消息或消息数组
   * @returns {Promise<string>} turnId
   */
  async enqueueMessageTurn(agentId, ctx, messages) {
    const entry = this._ensureEntry(agentId);
    const turnId = randomUUID();

    const conv = this.runtime._ensureConversation(agentId);
    const messageList = Array.isArray(messages) ? messages : [messages];
    const primaryMessage = messageList.length > 0 ? messageList[messageList.length - 1] : null;

    const messageIds = messageList.map(m => {
      const payloadPreview = typeof m.payload === 'object' && m.payload !== null
        ? (m.payload.text ?? JSON.stringify(m.payload).substring(0, 150))
        : String(m.payload ?? '').substring(0, 150);
      return { id: m.id, from: m.from, taskId: m.taskId ?? null, payloadPreview };
    });

    void this.runtime.log.info("[TurnEngine] enqueueMessageTurn 创建 Turn（批量消息）", {
      agentId,
      turnId,
      batchCount: messageList.length,
      primaryMessageId: primaryMessage?.id ?? null,
      messages: messageIds,
      convLength: conv.length,
      queueLengthAfter: entry.queue.length + 1,
      timestamp: Date.now(),
      time: new Date().toISOString()
    });

    const turn = {
      turnId,
      agentId,
      ctx,
      message: primaryMessage,
      batchMessages: messageList,
      conv,
      phase: "init",
      round: 1,
      llmMsg: null,
      pendingToolCalls: [],
      executingToolCall: null,
      lastStepId: 0,
      responseTarget: null,
      taskId: primaryMessage?.taskId ?? null
    };

    entry.queue.push(turn);
    return turnId;
  }

  /**
   * 为"重新生成最后一条回复"入队一个回合。
   * 该回合直接从 need_llm 阶段开始，复用当前对话上下文，不重复写入用户消息。
   * @param {string} agentId
   * @param {any} ctx
   * @param {{responseTarget?:string|null, taskId?:string|null}} [options]
   * @returns {Promise<string>}
   */
  async enqueueRegenerateTurn(agentId, ctx, options = {}) {
    const entry = this._ensureEntry(agentId);
    const turnId = randomUUID();

    const conv = this.runtime._ensureConversation(agentId);

    const turn = {
      turnId,
      agentId,
      ctx,
      message: null,
      conv,
      phase: "need_llm",
      round: 1,
      llmMsg: null,
      pendingToolCalls: [],
      executingToolCall: null,
      lastStepId: 0,
      responseTarget: options.responseTarget ?? "user",
      taskId: options.taskId ?? null
    };

    entry.queue.push(turn);
    return turnId;
  }

  /**
   * 判断某个 agent 是否存在可运行的回合（有 activeTurn 或队列非空）。
   * @param {string} agentId
   * @returns {boolean}
   */
  hasRunnable(agentId) {
    const entry = this._byAgentId.get(agentId);
    if (!entry) return false;
    return !!entry.activeTurn || entry.queue.length > 0;
  }

  /**
   * 可能触发记忆更新（条件：累积10条未处理消息）。
   *
   * 由 ComputeScheduler 在消息入队后调用，不阻塞调度循环。
   *
   * @param {string} agentId - 智能体ID
   * @param {any} currentMessage - 当前收到的消息
   * @param {{epoch:number, signal:AbortSignal, assertActive:() => void}|null} cancelScope - 取消作用域
   * @returns {Promise<void>}
   */
  async maybeUpdateMemory(agentId, currentMessage, cancelScope = null) {
    return _maybeUpdateMemoryFn(agentId, currentMessage, cancelScope, {
      log: this.runtime.log,
      agents: this.runtime._agents,
      org: this.runtime.org,
      conversations: this.runtime._conversations,
      agentMemoryManager: this.runtime.agentMemoryManager,
      getUnprocessedMessagesFn: (conv, lastId) => getUnprocessedMessages(conv, lastId),
    });
  }

  /**
   * 清理某个 agent 的回合队列与活跃回合（用于终止/删除）。
   * @param {string} agentId
   */
  clearAgent(agentId) {
    if (!agentId) return;
    this._byAgentId.delete(agentId);
  }

  /**
   * 推进某个 agent 的一个 step，返回下一步需要的原子动作。
   * @param {string} agentId
   * @param {{epoch:number, signal:AbortSignal, assertActive:() => void}|null} cancelScope
   * @returns {Promise<any>}
   */
  async step(agentId, cancelScope) {
    const entry = this._ensureEntry(agentId);
    const turn = entry.activeTurn ?? entry.queue.shift() ?? null;
    if (!turn) {
      entry.activeTurn = null;
      return { kind: "noop" };
    }
    entry.activeTurn = turn;

    void this.runtime.log.info("[TurnEngine] step() 入口", {
      agentId,
      turnId: turn.turnId,
      phase: turn.phase,
      round: turn.round,
      wasActive: entry.activeTurn === turn && turn === (turn ?? null),
      queueRemaining: entry.queue.length,
      convLength: turn.conv?.length ?? 0,
      timestamp: Date.now(),
      time: new Date().toISOString()
    });

    cancelScope?.assertActive?.();

    if (turn.phase === "init") {
      turn.lastStepId += 1;

      // 格式化所有批量消息，加入 conv
      // 不再通过 trailingText 注入 contextStatus——contextStatus 将在 _startLlm 时放入 system prompt
      const batchMessages = Array.isArray(turn.batchMessages) ? turn.batchMessages : (turn.message ? [turn.message] : []);
      for (let i = 0; i < batchMessages.length; i++) {
        const msg = batchMessages[i];
        const formatted = await this.runtime._formatMessageForLlm(turn.ctx, msg);

        const userMessageId = msg?.id;
        if (!userMessageId) {
          void this.runtime.log.warn("[TurnEngine] 用户消息缺少 ID，生成新 ID", {
            agentId,
            turnId: turn.turnId,
            batchIndex: i,
            messageContent: typeof msg?.payload?.text === 'string' ? msg.payload.text.substring(0, 100) : null
          });
        }

        void this.runtime.log.info("[TurnEngine] init 阶段添加用户消息到 conv", {
          agentId,
          turnId: turn.turnId,
          batchIndex: i,
          totalBatch: batchMessages.length,
          userMessageId: userMessageId,
          messageContentPreview: typeof msg?.payload?.text === 'string' ? msg.payload.text.substring(0, 100) : null,
          convLengthBeforePush: turn.conv.length
        });

        turn.conv.push({ role: "user", content: formatted, id: userMessageId });
      }

      // 构建临时记忆上下文（不持久化到 conv）
      turn.ephemeralMemoryContext = await this.runtime._llm.buildEphemeralContexts(turn.ctx, turn.message);

      turn.phase = "need_llm";
    }

    if (turn.phase === "need_llm") {
      turn.lastStepId += 1;

      // 在 need_llm 阶段构建 system prompt（每次 LLM 调用时从当前状态新鲜构建）
      this.runtime._state.setAgentComputePhase(agentId, "正在准备 system prompt...");
      const systemBase = await this.runtime._buildSystemPromptForAgent(turn.ctx);

      // 知识树检索：在每次 LLM 调用前检索相关知识
      // 只在首次检索时设置，continue 轮不覆盖已有值（避免 null 覆盖有效结果）
      if (turn._ephemeralKnowledgeContext == null) {
        this.runtime._state.setAgentComputePhase(agentId, "正在检索知识...");
        turn._ephemeralKnowledgeContext = await this._retrieveKnowledgeContext(agentId, turn);
      }

      this.runtime._state.setAgentComputePhase(agentId, "正在准备 LLM 请求...");

      // 【安全】必须传 step() 的权威 agentId：生产 ctx（buildAgentContext）只有 agent 字段，
      // 没有 agentId；传 ctx.agentId 恒为 undefined，会触发 getToolDefinitionsForAgent 的
      // 失败关闭兜底（仅 org_management），或曾经触发过"返回全部工具"的权限泄漏。
      const tools = this.runtime.getToolDefinitionsForAgent(agentId);
      turn.phase = "waiting_llm";

      const llmMeta = {
        agentId,
        roleId: turn.ctx.agent?.roleId ?? null,
        roleName: turn.ctx.agent?.roleName ?? null,
        messageId: turn.message?.id ?? null,
        messageFrom: turn.message?.from ?? null,
        taskId: turn.message?.taskId ?? null,
        round: turn.round,
        turnId: turn.turnId,
        stepId: turn.lastStepId,
        cancelEpoch: cancelScope?.epoch ?? null
      };

      return {
        kind: "need_llm",
        agentId,
        turnId: turn.turnId,
        stepId: turn.lastStepId,
        ctx: turn.ctx,
        request: {
          messages: turn.conv,
          systemBase,
          tools,
          meta: llmMeta
        }
      };
    }

    if (turn.phase === "dispatch_tools") {
      if (turn.executingToolCall) {
        return { kind: "noop" };
      }

      if (!Array.isArray(turn.pendingToolCalls) || turn.pendingToolCalls.length === 0) {
        turn.round += 1;
        turn.phase = "need_llm";
        return { kind: "done" };
      }

      const call = turn.pendingToolCalls.shift();
      const toolName = call?.function?.name ?? null;
      const callId = call?.id ?? null;
      let args = {};

      if (!toolName || !callId) {
        return { kind: "done" };
      }

      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch (err) {
        turn.conv.push({
          role: "tool",
          tool_call_id: callId,
          content: JSON.stringify({
            error: "参数解析失败",
            toolName,
            message: err?.message ?? String(err ?? "unknown parse error")
          })
        });
        return { kind: "done" };
      }

      turn.executingToolCall = { toolName, callId, args };
      turn.lastStepId += 1;

      return {
        kind: "need_tool",
        agentId,
        turnId: turn.turnId,
        stepId: turn.lastStepId,
        ctx: turn.ctx,
        call: { toolName, callId, args },
        reasoningContent: turn.llmMsg?.reasoning_content ?? null
      };
    }

    if (turn.phase === "send_text") {
      // 如果经历了 max_tokens 自动续接，拼接所有已生成的 assistant 文本
      let content;
      if (turn._maxTokensContinueCount > 0) {
        const parts = [];
        for (let i = turn.conv.length - 1; i >= 0; i--) {
          if (turn.conv[i].role === "user") break;
          if (turn.conv[i].role === "assistant" && typeof turn.conv[i].content === "string") {
            parts.unshift(turn.conv[i].content.trim());
          }
        }
        content = parts.join("");
      } else {
        content = turn.llmMsg?.content ?? "";
      }

      if (typeof content === "string" && content.trim().length > 0) {
        turn.lastStepId += 1;
        turn.phase = "finished";
        // 提取 token 使用量
        const usage = turn.llmMsg?._usage ?? null;
        // 如果不支持工具调用，则回复给消息的发送者；否则回复给 user
        const recipient = turn.responseTarget
          ?? (
            turn.supportsToolCalling === false && turn.message?.from
              ? turn.message.from
              : "user"
          );

        // 【修复1】确保 assistant 消息有 ID
        const assistantMessageId = turn.llmMsg?.id;
        if (!assistantMessageId) {
          void this.runtime.log.warn("[TurnEngine] assistant 消息缺少 ID，生成新 ID", {
            agentId,
            turnId: turn.turnId,
            llmMsgContent: typeof turn.llmMsg?.content === 'string' ? turn.llmMsg.content.substring(0, 100) : null
          });
          turn.llmMsg.id = randomUUID();
        }

        void this.runtime.log.info("[TurnEngine] send_text 生成回复消息", {
          agentId,
          turnId: turn.turnId,
          continueCount: turn._maxTokensContinueCount ?? 0,
          assistantMessageId: turn.llmMsg.id,
          recipient,
          contentPreview: content.substring(0, 100),
          hasMemoryContext: !!turn.ephemeralMemoryContext,
          memoryContextLen: typeof turn.ephemeralMemoryContext === 'string' ? turn.ephemeralMemoryContext.length : 0,
          hasKnowledgeContext: !!turn._ephemeralKnowledgeContext,
          knowledgeContextLen: typeof turn._ephemeralKnowledgeContext === 'string' ? turn._ephemeralKnowledgeContext.length : 0
        });

        return {
          kind: "send",
          agentId,
          turnId: turn.turnId,
          stepId: turn.lastStepId,
          message: {
            id: turn.llmMsg.id, // 传递生成的 ID 给 Bus
            to: recipient,
            from: agentId,
            taskId: turn.taskId ?? turn.message?.taskId ?? null,
            payload: { text: content.trim(), usage: usage },
            reasoning_content: turn.llmMsg?.reasoning_content ?? null,
            memoryContext: turn.ephemeralMemoryContext ?? null,
            knowledgeContext: turn._ephemeralKnowledgeContext ?? null
          }
        };
      }
      turn.phase = "finished";
      return { kind: "done" };
    }

    if (turn.phase === "finished") {
      entry.activeTurn = null;
      return { kind: "done" };
    }

    return { kind: "noop" };
  }

  /**
   * 接收 LLM 的返回结果并更新回合状态。
   * @param {string} agentId
   * @param {{turnId:string, stepId:number, msg:any, supportsToolCalling?:boolean}} input
   */
  async onLlmResult(agentId, input) {
    const entry = this._byAgentId.get(agentId);
    const turn = entry?.activeTurn ?? null;
    if (!turn) return;
    if (turn.turnId !== input.turnId) return;
    if (turn.phase !== "waiting_llm") return;

    // 保存模型是否支持工具调用的信息
    if (typeof input.supportsToolCalling === "boolean") {
      turn.supportsToolCalling = input.supportsToolCalling;
    }

    turn.llmMsg = input.msg ?? null;
    if (turn.llmMsg) {
      // 为助手消息生成 ID，以便后续删除/修改
      const hadExistingId = !!turn.llmMsg.id;
      if (!turn.llmMsg.id) {
        turn.llmMsg.id = randomUUID();
      }
      turn.conv.push(turn.llmMsg);

      // 【修复1】添加日志追踪 ID
      void this.runtime.log.info("[TurnEngine] onLlmResult 处理助手消息", {
        agentId,
        turnId: turn.turnId,
        hadExistingId,
        llmMsgId: turn.llmMsg.id,
        contentPreview: typeof turn.llmMsg.content === 'string' ? turn.llmMsg.content.substring(0, 100) : null,
        convLengthAfterPush: turn.conv.length
      });

      // 更新 token 使用统计
      const usage = turn.llmMsg._usage ?? null;
      if (usage && this.runtime._conversationManager) {
        this.runtime._conversationManager.updateTokenUsage(agentId, usage);

        // 调试日志
        void this.runtime.log.info("更新 token 使用统计", {
          agentId,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens
        });

        // 触发上下文压缩检查
        await this.runtime._conversationManager.processAutoCompression(agentId);
      }
    }

    const toolCalls = Array.isArray(turn.llmMsg?.tool_calls) ? turn.llmMsg.tool_calls : [];
    
    // 【调试日志】记录 LLM 返回的 tool_calls 原始内容
    void this.runtime.log.info("[LLM_TOOL_CALLS_RAW] LLM 返回的工具调用原始数据", {
      agentId,
      toolCallCount: toolCalls.length,
      toolCallsRaw: JSON.stringify(toolCalls),
      llmMsgContent: turn.llmMsg?.content?.substring?.(0, 200) ?? null
    });
    
    if (toolCalls.length > 0) {
      turn.pendingToolCalls = toolCalls.slice(0);
      turn.executingToolCall = null;
      turn.phase = "dispatch_tools";
      return;
    }

    // 自动续接：当 LLM 因 max_tokens（token 上限）截断输出时，自动发起下一次 LLM 调用继续生成，
    // 避免将不完整的文本直接发送给用户导致对话中断。
    if (turn.llmMsg?._finishReason === "length") {
      turn._maxTokensContinueCount = (turn._maxTokensContinueCount ?? 0) + 1;
      const MAX_CONTINUE_COUNT = 5;
      if (turn._maxTokensContinueCount > MAX_CONTINUE_COUNT) {
        void this.runtime.log.warn("[TurnEngine] max_tokens 连续触发次数过多，停止自动续接", {
          agentId,
          turnId: turn.turnId,
          continueCount: turn._maxTokensContinueCount
        });
        turn.phase = "send_text";
        return;
      }
      void this.runtime.log.info("[TurnEngine] LLM 因 max_tokens 截断，自动续接", {
        agentId,
        turnId: turn.turnId,
        round: turn.round,
        continueCount: turn._maxTokensContinueCount
      });
      turn.round += 1;
      turn.phase = "need_llm";
      return;
    }

    turn.phase = "send_text";
  }

  /**
   * 处理 LLM 错误（最小闭环：直接结束回合）。
   * @param {string} agentId
   * @param {{turnId:string, stepId:number, error:any}} input
   */
  onLlmError(agentId, input) {
    const entry = this._byAgentId.get(agentId);
    const turn = entry?.activeTurn ?? null;
    if (!turn) return;
    if (turn.turnId !== input.turnId) return;

    const originalMessage = input.error?.message ?? String(input.error ?? "unknown llm error");
    const providerMessage = extractProviderErrorMessage(input.error);
    // 用供应商返回的具体原因覆盖 "HTTP 400 Bad Request" 这类通用文案，
    // 让事件 message 与 details.message 都携带可读原因，前端归一化后即可展示。
    // 该错误对象在此路径后不再被使用，覆盖 message 不会影响其他逻辑。
    if (providerMessage && input.error && typeof input.error === "object") {
      input.error.message = providerMessage;
    }
    const message = providerMessage ?? originalMessage;

    void this.runtime.log.error("[TurnEngine] LLM 调用失败", {
      agentId,
      turnId: input.turnId,
      stepId: input.stepId,
      errorType: input.error?.name ?? "UnknownError",
      message,
      originalMessage,
      providerMessage,
      stack: input.error?.stack ?? null,
      details: input.error ?? null
    });

    // 广播错误事件，确保前端能收到通知
    this.runtime._emitError({
      agentId,
      errorType: "llm_error",
      message,
      timestamp: new Date().toISOString(),
      details: input.error
    });

    entry.activeTurn = null;
  }

  /**
   * LLM 请求被取消（通常用于插话场景重试）。
   * 约束：只把 waiting_llm 回退到 need_llm，不清理 turn。
   * @param {string} agentId
   * @param {{turnId:string, stepId:number}} input
   */
  onLlmCancelled(agentId, input) {
    const entry = this._byAgentId.get(agentId);
    const turn = entry?.activeTurn ?? null;
    if (!turn) return;
    if (turn.turnId !== input.turnId) return;
    if (turn.phase !== "waiting_llm") return;
    turn.phase = "need_llm";
  }

  /**
   * 接收工具执行结果并更新回合状态。
   * @param {string} agentId
   * @param {{turnId:string, stepId:number, callId:string, result:any}} input
   */
  onToolResult(agentId, input) {
    const entry = this._byAgentId.get(agentId);
    const turn = entry?.activeTurn ?? null;
    if (!turn) return;
    if (turn.turnId !== input.turnId) return;
    if (turn.phase !== "dispatch_tools") return;

    const executing = turn.executingToolCall;
    if (!executing || executing.callId !== input.callId) return;

    const toolName = executing.toolName;
    const args = executing.args;
    const result = input.result ?? null;

    this.runtime._emitToolCall({
      agentId,
      toolName,
      args,
      result,
      taskId: turn.message?.taskId ?? null,
      callId: executing.callId,
      timestamp: new Date().toISOString(),
      reasoningContent: turn.llmMsg?.reasoning_content ?? null,
      usage: turn.llmMsg?._usage ?? null
    });

    turn.conv.push({
      role: "tool",
      tool_call_id: executing.callId,
      content: JSON.stringify(result)
    });

    turn.executingToolCall = null;
  }

  /**
   * 工具执行失败：把错误作为 tool 消息写入 conv，然后继续。
   * @param {string} agentId
   * @param {{turnId:string, stepId:number, callId:string, error:any}} input
   */
  onToolError(agentId, input) {
    const entry = this._byAgentId.get(agentId);
    const turn = entry?.activeTurn ?? null;
    if (!turn) return;
    if (turn.turnId !== input.turnId) return;
    if (turn.phase !== "dispatch_tools") return;

    const executing = turn.executingToolCall;
    if (!executing || executing.callId !== input.callId) return;

    const toolName = executing.toolName;
    const args = executing.args;
    const err = input.error;
    const message = err?.message ?? String(err ?? "unknown tool error");

    const result = { error: "工具执行失败", toolName, message, args };
    this.onToolResult(agentId, { turnId: input.turnId, stepId: input.stepId, callId: input.callId, result });
  }

  /**
   * 更新智能体记忆。
   *
   * 将新对话添加到记忆系统，供后续 recall 使用。
   * 只发送 lastMemoryMessageId 之后的新消息，避免重复处理。
   *
   * @param {string} agentId - 智能体ID
   * @param {any} currentMessage - 当前消息
   * @param {{epoch:number, signal:AbortSignal, assertActive:() => void}|null} cancelScope - 取消作用域
   * @returns {Promise<void>}
   * @private
   */
  async _updateAgentMemory(agentId, currentMessage, cancelScope = null) {
    return _updateAgentMemoryFn(agentId, currentMessage, cancelScope, {
      log: this.runtime.log,
      agents: this.runtime._agents,
      org: this.runtime.org,
      conversations: this.runtime._conversations,
      agentMemoryManager: this.runtime.agentMemoryManager,
      getUnprocessedMessagesFn: (conv, lastId) => getUnprocessedMessages(conv, lastId),
    });
  }

  /**
   * 获取从 lastMemoryMessageId 之后的所有未处理消息。
   *
   * @param {Array} conversation - 完整对话历史
   * @param {string|null} lastMemoryMessageId - 最后记忆的消息ID
   * @returns {Array} 未处理的消息数组
   * @private
   */
  _getUnprocessedMessages(conversation, lastMemoryMessageId) {
    return getUnprocessedMessages(conversation, lastMemoryMessageId);
  }

  /**
   * @param {string} agentId
   * @returns {{queue:any[], activeTurn:any|null}}
   * @private
   */
  _ensureEntry(agentId) {
    if (!this._byAgentId.has(agentId)) {
      this._byAgentId.set(agentId, { queue: [], activeTurn: null });
    }
    return this._byAgentId.get(agentId);
  }

  /**
   * 检索知识树上下文，用于注入 LLM 对话中
   * @param {string} agentId
   * @param {object} turn
   * @returns {Promise<string|null>}
   * @private
   */
  async _retrieveKnowledgeContext(agentId, turn) {
    try {
      // 检查岗位设置是否禁用了知识树
      const agent = this.runtime._agents.get(agentId);
      if (agent) {
        const role = this.runtime.org?.getRole?.(agent.roleId);
        if (agent.roleId === "root" || role?.knowledgeTreeEnabled === false) return null;
      }

      // 从最近的用户消息中提取查询文本
      const conv = turn.conv;
      let query = null;
      for (let i = conv.length - 1; i >= 0; i--) {
        if (conv[i].role === "user") {
          const c = conv[i].content;
          const text = typeof c === "string" ? c :
            (Array.isArray(c) ? (c.find(x => x.type === "text")?.text || "") : "");
          query = text.slice(-500);
          break;
        }
      }
      if (!query) return null;
      return await this.runtime.knowledgeTree.getKnowledgeContext(agentId, query);
    } catch (err) {
      void this.runtime.log.error("[TurnEngine] 知识树检索失败", {
        agentId,
        turnId: turn?.turnId ?? null,
        message: err?.message ?? String(err ?? "unknown error"),
        stack: err?.stack ?? null,
        name: err?.name ?? null,
        code: err?.code ?? null
      });
      return null;
    }
  }
}
