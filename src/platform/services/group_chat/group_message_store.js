/**
 * GroupMessageStore — 群历史存储（纯数据层，无外部依赖）
 *
 * 职责：
 * - 群消息持久化（groups/<groupId>.jsonl）
 * - 群消息历史查询（分页、时间范围）
 * - 系统消息写入
 *
 * 不注册到 DI，由 GroupChatService 在 init() 中实例化。
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export class GroupMessageStore {
  /**
   * @param {object} options
   * @param {string} options.messagesDir - 消息存储目录（web/messages/groups）
   * @param {{debug?:Function, info?:Function, warn?:Function, error?:Function}} options.logger
   */
  constructor({ messagesDir, logger }) {
    this._messagesDir = messagesDir;
    this.log = logger;

    /** @type {Map<string, GroupMessage[]>} 内存缓存 groupId -> messages */
    this._cache = new Map();

    /** @type {Map<string, Promise<void>>} 每群文件的串行写队列，防止 append 与整文件重写竞争 */
    this._writeQueues = new Map();

    /** @type {Set<string>} 已从磁盘加载过缓存的群（防止空缓存重写覆盖历史文件） */
    this._loaded = new Set();
  }

  /**
   * 初始化存储目录。
   */
  async init() {
    await mkdir(this._messagesDir, { recursive: true });
  }

  /**
   * 获取群消息文件路径。
   * @param {string} groupId
   * @returns {string}
   */
  _filePath(groupId) {
    return path.join(this._messagesDir, `${groupId}.jsonl`);
  }

  /**
   * 串行写队列：同一群文件的所有落盘操作排队执行，避免 append 与整文件重写竞争。
   * @param {string} groupId
   * @param {() => Promise<any>} fn
   * @returns {Promise<any>}
   */
  _enqueueWrite(groupId, fn) {
    const prev = this._writeQueues.get(groupId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this._writeQueues.set(groupId, next.then(() => {}, () => {}));
    return next;
  }

  /**
   * 从内存缓存整文件重写（内存为唯一权威源，磁盘终态 = 内存终态）。
   * @param {string} groupId
   */
  _rewrite(groupId) {
    const cached = this._cache.get(groupId) ?? [];
    return this._enqueueWrite(groupId, async () => {
      const filePath = this._filePath(groupId);
      await mkdir(path.dirname(filePath), { recursive: true });
      const content = cached.map(m => JSON.stringify(m)).join("\n");
      await writeFile(filePath, cached.length > 0 ? content + "\n" : "", "utf8");
    });
  }

  /**
   * 确保群消息缓存已从磁盘加载（整文件重写前缓存必须与磁盘一致，
   * 否则空缓存会把已有历史文件清空）。
   * @param {string} groupId
   */
  async _ensureLoaded(groupId) {
    if (!this._loaded.has(groupId)) {
      await this.loadMessages(groupId);
    }
  }

  /**
   * 写入群消息（内存先行 + 队列内全量落盘）。
   * @param {string} groupId
   * @param {GroupMessage} message
   */
  async append(groupId, message) {
    await this._ensureLoaded(groupId);
    this._cache.get(groupId).push(message);
    await this._rewrite(groupId);
  }

  /**
   * 批量写入群消息（一次内存更新 + 一次落盘）。
   * @param {string} groupId
   * @param {GroupMessage[]} messages
   */
  async appendBatch(groupId, messages) {
    if (messages.length === 0) return;
    await this._ensureLoaded(groupId);
    this._cache.get(groupId).push(...messages);
    await this._rewrite(groupId);
  }

  /**
   * 更新群消息内容（保留 kind/from/taskId/createdAt）。
   * @param {string} groupId
   * @param {string} messageId
   * @param {object} payload - 新内容（浅合并进原 payload）
   * @returns {Promise<GroupMessage|null>} 更新后的消息；消息不存在返回 null
   */
  async update(groupId, messageId, payload) {
    await this._ensureLoaded(groupId);
    const cached = this._cache.get(groupId);
    if (!cached) return null;
    const idx = cached.findIndex(m => m.id === messageId);
    if (idx === -1) return null;
    cached[idx] = { ...cached[idx], payload: { ...cached[idx].payload, ...payload } };
    await this._rewrite(groupId);
    return cached[idx];
  }

  /**
   * 删除群消息。
   * @param {string} groupId
   * @param {string} messageId
   * @returns {Promise<GroupMessage|null>} 被删除的消息；消息不存在返回 null
   */
  async remove(groupId, messageId) {
    await this._ensureLoaded(groupId);
    const cached = this._cache.get(groupId);
    if (!cached) return null;
    const idx = cached.findIndex(m => m.id === messageId);
    if (idx === -1) return null;
    const [removed] = cached.splice(idx, 1);
    await this._rewrite(groupId);
    return removed;
  }

  /**
   * 获取群消息历史（从内存缓存）。
   * @param {string} groupId
   * @param {object} [options]
   * @param {number} [options.limit] - 最大返回条数，默认 200
   * @param {number} [options.offset] - 偏移量
   * @returns {GroupMessage[]}
   */
  getMessages(groupId, options = {}) {
    const { limit = 200, offset = 0 } = options;
    const cached = this._cache.get(groupId);
    if (!cached) return [];
    return cached.slice(offset, offset + limit);
  }

  /**
   * 从磁盘加载群消息历史到内存。
   * @param {string} groupId
   * @returns {Promise<GroupMessage[]>}
   */
  async loadMessages(groupId) {
    const filePath = this._filePath(groupId);
    const messages = [];

    try {
      const stream = createReadStream(filePath, { encoding: "utf8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          messages.push(JSON.parse(line));
        } catch {
          this.log.warn("[GroupMessageStore] 跳过无效行", { groupId });
        }
      }

      this._cache.set(groupId, messages);
      this._loaded.add(groupId);
      return messages;
    } catch (err) {
      if (err.code === "ENOENT") {
        this._cache.set(groupId, []);
        this._loaded.add(groupId);
        return [];
      }
      this.log.error("[GroupMessageStore] 加载群消息失败", {
        groupId,
        message: err.message,
        stack: err.stack
      });
      return [];
    }
  }

  /**
   * 创建群消息对象。
   * 只存储发送者 ID，前端通过 ID 匹配智能体名称。
   * @param {object} params
   * @param {'group'|'group_system'} params.kind
   * @param {string} params.groupId
   * @param {string} params.from
   * @param {string} [params.taskId]
   * @param {object} params.payload
   * @returns {GroupMessage}
   */
  createMessage({ kind, groupId, from, taskId, payload }) {
    return {
      id: randomUUID(),
      kind,
      groupId,
      from,
      taskId: taskId || null,
      payload: payload || { text: "" },
      createdAt: new Date().toISOString().replace("T", " ").slice(0, 19)
    };
  }

  /**
   * 创建系统消息。
   * @param {string} groupId
   * @param {string} text - 系统消息内容
   * @returns {GroupMessage}
   */
  createSystemMessage(groupId, text) {
    return this.createMessage({
      kind: "group_system",
      groupId,
      from: "system",
      payload: { text }
    });
  }
}

/**
 * @typedef {object} GroupMessage
 * @property {string} id - 群消息全局唯一 ID（完整 UUID）
 * @property {'group'|'group_system'} kind - 消息类型
 * @property {string} groupId - 群 ID
 * @property {string} from - 发送者 ID
 * @property {string|null} taskId - 关联任务 ID
 * @property {object} payload - 消息内容
 * @property {string} createdAt - 创建时间
 */