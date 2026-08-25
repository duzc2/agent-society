/**
 * 消息处理模块 — 消息存储、加载、监听器引导、HTTP 路由注册。
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import { formatLocalTime } from "../../../utils/logger/logger.js";
import { registry } from "../../../core/module_registry.js";

// ===========================================================================
// 纯工具函数（不依赖任何状态）
// ===========================================================================

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const promptTokens = usage.promptTokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.input_tokens ?? 0;
  const completionTokens = usage.completionTokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.output_tokens ?? 0;
  const totalTokens = usage.totalTokens ?? usage.total_tokens
    ?? ((Number.isFinite(promptTokens) ? promptTokens : 0) + (Number.isFinite(completionTokens) ? completionTokens : 0));
  return { promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0, completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0, totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0 };
}

function normalizeMessageUsage(message) {
  if (!message || typeof message !== "object") return message;
  if (message.payload && typeof message.payload === "object") {
    const u = normalizeUsage(message.payload.usage);
    if (u) message.payload = { ...message.payload, usage: u };
  }
  return message;
}

// ===========================================================================
// 注册所有消息功能
// ===========================================================================

/**
 * @param {{ app: import('hono').Hono, log: any, society: any, runtimeDir: string|null }} deps
 */
async function registerMessageRoutes({ app, log, society, runtimeDir }) {

  // ===== 消息存储 Map（本函数内可见，贯穿路由生命周期） =====

  const messagesByAgent = new Map();
  const messagesById = new Map();
  const messagesByTaskId = new Map();

  // ===== 索引操作辅助 =====

  function removeMessageFromIndexes(messageId) {
    if (!messageId) return;
    messagesById.delete(messageId);
    for (const [taskId, msgs] of messagesByTaskId.entries()) {
      const filtered = msgs.filter(m => m.id !== messageId);
      if (filtered.length === 0) messagesByTaskId.delete(taskId);
      else if (filtered.length !== msgs.length) messagesByTaskId.set(taskId, filtered);
    }
  }

  function removeMessagesFromIndexes(messageIds) {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return;
    const idsSet = new Set(messageIds);
    for (const id of idsSet) messagesById.delete(id);
    for (const [taskId, msgs] of messagesByTaskId.entries()) {
      const filtered = msgs.filter(m => !idsSet.has(m.id));
      if (filtered.length === 0) messagesByTaskId.delete(taskId);
      else if (filtered.length !== msgs.length) messagesByTaskId.set(taskId, filtered);
    }
  }

  function clearAgentMessageIndexes(agentId) {
    const msgs = messagesByAgent.get(agentId);
    if (!msgs) return;
    removeMessagesFromIndexes(msgs.map(m => m?.id).filter(Boolean));
  }

  // ===== 路径工具 =====

  const getMessagesDir = () => path.join(runtimeDir, "web", "messages");
  const getConversationsDir = () => path.join(society.runtime.config.runtimeDir, "conversations");
  const ensureMessagesDir = () => mkdir(getMessagesDir(), { recursive: true });

  // ===== 全局消息文件写队列：串行化 append / rewrite / clear / repair，避免并发写损坏 =====

  let messageFileWriteQueue = Promise.resolve();

  function enqueueMessageFileWrite(fn) {
    const next = messageFileWriteQueue.then(fn, fn);
    messageFileWriteQueue = next.then(() => {}, () => {});
    return next;
  }

  // ===== 文件读写 =====

  function appendMessageToFile(agentId, msg) {
    return enqueueMessageFileWrite(async () => {
      await ensureMessagesDir();
      try {
        await appendFile(path.join(getMessagesDir(), `${agentId}.jsonl`), JSON.stringify(msg) + "\n", "utf8");
      } catch (err) {
        void log.error("追加消息到文件失败", { agentId, error: err?.message ?? String(err), stack: err?.stack, name: err?.name, code: err?.code });
      }
    });
  }

  function rewriteMessagesFile(agentId, msgs) {
    return enqueueMessageFileWrite(async () => {
      await ensureMessagesDir();
      try {
        await writeFile(path.join(getMessagesDir(), `${agentId}.jsonl`), msgs.map(m => JSON.stringify(m)).join("\n") + "\n", "utf8");
      } catch (err) {
        void log.error("重写消息文件失败", { agentId, error: err?.message ?? String(err), stack: err?.stack, name: err?.name, code: err?.code });
      }
    });
  }

  function clearMessagesFile(agentId) {
    return enqueueMessageFileWrite(async () => {
      await ensureMessagesDir();
      try {
        await writeFile(path.join(getMessagesDir(), `${agentId}.jsonl`), "", "utf8");
      } catch (err) {
        void log.error("清空消息文件失败", { agentId, error: err?.message ?? String(err), stack: err?.stack, name: err?.name, code: err?.code });
      }
    });
  }

  // ===== 会话快照 =====

  async function loadConversationSnapshot(agentId) {
    const conversationsDir = getConversationsDir();
    const fp = path.join(conversationsDir, `${agentId}.json`);
    if (!existsSync(fp)) return null;
    try {
      const data = JSON.parse(await readFile(fp, "utf8"));
      if (Array.isArray(data)) return { messages: data, updatedAt: null };
      if (Array.isArray(data?.messages)) return { messages: data.messages, updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null };
      return null;
    } catch (err) {
      void log.warn("加载 conversations 快照失败", { agentId, error: err?.message ?? String(err), stack: err?.stack, name: err?.name, code: err?.code });
      return null;
    }
  }

  function convertConversationSnapshotToAgentMessages(agentId, conversationMessages, updatedAt) {
    if (!Array.isArray(conversationMessages) || conversationMessages.length === 0) return [];
    const visible = conversationMessages.filter(m => m?.role === "user" || m?.role === "assistant");
    if (visible.length === 0) return [];
    const baseMs = updatedAt ? new Date(updatedAt).getTime() : Date.now();
    const safeBase = Number.isFinite(baseMs) ? baseMs : Date.now();
    const startTime = safeBase - Math.max(visible.length - 1, 0) * 1000;
    return visible.map((m, i) => {
      const isUser = m.role === "user";
      return {
        id: m?.id ?? `conversation-fallback-${agentId}-${i}`,
        from: isUser ? "user" : agentId,
        to: isUser ? agentId : "user",
        taskId: m?.taskId ?? null,
        payload: isUser
          ? { text: m.content ?? "" }
          : { text: m.content ?? "", usage: normalizeUsage(m._usage ?? m.usage ?? null) },
        createdAt: m?.createdAt ?? new Date(startTime + i * 1000).toISOString(),
        ...(m?.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
      };
    });
  }

  async function loadMessagesFromConversationFallback(agentId) {
    const snapshot = await loadConversationSnapshot(agentId);
    if (!snapshot) { messagesByAgent.set(agentId, []); return []; }
    const fallbackMsgs = convertConversationSnapshotToAgentMessages(agentId, snapshot.messages, snapshot.updatedAt).map(normalizeMessageUsage);
    for (const m of fallbackMsgs) messagesById.set(m.id, m);
    messagesByAgent.set(agentId, fallbackMsgs);
    return fallbackMsgs;
  }

  async function mergeConversationSnapshotMetadata(agentId, msgs) {
    if (!Array.isArray(msgs) || msgs.length === 0) return;
    const snapshot = await loadConversationSnapshot(agentId);
    if (!snapshot || !Array.isArray(snapshot.messages) || snapshot.messages.length === 0) return;
    const byId = new Map();
    for (const m of snapshot.messages) { if (m?.id) byId.set(m.id, m); }
    for (const m of msgs) {
      const matched = m?.id ? byId.get(m.id) : null;
      if (!matched) continue;
      if (!m.reasoning_content && matched.reasoning_content) m.reasoning_content = matched.reasoning_content;
      if (!m.payload?.usage && (matched._usage || matched.usage)) m.payload = { ...(m.payload ?? {}), usage: normalizeUsage(matched._usage ?? matched.usage) };
      normalizeMessageUsage(m);
    }
  }

  // ===== CRUD =====

  async function loadMessagesForAgent(agentId) {
    if (messagesByAgent.has(agentId)) return messagesByAgent.get(agentId);

    return enqueueMessageFileWrite(async () => {
      if (messagesByAgent.has(agentId)) return messagesByAgent.get(agentId);

      const fp = path.join(getMessagesDir(), `${agentId}.jsonl`);
      const msgs = [];
      const localIds = new Set();
      let hadParseError = false;

      try {
        if (!existsSync(fp)) return await loadMessagesFromConversationFallback(agentId);

        const lines = (await readFile(fp, "utf8")).split("\n").filter(l => l.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed._ref && !parsed.id) continue;
            const msg = normalizeMessageUsage(parsed);
            if (!localIds.has(msg.id)) {
              msgs.push(msg);
              localIds.add(msg.id);
              messagesById.set(msg.id, msg);
            } else {
              const existing = messagesById.get(msg.id);
              if (existing && msg.payload?.result && !existing.payload?.result) {
                existing.payload.result = msg.payload.result;
                if (msg.payload.usage) existing.payload.usage = msg.payload.usage;
                if (msg.reasoning_content) existing.reasoning_content = msg.reasoning_content;
              }
            }
          } catch (parseErr) {
            hadParseError = true;
            void log.warn("消息解析失败，已跳过", { agentId, rawLine: line.substring(0, 500), lineLength: line.length, error: parseErr.message, stack: parseErr?.stack, name: parseErr?.name, code: parseErr?.code });
          }
        }

        await mergeConversationSnapshotMetadata(agentId, msgs);
        msgs.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

        if (hadParseError) {
          const content = msgs.length ? msgs.map(m => JSON.stringify(m)).join("\n") + "\n" : "";
          try {
            await writeFile(fp, content, "utf8");
            void log.warn("检测到消息文件损坏，已用有效消息重写修复", { agentId, validCount: msgs.length });
          } catch (repairErr) {
            void log.error("修复消息文件失败", { agentId, error: repairErr?.message ?? String(repairErr), stack: repairErr?.stack, name: repairErr?.name, code: repairErr?.code });
          }
        }

        if (msgs.length === 0) return await loadMessagesFromConversationFallback(agentId);
        messagesByAgent.set(agentId, msgs);
      } catch (err) {
        void log.warn("加载消息文件失败", { agentId, error: err?.message ?? String(err), stack: err?.stack, name: err?.name, code: err?.code });
        return await loadMessagesFromConversationFallback(agentId);
      }

      return msgs;
    });
  }

  function getRegenerableMessageId(agentId) {
    const lastAssistant = society.runtime._conversationManager.getLastAssistantMessage(agentId);
    const messageId = lastAssistant?.message?.id;
    return typeof messageId === "string" && messageId.length > 0 ? messageId : null;
  }

  async function storeMessage(message) {
    normalizeMessageUsage(message);
    const existing = messagesById.get(message.id);
    if (existing) {
      if (message.deliveredAt && existing.scheduledDeliveryTime) {
        void log.info("延迟消息投递：开始存储", { id: message.id, from: existing.from, to: existing.to, deliveredAt: message.deliveredAt, scheduledDeliveryTime: existing.scheduledDeliveryTime });
        const recipient = { ...existing, createdAt: message.deliveredAt, deliveredAt: message.deliveredAt, scheduledDeliveryTime: existing.scheduledDeliveryTime, sendTime: existing.createdAt };
        const to = existing.to, from = existing.from;
        const isSelf = to === from;
        if (isSelf) { recipient.id = `${message.id}-d`; existing.deliveredAt = message.deliveredAt; }
        if (to) { if (!messagesByAgent.has(to)) messagesByAgent.set(to, []); messagesByAgent.get(to).push(recipient); await appendMessageToFile(to, recipient); }
        if (!isSelf && from && messagesByAgent.has(from)) { existing.deliveredAt = message.deliveredAt; const list = messagesByAgent.get(from); const idx = list.findIndex(m => m.id === message.id); if (idx !== -1) { list[idx] = existing; await rewriteMessagesFile(from, list); } }
        if (isSelf && from && messagesByAgent.has(from)) { await rewriteMessagesFile(from, messagesByAgent.get(from)); }
      }
      return;
    }
    messagesById.set(message.id, message);
    const { from, to } = message;
    // skipSenderCopy：通用投递选项（发送者不保留个人副本；群消息等由扇出 to 副本覆盖）
    if (from && !message.extras?.skipSenderCopy) { if (!messagesByAgent.has(from)) messagesByAgent.set(from, []); messagesByAgent.get(from).push(message); await appendMessageToFile(from, message); }
    if (to && to !== from && !message.scheduledDeliveryTime) { if (!messagesByAgent.has(to)) messagesByAgent.set(to, []); messagesByAgent.get(to).push(message); await appendMessageToFile(to, message); }
  }

  /**
   * 将存储消息转换为 agent_message 广播格式。
   * @param {object} m - 存储的消息对象
   * @returns {object} 广播格式
   */
  function buildBroadcastMsg(m) {
    return {
      id: m.id,
      from: m.from,
      to: m.to,
      taskId: m.taskId,
      type: m.type ?? (m.payload?.type || 'text'),
      payload: m.payload,
      reasoning_content: m.reasoning_content ?? null,
      createdAt: m.createdAt,
      extras: m.extras ?? null,
    };
  }

  /**
   * 将工具调用消息立即推送到心跳 Broker，使前端在工具执行期间就能看到卡片。
   * @param {string} agentId
   * @param {object} msg - 存储的消息对象
   */
  function _broadcastToolCall(agentId, msg) {
    const broker = society.runtime.heartbeatBroker;
    if (!broker) return;
    broker.broadcast('agent_message', {
      agents: { [agentId]: [buildBroadcastMsg(msg)] }
    }, 600000);
  }

  async function storeToolCall(event) {
    const { agentId, toolName, args, result, taskId, callId, timestamp, usage } = event;
    const normalizedUsage = normalizeUsage(usage);
    const reasoningContent = event.reasoning_content || event.reasoningContent || null;
    if (!agentId) return;
    if (toolName === "send_message") {
      if (result?.messageId) { const m = messagesById.get(result.messageId); if (m) { if (reasoningContent) m.reasoning_content = reasoningContent; if (normalizedUsage && m.payload) m.payload.usage = normalizedUsage; } }
      return;
    }
    const msg = { id: `tool-${callId}`, type: "tool_call", from: agentId, to: agentId, taskId, payload: { toolName, args, result, usage: normalizedUsage }, createdAt: timestamp, ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) };
    if (!messagesByAgent.has(agentId)) messagesByAgent.set(agentId, []);
    const existing = messagesById.get(msg.id);
    if (!existing) {
      messagesById.set(msg.id, msg);
      messagesByAgent.get(agentId).push(msg);
      appendMessageToFile(agentId, msg).catch(err => { void log.error("追加消息文件失败", { agentId, error: err?.message ?? String(err), stack: err?.stack, name: err?.name, code: err?.code }); });
      messagesByAgent.get(agentId).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      // 立即广播：使前端在工具执行期间就能看到工具调用卡片
      _broadcastToolCall(agentId, msg);
    } else if (result !== undefined && result !== null && !existing.payload.result) {
      existing.payload.result = result;
      if (normalizedUsage) existing.payload.usage = normalizedUsage;
      if (reasoningContent) existing.reasoning_content = reasoningContent;
      appendMessageToFile(agentId, msg).catch(err => { void log.error("追加消息文件失败(更新)", { agentId, error: err?.message ?? String(err), stack: err?.stack, name: err?.name, code: err?.code }); });
      // 立即广播：使前端能收到工具执行结果
      _broadcastToolCall(agentId, existing);
    }
  }

  async function preloadAllMessages() {
    const dir = getMessagesDir();
    if (!existsSync(dir)) return;
    try {
      const { readdir } = await import("node:fs/promises");
      const jsonlFiles = (await readdir(dir)).filter(f => f.endsWith(".jsonl"));
      for (const file of jsonlFiles) {
        const agentId = file.replace(".jsonl", "");
        if (!messagesByAgent.has(agentId)) await loadMessagesForAgent(agentId);
      }
      void log.info("预加载消息完成", { fileCount: jsonlFiles.length, totalMessages: messagesById.size });
    } catch (err) {
      void log.warn("预加载消息失败", { dir, error: err?.message ?? String(err), stack: err?.stack, name: err?.name, code: err?.code });
    }
  }

  function rewriteMessageLog(agentId) {
    const msgs = messagesByAgent.get(agentId);
    if (!msgs) return Promise.resolve();
    return enqueueMessageFileWrite(async () => {
      await ensureMessagesDir();
      try {
        await writeFile(path.join(getMessagesDir(), `${agentId}.jsonl`), msgs.map(m => JSON.stringify(m)).join("\n") + "\n", "utf8");
      } catch (err) {
        void log.error("重写消息日志失败", { agentId, error: err?.message ?? String(err), stack: err?.stack, name: err?.name, code: err?.code });
      }
    });
  }

  async function removeMsgFromAgentLogs(messageIds) {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return [];
    const idsSet = new Set(messageIds.filter(id => typeof id === "string" && id.length > 0));
    if (idsSet.size === 0) return [];
    const affected = [];
    for (const [agentId, msgs] of messagesByAgent.entries()) {
      const filtered = msgs.filter(m => !idsSet.has(m?.id));
      if (filtered.length !== msgs.length) { messagesByAgent.set(agentId, filtered); affected.push(agentId); }
    }
    for (const agentId of affected) await rewriteMessageLog(agentId);
    return affected;
  }

  // ===== 监听器引导 =====

  function bootstrapListeners() {
    society.onUserMessage((message) => {
      const taskId = message?.taskId;
      if (taskId) { if (!messagesByTaskId.has(taskId)) messagesByTaskId.set(taskId, []); messagesByTaskId.get(taskId).push({ id: message.id, from: message.from, to: message.to ?? "user", taskId: message.taskId, payload: message.payload, createdAt: message.createdAt }); }
      void storeMessage({ id: message.id, from: message.from, to: message.to ?? "user", taskId: message.taskId, payload: message.payload, createdAt: message.createdAt });
    });

    if (typeof society.onAllMessages === "function") {
      society.onAllMessages((message) => { void storeMessage({ id: message.id, from: message.from, to: message.to, taskId: message.taskId, payload: message.payload, reasoning_content: message.reasoning_content ?? null, createdAt: message.createdAt }); });
    }

    if (society.runtime.bus) {
      const originalSend = society.runtime.bus.send.bind(society.runtime.bus);
      society.runtime.bus.send = (msg) => {
        const result = originalSend(msg);
        void storeMessage({ id: result.messageId, from: msg.from, to: msg.to, taskId: msg.taskId, payload: msg.payload, reasoning_content: msg.reasoning_content ?? null, memoryContext: msg.memoryContext ?? null, knowledgeContext: msg.knowledgeContext ?? null, createdAt: formatLocalTime(), scheduledDeliveryTime: result.scheduledDeliveryTime ?? null, extras: msg.extras ?? null });
        return result;
      };
      society.runtime.bus.onDelayedDelivery((message) => {
        void storeMessage({ id: message.id, from: message.from, to: message.to, taskId: message.taskId, payload: message.payload, reasoning_content: message.reasoning_content ?? null, createdAt: message.createdAt, deliveredAt: formatLocalTime() });
      });
    }

    if (typeof society.runtime.onToolCall === "function") {
      society.runtime.onToolCall((event) => { storeToolCall(event).catch(err => { void log.error("存储工具调用失败", { error: err.message, stack: err.stack }); }); });
    }

    society.runtime._storeErrorMessageCallback = (message) => { void storeMessage(message); };

    const broker = society.runtime.heartbeatBroker;
    if (broker) {
      let _lastBroadcastAt = 0;
      broker.onBeforeDrain(() => {
        const agentsMsgs = {};
        let hasNew = false;
        for (const [agentId, msgs] of messagesByAgent) {
          const newMsgs = [];
          for (const m of msgs) {
            if ((m.createdAt ? new Date(m.createdAt).getTime() : 0) > _lastBroadcastAt) {
              newMsgs.push({ id: m.id, from: m.from, to: m.to, taskId: m.taskId, type: m.type ?? (m.payload?.type || 'text'), payload: m.payload, reasoning_content: m.reasoning_content ?? null, memoryContext: m.memoryContext ?? null, knowledgeContext: m.knowledgeContext ?? null, createdAt: m.createdAt, scheduledDeliveryTime: m.scheduledDeliveryTime ?? null, deliveredAt: m.deliveredAt ?? null, extras: m.extras ?? null });
            }
          }
          if (newMsgs.length > 0) { agentsMsgs[agentId] = newMsgs; hasNew = true; }
        }
        _lastBroadcastAt = Date.now();
        if (hasNew) broker.broadcast('agent_message', { agents: agentsMsgs }, 600000);
      });
    }
  }

  // ===== 初始化 =====

  await ensureMessagesDir();
  preloadAllMessages().catch(err => { void log.warn("后台预加载消息失败", { error: err.message, stack: err.stack }); });
  bootstrapListeners();

  // ===========================================================================
  // Hono 路由
  // ===========================================================================

  app.get('/api/messages/:taskId', (c) => {
    const taskId = decodeURIComponent(c.req.param('taskId'));
    if (!taskId || taskId.trim() === "") return c.json({ error: "missing_task_id" }, 400);
    const msgs = messagesByTaskId.get(taskId) ?? [];
    void log.debug("HTTP查询消息", { taskId, count: msgs.length });
    return c.json({ taskId, messages: msgs, count: msgs.length });
  });

  app.get('/api/agent-messages/:agentId', async (c) => {
    const agentId = decodeURIComponent(c.req.param('agentId'));
    if (!agentId || agentId.trim() === "") return c.json({ error: "missing_agent_id" }, 400);
    try {
      const limit = parseInt(c.req.query('limit') || "50", 10);
      const before = c.req.query('before');
      const around = c.req.query('around');
      const allMsgs = await loadMessagesForAgent(agentId);
      const regenId = getRegenerableMessageId(agentId);
      let resultMsgs = [], hasMore = false;
      if (around) {
        const idx = allMsgs.findIndex(m => m.id === around);
        if (idx !== -1) { const half = Math.floor(limit / 2); resultMsgs = allMsgs.slice(Math.max(0, idx - half), Math.min(allMsgs.length, idx + half + 1)); }
        else { resultMsgs = allMsgs.slice(Math.max(0, allMsgs.length - limit)); }
      } else if (before) {
        const idx = allMsgs.findIndex(m => m.id === before);
        if (idx !== -1) { resultMsgs = allMsgs.slice(Math.max(0, idx - limit), idx); hasMore = Math.max(0, idx - limit) > 0; }
      } else {
        resultMsgs = allMsgs.slice(Math.max(0, allMsgs.length - limit));
        hasMore = resultMsgs.length < allMsgs.length && resultMsgs.length > 0;
      }
      return c.json({ agentId, messages: resultMsgs, total: allMsgs.length, count: resultMsgs.length, hasMore, regenerableMessageId: regenId });
    } catch (err) {
      void log.error("查询智能体消息失败", { agentId, error: err.message, stack: err.stack });
      return c.json({ error: "load_messages_failed", message: err.message }, 500);
    }
  });

  app.get('/api/agent-messages/:agentId/search', async (c) => {
    const agentId = decodeURIComponent(c.req.param('agentId'));
    if (!agentId || agentId.trim() === "") return c.json({ error: "missing_agent_id" }, 400);
    try {
      const query = (c.req.query('q') || "").toLowerCase().trim();
      if (!query) return c.json({ matches: [] });
      const allMsgs = await loadMessagesForAgent(agentId);
      const matches = allMsgs.filter(msg => {
        if (msg.content && typeof msg.content === 'string' && msg.content.toLowerCase().includes(query)) return true;
        if (msg.payload?.text && typeof msg.payload.text === 'string' && msg.payload.text.toLowerCase().includes(query)) return true;
        if (msg.payload?.toolName && typeof msg.payload.toolName === 'string' && msg.payload.toolName.toLowerCase().includes(query)) return true;
        if (msg.reasoning_content && typeof msg.reasoning_content === 'string' && msg.reasoning_content.toLowerCase().includes(query)) return true;
        return false;
      }).map(msg => ({ id: msg.id, content: msg.content || (msg.payload?.text) || (msg.payload?.toolName ? `调用工具: ${msg.payload.toolName}` : '无内容'), timestamp: msg.createdAt ? new Date(msg.createdAt).getTime() : Date.now(), type: msg.type, role: msg.from === 'user' ? 'user' : 'assistant' }));
      matches.sort((a, b) => b.timestamp - a.timestamp);
      return c.json({ agentId, matches, count: matches.length });
    } catch (err) {
      void log.error("搜索智能体消息失败", { agentId, error: err.message, stack: err.stack });
      return c.json({ error: "search_messages_failed", message: err.message }, 500);
    }
  });

  app.get('/api/agent-conversation/:agentId', async (c) => {
    const agentId = decodeURIComponent(c.req.param('agentId'));
    if (!agentId || agentId.trim() === "") return c.json({ error: "missing_agent_id" }, 400);
    try {
      const snapshot = await loadConversationSnapshot(agentId);
      if (!snapshot) return c.json({ agentId, messages: [], thinkingMap: {} });
      const msgs = snapshot.messages || [];
      const thinkingMap = {};
      let i = 0;
      for (const msg of msgs) {
        if (msg.role === "assistant" && msg.reasoning_content) {
          if (msg.tool_calls?.length > 0) { const callId = msg.tool_calls[0].id; if (callId) thinkingMap[callId] = msg.reasoning_content; }
          if (msg.content) thinkingMap[`content:${msg.content.substring(0, 100)}`] = msg.reasoning_content;
          thinkingMap[`index:${i}`] = msg.reasoning_content;
        }
        i++;
      }
      return c.json({ agentId, messages: msgs, thinkingMap });
    } catch (err) {
      void log.error("查询智能体对话历史失败", { agentId, error: err.message, stack: err.stack });
      return c.json({ error: "load_conversation_failed", message: err.message }, 500);
    }
  });

  app.post('/api/root/new-session', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { body = null; }
    if (body === null && c.req.header('content-type')?.includes('application/json')) return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    const runtime = society.runtime;
    if (!runtime._conversationManager) return c.json({ error: "runtime_not_initialized" }, 500);
    const agentId = "root";
    try {
      runtime.abortAgentLlmCall(agentId);
      runtime._conversationManager.clearTokenUsage(agentId);
      runtime._conversationManager.deleteConversation(agentId);
      await runtime._conversationManager.deletePersistedConversation(agentId);
      if (messagesByAgent.has(agentId)) {
        clearAgentMessageIndexes(agentId);
        messagesByAgent.set(agentId, []);
        await clearMessagesFile(agentId);
      }
      await storeMessage({ id: randomUUID(), from: agentId, to: agentId, taskId: null, payload: { text: "--- 新会话 ---" }, createdAt: new Date().toISOString() });
      return c.json({ ok: true });
    } catch (e) {
      void log.error("[POST /api/root/new-session] root 新会话失败", { error: e?.message ?? String(e), stack: e?.stack, name: e?.name, code: e?.code });
      return c.json({ error: "internal_error", message: e?.message ?? String(e) }, 500);
    }
  });

  app.put('/api/agent/:agentId/messages/:messageId', async (c) => {
    const agentId = decodeURIComponent(c.req.param('agentId'));
    const messageId = decodeURIComponent(c.req.param('messageId'));
    let body; try { body = await c.req.json(); } catch { body = null; }
    if (!body) return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    const { content } = body;
    if (!content) return c.json({ error: "missing_content" }, 400);
    try {
      await society.runtime._conversationManager.updateMessage(agentId, messageId, content);
      const msgs = messagesByAgent.get(agentId);
      if (msgs) {
        const msg = msgs.find(m => m.id === messageId);
        if (msg) { if (msg.payload) { msg.payload.text = content; if (msg.payload.content) msg.payload.content = content; } else { msg.payload = { text: content }; } await rewriteMessageLog(agentId); }
      }
      return c.json({ ok: true });
    } catch (err) { return c.json({ error: "internal_error", message: err.message }, 500); }
  });

  app.post('/api/agent/:agentId/messages/:messageId/regenerate', async (c) => {
    const agentId = decodeURIComponent(c.req.param('agentId'));
    const messageId = decodeURIComponent(c.req.param('messageId'));
    let _body; try { _body = await c.req.json(); } catch { _body = null; }
    try {
      const runtime = society.runtime;
      if (!runtime) return c.json({ error: "society_not_initialized" }, 500);
      const original = messagesById.get(messageId) ?? null;
      const result = await runtime.regenerateLastAssistantReply(agentId, messageId, { responseTarget: original?.to ?? "user", taskId: original?.taskId ?? null });
      if (!result?.ok) {
        if (result?.error === "agent_not_found") return c.json({ error: result.error }, 404);
        if (result?.error === "agent_not_idle") return c.json({ error: result.error, status: result.status ?? "unknown" }, 409);
        if (result?.error === "message_not_found" || result?.error === "message_not_assistant" || result?.error === "message_not_last_assistant") return c.json({ error: result.error }, 400);
        return c.json({ error: result?.error || "regenerate_failed", message: result?.message ?? null }, 500);
      }
      const removedIds = Array.isArray(result.removedMessageIds) ? result.removedMessageIds : [messageId];
      await removeMsgFromAgentLogs(removedIds);
      removeMessagesFromIndexes(removedIds);
      return c.json({ ok: true, agentId, messageId, removedMessageIds: removedIds, turnId: result.turnId ?? null });
    } catch (handleErr) {
      console.error("[regenerate] 处理失败", { agentId, messageId, error: handleErr?.message ?? String(handleErr), stack: handleErr?.stack ?? null });
      void log.error("重新生成最后一条回复失败", { agentId, messageId, error: handleErr?.message ?? String(handleErr), stack: handleErr?.stack ?? null });
      return c.json({ error: "internal_error", message: handleErr?.message ?? String(handleErr) }, 500);
    }
  });

  app.post('/api/agent/:agentId/generate-reply', async (c) => {
    const agentId = decodeURIComponent(c.req.param('agentId'));
    let body; try { body = await c.req.json(); } catch { body = null; }
    const messageContent = body?.messageContent ?? "";
    try {
      const runtime = society.runtime;
      if (!runtime) return c.json({ error: "society_not_initialized" }, 500);
      const result = await runtime.generateReplyForLastUserMessage(agentId, messageContent);
      if (!result?.ok) {
        if (result?.error === "agent_not_found") return c.json({ error: result.error }, 404);
        if (result?.error === "agent_not_idle") return c.json({ error: result.error, status: result.status ?? "unknown" }, 409);
        if (result?.error === "missing_message_content") return c.json({ error: result.error }, 400);
        return c.json({ error: result?.error || "generate_reply_failed", message: result?.message ?? null }, 500);
      }
      return c.json({ ok: true, agentId, turnId: result.turnId ?? null });
    } catch (handleErr) {
      console.error("[generate-reply] 处理失败", { agentId, error: handleErr?.message ?? String(handleErr), stack: handleErr?.stack ?? null });
      void log.error("生成回复失败", { agentId, error: handleErr?.message ?? String(handleErr), stack: handleErr?.stack ?? null });
      return c.json({ error: "internal_error", message: handleErr?.message ?? String(handleErr) }, 500);
    }
  });

  app.post('/api/agent/:agentId/suggest-replies', async (c) => {
    const agentId = decodeURIComponent(c.req.param('agentId'));
    try {
      const runtime = society.runtime;
      if (!runtime) return c.json({ error: "society_not_initialized" }, 500);
      let _body; try { _body = await c.req.json(); } catch { _body = null; }
      const result = await runtime.suggestRepliesForAgent(agentId);
      if (!result?.ok) {
        if (result?.error === "agent_not_found") return c.json({ error: result.error }, 404);
        return c.json({ error: result?.error || "suggest_replies_failed", message: result?.message ?? null }, 500);
      }
      return c.json({ ok: true, agentId, suggestions: result.suggestions ?? [] });
    } catch (handleErr) {
      console.error("[suggest-replies] 处理失败", { agentId, error: handleErr?.message ?? String(handleErr), stack: handleErr?.stack ?? null });
      void log.error("生成推荐回复建议失败", { agentId, error: handleErr?.message ?? String(handleErr), stack: handleErr?.stack ?? null });
      return c.json({ error: "internal_error", message: handleErr?.message ?? String(handleErr) }, 500);
    }
  });

  app.delete('/api/agent/:agentId/messages/:messageId', async (c) => {
    const agentId = decodeURIComponent(c.req.param('agentId'));
    const messageId = decodeURIComponent(c.req.param('messageId'));
    try {
      let deletedConv = false, deletedLog = false;
      const result = await society.runtime._conversationManager.deleteMessage(agentId, messageId);
      if (result?.ok) deletedConv = true;
      else if (result?.error !== "conversation_not_found" && result?.error !== "message_not_found") return c.json({ error: "conversation_delete_failed", message: result?.error || "unknown_error" }, 500);
      const msgs = messagesByAgent.get(agentId);
      if (msgs) { const idx = msgs.findIndex(m => m.id === messageId); if (idx !== -1) { msgs.splice(idx, 1); await rewriteMessageLog(agentId); deletedLog = true; } }
      if (!deletedConv && !deletedLog) return c.json({ error: "message_not_found" }, 404);
      removeMessageFromIndexes(messageId);
      return c.json({ ok: true, deletedFromConversation: deletedConv, deletedFromLog: deletedLog });
    } catch (err) { return c.json({ error: "internal_error", message: err.message }, 500); }
  });

  app.post('/api/agent/:agentId/messages/batch-delete', async (c) => {
    const agentId = decodeURIComponent(c.req.param('agentId'));
    let body; try { body = await c.req.json(); } catch { body = null; }
    if (!body) return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    const { messageIds } = body;
    if (!Array.isArray(messageIds)) return c.json({ error: "invalid_message_ids" }, 400);
    try {
      let deletedConvCount = 0, deletedLogCount = 0;
      const result = await society.runtime._conversationManager.deleteMessages(agentId, messageIds);
      if (result?.ok) deletedConvCount = Number(result.deletedCount || 0);
      else if (result?.error !== "conversation_not_found") { void log.error("[batch-delete] conversationManager 删除失败", { agentId, error: result?.error }); return c.json({ error: "conversation_batch_delete_failed", message: result?.error || "unknown_error" }, 500); }
      const msgs = messagesByAgent.get(agentId);
      if (msgs) {
        const idsSet = new Set(messageIds);
        const prevLen = msgs.length;
        for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i]?.id != null && idsSet.has(String(msgs[i].id))) msgs.splice(i, 1); }
        if (prevLen !== msgs.length) await rewriteMessageLog(agentId);
        deletedLogCount = prevLen - msgs.length;
      }
      if (deletedConvCount === 0 && deletedLogCount === 0) return c.json({ error: "message_not_found" }, 404);
      removeMessagesFromIndexes(messageIds);
      return c.json({ ok: true, deletedFromConversationCount: deletedConvCount, deletedFromLogCount: deletedLogCount });
    } catch (err) {
      void log.error("[batch-delete] 批量删除异常", { agentId, error: err?.message ?? String(err), stack: err?.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  app.delete('/api/agent/:agentId/history', async (c) => {
    const agentId = decodeURIComponent(c.req.param('agentId'));
    try {
      await society.runtime._conversationManager.clearConversation(agentId);
      society.runtime.agentMemoryManager.clearMemory(agentId).catch(clearErr => { void log.warn("清空智能体记忆失败", { agentId, error: clearErr?.message || String(clearErr), stack: clearErr?.stack }); });
      const agent = society.runtime.org.getAgent(agentId);
      if (agent && typeof agent.setLastMemoryMessageId === "function") agent.setLastMemoryMessageId(null);
      if (messagesByAgent.has(agentId)) {
        clearAgentMessageIndexes(agentId);
        messagesByAgent.set(agentId, []);
        await clearMessagesFile(agentId);
      }
      return c.json({ ok: true });
    } catch (err) { return c.json({ error: "internal_error", message: err.message }, 500); }
  });

  app.get('/api/agents/messages', async (c) => {
    try {
      const limit = parseInt(c.req.query('limit') || "50", 10);
      const result = {};
      for (const agentId of messagesByAgent.keys()) {
        const allMsgs = await loadMessagesForAgent(agentId);
        result[agentId] = { messages: allMsgs.slice(Math.max(0, allMsgs.length - limit)), total: allMsgs.length };
      }
      return c.json({ agents: result });
    } catch (err) {
      void log.error("批量加载智能体消息失败", { error: err.message, stack: err.stack });
      return c.json({ error: "load_all_agent_messages_failed", message: err.message }, 500);
    }
  });
}

// ===========================================================================
// 声明式注册
// ===========================================================================

registry.declare({
  name: 'message-routes',
  requires: ['app', 'log', 'society', 'runtimeDir'],
  provides: [],
  async init(deps) {
    await registerMessageRoutes(deps);
    return {};
  }
});
