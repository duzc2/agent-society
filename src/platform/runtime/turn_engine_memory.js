/**
 * TurnEngine 记忆子系统。
 * 从 turn_engine.js 提取，避免上帝文件膨胀。
 */

/**
 * 触发记忆更新的消息累积阈值。
 * 选择 10 是因为大约对应 5 轮对话（user + assistant × 5），
 * 在延迟和开销之间取得平衡。
 */
export const MEMORY_TRIGGER_THRESHOLD = 10;

/**
 * 获取从 lastMemoryMessageId 之后的所有未处理消息。
 * 纯函数，无副作用。
 *
 * @param {Array} conversation - 完整对话历史
 * @param {string|null} lastMemoryMessageId - 最后记忆的消息ID
 * @returns {Array} 未处理的消息数组
 */
export function getUnprocessedMessages(conversation, lastMemoryMessageId) {
  // 【关键】hmemory 只接受 'user' | 'assistant' | 'system' 三种 role
  // 需要过滤掉 'tool' 角色的消息（工具调用结果不应被提炼为长期记忆）
  const isValidRole = (role) => role === 'user' || role === 'assistant' || role === 'system';

  if (!lastMemoryMessageId) {
    // 【修复】如果没有记录过，返回所有对话历史（排除 system prompt 和 tool 消息）
    // 这样首次运行时也能累积到10条消息触发记忆
    return conversation
      .filter(m => m.role !== 'system' && isValidRole(m.role))
      .map(m => ({
        role: m.role,
        content: m.content,
        id: m.id
      }));
  }

  // 找到 lastMemoryMessageId 所在位置
  const lastIndex = conversation.findIndex(m => m.id === lastMemoryMessageId);

  if (lastIndex < 0) {
    // 如果找不到，说明消息ID已失效，返回所有非系统消息
    return conversation
      .filter(m => m.role !== 'system' && isValidRole(m.role))
      .map(m => ({
        role: m.role,
        content: m.content,
        id: m.id
      }));
  }

  if (lastIndex >= conversation.length - 1) {
    return []; // 已经是最后一条
  }

  // 返回之后的所有消息（排除 tool 消息）
  return conversation.slice(lastIndex + 1)
    .filter(m => isValidRole(m.role))
    .map(m => ({
      role: m.role,
      content: m.content,
      id: m.id
    }));
}

/**
 * 更新智能体记忆。
 *
 * 将新对话添加到记忆系统，供后续 recall 使用。
 * 只发送 lastMemoryMessageId 之后的新消息，避免重复处理。
 *
 * 【关键约束】
 * - 处理期间设置 computeStatus 为 'processing'，让前端显示停止按钮
 * - 支持通过 cancelScope 取消
 * - 如果取消，不更新 lastMemoryMessageId，确保下次可以重新处理
 *
 * @param {string} agentId - 智能体ID
 * @param {any} currentMessage - 当前消息
 * @param {{epoch:number, signal:AbortSignal, assertActive:() => void}|null} cancelScope - 取消作用域
 * @param {{ log: any, agents: Map, org: any, conversations: Map, agentMemoryManager: any, getUnprocessedMessagesFn: Function }} deps
 * @returns {Promise<void>}
 */
export async function updateAgentMemory(agentId, currentMessage, cancelScope, deps) {
  const { log, agents, org, conversations, agentMemoryManager, getUnprocessedMessagesFn } = deps;

  log.info('[TurnEngine] _updateAgentMemory 被调用', { agentId });

  // 【关键】检查智能体是否正在终止，避免在终止过程中触发记忆更新
  const agent = agents.get(agentId);
  if (!agent || agent._isTerminating) {
    log.info('[TurnEngine] 智能体不存在或正在终止，跳过记忆更新', { agentId });
    return;
  }

  // 【关键】检查是否已取消
  if (cancelScope?.signal?.aborted) {
    log.info('[TurnEngine] 记忆处理已取消（前置检查）', { agentId });
    return;
  }

  // 【关键】记忆存储是纯异步操作，不修改 computeStatus
  // 不应该因为后台异步任务而改变 agent 的处理状态
  // 记录是否成功完成（用于决定是否更新 lastMemoryMessageId）
  let isCompleted = false;

  try {
    // 【关键】记忆功能已启用时，getOrCreateMemory 失败会抛出异常，不会静默返回 null
    const memory = await agentMemoryManager?.getOrCreateMemory(agentId);

    if (!memory) {
      log.info('[TurnEngine] 记忆功能未启用或智能体不存在，跳过', { agentId });
      return;
    }

    // 【关键】检查是否已取消
    if (cancelScope?.signal?.aborted) {
      log.info('[TurnEngine] 记忆处理已取消（获取memory后）', { agentId });
      return;
    }

    // 获取该智能体的完整对话历史
    const conversation = conversations.get(agentId);
    if (!Array.isArray(conversation) || conversation.length === 0) return;

    // 找到上次记忆位置之后的消息
    let messagesToRemember = getUnprocessedMessagesFn(
      conversation,
      agent.lastMemoryMessageId
    );

    // 【过滤】移除空内容的消息
    messagesToRemember = messagesToRemember.filter(m =>
      m.content && typeof m.content === 'string' && m.content.trim().length > 0
    );

    if (messagesToRemember.length === 0) {
      log.info('[TurnEngine] 没有有效内容的消息，跳过记忆处理', { agentId });
      return;
    }

    // 【关键】防止一次性处理过多积压消息，导致长时间阻塞
    // 如果未处理消息超过 30 条，只处理前 30 条，剩下的下次处理
    const MAX_BATCH_MESSAGES = 30;
    if (messagesToRemember.length > MAX_BATCH_MESSAGES) {
      log.warn('[TurnEngine] 未处理消息过多，进行分批截断', {
        agentId,
        total: messagesToRemember.length,
        limit: MAX_BATCH_MESSAGES
      });
      messagesToRemember = messagesToRemember.slice(0, MAX_BATCH_MESSAGES);
    }

    // 【批量处理】每批最多15条消息，分成多批逐步处理，避免单次处理阻塞
    const BATCH_SIZE = 15;
    const batches = [];
    for (let i = 0; i < messagesToRemember.length; i += BATCH_SIZE) {
      batches.push(messagesToRemember.slice(i, i + BATCH_SIZE));
    }

    // 通知记忆系统分批处理（等待完成，确保 recall 能获取到新记忆）
    log.info('[TurnEngine] 开始记忆批处理', { agentId, batchCount: batches.length, totalMessages: messagesToRemember.length });

    let lastProcessedMessage = null;

    for (let i = 0; i < batches.length; i++) {
      // 【关键】每批处理前检查是否已取消
      if (cancelScope?.signal?.aborted) {
        log.info('[TurnEngine] 记忆处理已取消（批次处理中）', { agentId, batchIndex: i + 1 });
        return;
      }

      const batch = batches[i];
      log.info('[TurnEngine] 处理记忆批次', { agentId, batchIndex: i + 1, batchSize: batch.length });

      // 【关键】检查 epoch 是否已过期（用于区分正常停止和插话重试）
      if (cancelScope) {
        try {
          cancelScope.assertActive();
        } catch (err) {
          log.info('[TurnEngine] 记忆处理已取消（epoch过期）', { agentId, batchIndex: i + 1 });
          return;
        }
      }

      // 【关键】记忆保存失败必须抛出异常，不允许静默跳过
      // 取消检查已在批次处理前完成，此处无需额外处理 AbortError
      await memory.processConversation(batch);
      lastProcessedMessage = batch[batch.length - 1];
      log.info('[TurnEngine] 记忆批次处理完成', { agentId, batchIndex: i + 1 });

      // 【关键】每处理完一个批次，让出事件循环，确保主业务（如消息接收、状态更新）有机会执行
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    // 【关键】最后检查是否已取消，只有在未取消的情况下才更新 lastMemoryMessageId
    if (cancelScope?.signal?.aborted) {
      log.info('[TurnEngine] 记忆处理已取消（完成前），不更新 lastMemoryMessageId', { agentId });
      return;
    }

    // 更新最后记忆位置为当前最后一条消息的 ID
    if (lastProcessedMessage) {
      // 使用消息内容哈希或时间戳作为 ID（因为消息可能没有 id 字段）
      agent.lastMemoryMessageId = lastProcessedMessage.id || `${Date.now()}_${messagesToRemember.length}`;
      log.info('[TurnEngine] 更新 lastMemoryMessageId', { agentId, lastMemoryMessageId: agent.lastMemoryMessageId });

      // 持久化到 org.json
      await org?.setAgentLastMemoryMessageId?.(agentId, agent.lastMemoryMessageId);
    }

    // 标记成功完成
    isCompleted = true;
    log.info('[TurnEngine] 记忆处理完成', { agentId });

  } catch (err) {
    // 【关键】检查是否是取消错误
    if (err?.name === 'AbortError' || cancelScope?.signal?.aborted) {
      log.info('[TurnEngine] 记忆处理已取消（异常捕获）', { agentId });
      return;
    }

    // 【关键】记忆更新失败，必须记录完整错误信息以便排查
    log.error('[TurnEngine] 记忆更新失败', {
      agentId,
      // 触发参数：更新记忆时正在处理的消息和消息数量
      messageId: currentMessage?.id ?? null,
      messageFrom: currentMessage?.from ?? null,
      messagesToRememberCount: messagesToRemember?.length ?? 0,
      lastProcessedMessageId: lastProcessedMessage?.id ?? null,
      isCompleted,
      // 技术信息
      error: err?.message || String(err),
      stack: err?.stack,
      name: err?.name,
      code: err?.code,
      cause: err?.cause?.message || err?.cause
    });
    // 【关键】重新抛出异常，让调用方感知到记忆保存失败
    throw err;
  } finally {
    // 【关键】如果未完成（被取消），不更新 lastMemoryMessageId
    if (!isCompleted) {
      log.info('[TurnEngine] 记忆处理未完成，保留原有 lastMemoryMessageId', {
        agentId,
        lastMemoryMessageId: agent.lastMemoryMessageId
      });
    }
  }
}

/**
 * 可能触发记忆更新（条件：累积 MEMORY_TRIGGER_THRESHOLD 条未处理消息）。
 *
 * 由 ComputeScheduler 在消息入队后调用，不阻塞调度循环。
 *
 * @param {string} agentId - 智能体ID
 * @param {any} currentMessage - 当前收到的消息
 * @param {{epoch:number, signal:AbortSignal, assertActive:() => void}|null} cancelScope - 取消作用域
 * @param {{ log: any, agents: Map, org: any, conversations: Map, agentMemoryManager: any, getUnprocessedMessagesFn: Function }} deps
 * @returns {Promise<void>}
 */
export async function maybeUpdateMemory(agentId, currentMessage, cancelScope, deps) {
  const { log, agents, org, conversations, getUnprocessedMessagesFn } = deps;

  log.info('[TurnEngine] maybeUpdateMemory 被调用', { agentId });

  let messagesToRemember;

  try {
    // 检查是否累积了10条未处理消息
    const agent = agents.get(agentId);
    if (!agent) {
      log.info('[TurnEngine] agent 不存在', { agentId });
      return;
    }

    // 检查岗位设置是否禁用了智能体记忆
    const role = org?.getRole?.(agent.roleId);
    if (agent.roleId === "root" || role?.agentMemoryEnabled === false) {
      log.info('[TurnEngine] 岗位禁用了智能体记忆，跳过', { agentId, roleId: agent.roleId });
      return;
    }

    const conversation = conversations.get(agentId);
    if (!Array.isArray(conversation) || conversation.length === 0) {
      log.info('[TurnEngine] 对话为空', { agentId });
      return;
    }

    // 【诊断日志】
    log.info('[TurnEngine] 诊断信息', {
      agentId,
      conversationLength: conversation.length,
      lastMemoryMessageId: agent.lastMemoryMessageId,
      nonSystemMessages: conversation.filter(m => m.role !== 'system').length
    });

    // 获取未处理消息数量
    messagesToRemember = getUnprocessedMessagesFn(
      conversation,
      agent.lastMemoryMessageId
    );

    log.info('[TurnEngine] 未处理消息数量', { agentId, count: messagesToRemember.length, threshold: MEMORY_TRIGGER_THRESHOLD });
    if (messagesToRemember.length < MEMORY_TRIGGER_THRESHOLD) {
      log.info('[TurnEngine] 消息数量不足，暂不触发记忆', { agentId, count: messagesToRemember.length });
      return;
    }

    // 累积足够，触发记忆处理
    log.info('[TurnEngine] 累积足够，触发记忆处理', { agentId });
    await updateAgentMemory(agentId, currentMessage, cancelScope, deps);
  } catch (err) {
    // 【关键】记忆处理失败，必须记录完整错误信息并向上抛出
    if (err?.name === 'AbortError' || cancelScope?.signal?.aborted) {
      log.info('[TurnEngine] 记忆处理已取消', { agentId });
      return;
    }
    log.error('[TurnEngine] 记忆处理失败', {
      agentId,
      // 触发参数：触发记忆处理时正在处理的消息和累积量
      messageId: currentMessage?.id ?? null,
      messageFrom: currentMessage?.from ?? null,
      payloadPreview: typeof currentMessage?.payload?.text === 'string' ? currentMessage.payload.text.substring(0, 300) : null,
      unprocessedCount: messagesToRemember?.length ?? 0,
      // 技术信息
      error: err?.message || String(err),
      stack: err?.stack,
      name: err?.name,
      code: err?.code,
      cause: err?.cause?.message || err?.cause
    });
    throw err;
  }
}
