/**
 * GroupRegistry — 群元数据存储（纯数据层，无外部依赖）
 *
 * 职责：
 * - 群元数据 CRUD（groups.json 持久化）
 * - 成员查询
 * - 群状态管理（active / archived）
 *
 * 不注册到 DI，由 GroupChatService 在 init() 中实例化。
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export class GroupRegistry {
  /**
   * @param {object} options
   * @param {string} options.dataDir - 数据目录（data/runtime/state）
   * @param {{debug?:Function, info?:Function, warn?:Function, error?:Function}} options.logger
   */
  constructor({ dataDir, logger }) {
    this._dataDir = dataDir;
    this.log = logger;

    /** @type {string} groups.json 文件路径 */
    this._filePath = path.join(this._dataDir, "groups.json");

    /** @type {Array<GroupMeta>} */
    this._groups = [];
  }

  /**
   * 加载群元数据。
   */
  async load() {
    try {
      await mkdir(path.dirname(this._filePath), { recursive: true });
      const raw = await readFile(this._filePath, "utf8");
      const parsed = JSON.parse(raw);
      this._groups = Array.isArray(parsed.groups) ? parsed.groups : [];
      this.log.info("[GroupRegistry] 群元数据加载完成", { count: this._groups.length });
    } catch (err) {
      if (err.code === "ENOENT") {
        this._groups = [];
        await this._save();
        this.log.info("[GroupRegistry] 群元数据文件不存在，已创建空文件");
      } else {
        this.log.error("[GroupRegistry] 加载群元数据失败", {
          message: err.message,
          stack: err.stack
        });
        this._groups = [];
      }
    }
  }

  /**
   * 持久化群元数据到磁盘。
   * @private
   */
  async _save() {
    await mkdir(path.dirname(this._filePath), { recursive: true });
    await writeFile(this._filePath, JSON.stringify({ groups: this._groups }, null, 2), "utf8");
  }

  /**
   * 获取所有群（可按状态过滤）。
   * @param {string} [status] - 可选：'active' | 'archived'
   * @returns {GroupMeta[]}
   */
  list(status) {
    if (status) {
      return this._groups.filter(g => g.status === status);
    }
    return this._groups;
  }

  /**
   * 获取指定群。
   * @param {string} groupId
   * @returns {GroupMeta|undefined}
   */
  get(groupId) {
    return this._groups.find(g => g.id === groupId);
  }

  /**
   * 获取某个智能体所在的所有群。
   * @param {string} agentId
   * @returns {GroupMeta[]}
   */
  listByMember(agentId) {
    return this._groups.filter(g => g.members.includes(agentId) && g.status === "active");
  }

  /**
   * 获取某个智能体所在的所有群 ID。
   * @param {string} agentId
   * @returns {string[]}
   */
  listGroupIdsByMember(agentId) {
    return this.listByMember(agentId).map(g => g.id);
  }

  /**
   * 创建群。
   * 使用完整 UUID，与智能体 ID 生成规则一致。
   * @param {object} params
   * @param {string} params.name - 群名（必填）
   * @param {string[]} params.members - 初始成员列表
   * @param {string} [params.description] - 群描述
   * @returns {GroupMeta}
   */
  async create({ name, members, description }) {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    const group = {
      id: randomUUID(),
      name,
      description: description || "",
      members: [...new Set(members)],
      exitedMembers: [],
      createdAt: now,
      updatedAt: now,
      status: "active",
      lastMessageAt: now,
      lastMessagePreview: "群聊已创建"
    };
    this._groups.push(group);
    await this._save();
    return group;
  }

  /**
   * 检查是否为群成员。
   * @param {string} groupId
   * @param {string} agentId
   * @returns {boolean}
   */
  isMember(groupId, agentId) {
    const group = this.get(groupId);
    if (!group) return false;
    return group.members.includes(agentId);
  }

  /**
   * 添加成员到群。
   * @param {string} groupId
   * @param {string[]} agentIds
   * @returns {GroupMeta}
   */
  async addMembers(groupId, agentIds) {
    const group = this.get(groupId);
    if (!group) throw new Error(`群 ${groupId} 不存在`);

    for (const id of agentIds) {
      if (!group.members.includes(id)) {
        group.members.push(id);
      }
    }
    // 重新邀请已退出成员回群：清除其退出记录
    if (group.exitedMembers) {
      group.exitedMembers = group.exitedMembers.filter(e => !agentIds.includes(e.id));
    }
    group.updatedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
    await this._save();
    return group;
  }

  /**
   * 从群中移除成员（留存退出记录，供成员列表展示"已退出成员"）。
   * @param {string} groupId
   * @param {string[]} agentIds
   * @param {'left'|'terminated'} [reason] - 退出原因（主动退群 / 智能体终止自动退群）
   * @returns {GroupMeta}
   */
  async removeMembers(groupId, agentIds, reason = "left") {
    const group = this.get(groupId);
    if (!group) throw new Error(`群 ${groupId} 不存在`);

    const removed = group.members.filter(m => agentIds.includes(m));
    group.members = group.members.filter(m => !agentIds.includes(m));

    // 留存退出记录
    if (!group.exitedMembers) {
      group.exitedMembers = [];
    }
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    for (const id of removed) {
      if (!group.exitedMembers.some(e => e.id === id)) {
        group.exitedMembers.push({ id, leftAt: now, reason });
      }
    }

    group.updatedAt = now;
    await this._save();
    return group;
  }

  /**
   * 更新群最后消息信息。
   * @param {string} groupId
   * @param {string} messagePreview
   */
  async updateLastMessage(groupId, messagePreview) {
    const group = this.get(groupId);
    if (!group) return;

    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    group.lastMessageAt = now;
    group.lastMessagePreview = messagePreview.slice(0, 100);
    group.updatedAt = now;
    await this._save();
  }

  /**
   * 归档（解散）群。
   * @param {string} groupId
   */
  async archive(groupId) {
    const group = this.get(groupId);
    if (!group) throw new Error(`群 ${groupId} 不存在`);

    group.status = "archived";
    group.updatedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
    await this._save();
  }

  /**
   * 更新群名称。
   * @param {string} groupId
   * @param {string} name
   */
  async updateName(groupId, name) {
    const group = this.get(groupId);
    if (!group) throw new Error(`群 ${groupId} 不存在`);
    group.name = name;
    group.updatedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
    await this._save();
  }
}

/**
 * @typedef {object} GroupMeta
 * @property {string} id - 群 ID（完整 UUID）
 * @property {string} name - 群名
 * @property {string} description - 群描述
 * @property {string[]} members - 成员 ID 列表（仅活跃成员）
 * @property {Array<{id: string, leftAt: string, reason: 'left'|'terminated'}>} exitedMembers - 已退出成员记录
 * @property {string} createdAt - 创建时间
 * @property {string} updatedAt - 更新时间
 * @property {'active'|'archived'} status - 群状态
 * @property {string} lastMessageAt - 最后消息时间
 * @property {string} lastMessagePreview - 最后消息预览
 */