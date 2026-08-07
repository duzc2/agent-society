/**
 * PolicyStore — 命令策略持久化存储
 *
 * 数据文件：data/runtime/state/localcmd_cmdpolicy.json
 * 按 orgId 分键，附带全局 defaults 回退
 * v2: PolicyEntry 对象格式 + 透明迁移旧字符串格式
 */

import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

/** @typedef {{type: "glob"|"regex", pattern: string, reason?: string}} PolicyEntry */
/** @typedef {{whitelist: PolicyEntry[], blacklist: PolicyEntry[]}} CmdPolicy */

const DEFAULT_POLICY = {
  whitelist: [],
  blacklist: [
    { type: "glob", pattern: "rm -rf*" },
    { type: "glob", pattern: "sudo rm*" },
    { type: "glob", pattern: "del /f*" },
    { type: "glob", pattern: "del /q*" },
    { type: "glob", pattern: "format*" },
    { type: "glob", pattern: "fdisk*" },
    { type: "glob", pattern: "mkfs*" },
    { type: "glob", pattern: "dd if=*" },
    { type: "glob", pattern: "> /dev/sd*" },
    { type: "glob", pattern: "shutdown*" },
    { type: "glob", pattern: "reboot*" },
    { type: "glob", pattern: "halt*" },
    { type: "glob", pattern: "poweroff*" },
    { type: "glob", pattern: "chmod 777*" },
    { type: "glob", pattern: ":(){ :|:& };:*" },  // fork bomb
  ]
};

/**
 * 迁移单个条目：旧字符串 → 新 PolicyEntry 对象（追加 * 保留前缀语义）
 * @param {string|PolicyEntry} entry
 * @returns {PolicyEntry}
 */
function migrateEntry(entry) {
  if (typeof entry === "string") {
    return { type: "glob", pattern: entry + "*" };
  }
  return entry;
}

/**
 * 迁移条目数组
 * @param {Array<string|PolicyEntry>} entries
 * @returns {PolicyEntry[]}
 */
function migrateEntryArray(entries) {
  if (!Array.isArray(entries)) return [];
  const result = [];
  for (const entry of entries) {
    if (!entry) continue;
    const migrated = migrateEntry(entry);
    // 验证：必须有 pattern 且非空
    if (!migrated.pattern || typeof migrated.pattern !== "string" || migrated.pattern.trim().length === 0) continue;
    // 验证：type 必须为 glob 或 regex
    if (migrated.type !== "glob" && migrated.type !== "regex") continue;
    result.push(migrated);
  }
  return result;
}

/**
 * 深拷贝默认策略
 * @returns {CmdPolicy}
 */
function cloneDefaults() {
  return {
    whitelist: DEFAULT_POLICY.whitelist.map(e => ({ ...e })),
    blacklist: DEFAULT_POLICY.blacklist.map(e => ({ ...e }))
  };
}

export class PolicyStore {
  /**
   * @param {string} dataDir - 运行时数据目录
   * @param {any} [logger] - 日志器（可选，用于异常记录）
   */
  constructor(dataDir, logger) {
    this._filePath = path.join(dataDir, "state", "localcmd_cmdpolicy.json");
    this._log = logger || null;
    /** @type {{orgs: Record<string, CmdPolicy>, defaults: CmdPolicy}} */
    this._data = {
      orgs: {},
      defaults: cloneDefaults()
    };
  }

  /**
   * 从磁盘加载策略数据，文件不存在时使用默认值
   * 对读取到的所有条目执行透明迁移
   */
  async load() {
    try {
      if (!existsSync(this._filePath)) {
        return;
      }
      const content = await readFile(this._filePath, "utf8");
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object") {
        this._data.defaults = {
          whitelist: migrateEntryArray(parsed.defaults?.whitelist),
          blacklist: migrateEntryArray(parsed.defaults?.blacklist ?? DEFAULT_POLICY.blacklist)
        };
        this._data.orgs = {};
        if (parsed.orgs && typeof parsed.orgs === "object") {
          for (const [orgId, policy] of Object.entries(parsed.orgs)) {
            // 排除历史遗留的 "defaults" 伪组织（真实默认值在 defaults 字段）
            if (orgId === "defaults") continue;
            if (policy && typeof policy === "object") {
              this._data.orgs[orgId] = {
                whitelist: migrateEntryArray(policy.whitelist),
                blacklist: migrateEntryArray(policy.blacklist)
              };
            }
          }
        }
      }
    } catch (err) {
      if (this._log) {
        this._log.error("[PolicyStore] 加载策略文件失败", {
          filePath: this._filePath,
          message: err?.message ?? String(err),
          stack: err?.stack ?? "(no stack)"
        });
      }
      // 文件损坏或无法解析，回退到默认值
    }
  }

  /**
   * 保存策略数据到磁盘
   */
  async save() {
    const dir = path.dirname(this._filePath);
    await mkdir(dir, { recursive: true });
    await writeFile(this._filePath, JSON.stringify(this._data, null, 2), "utf8");
  }

  /**
   * 获取某组织的策略（不存在则返回默认值）
   * @param {string|null} orgId
   * @returns {CmdPolicy}
   */
  get(orgId) {
    if (!orgId || orgId === "defaults") {
      return {
        whitelist: [...this._data.defaults.whitelist],
        blacklist: [...this._data.defaults.blacklist]
      };
    }
    const orgPolicy = this._data.orgs[orgId];
    if (!orgPolicy) {
      return {
        whitelist: [...this._data.defaults.whitelist],
        blacklist: [...this._data.defaults.blacklist]
      };
    }
    return {
      whitelist: [...orgPolicy.whitelist],
      blacklist: [...orgPolicy.blacklist]
    };
  }

  /**
   * 获取所有策略数据（不含已损坏的 "defaults" 伪组织）
   * @returns {{orgs: Record<string, CmdPolicy>, defaults: CmdPolicy}}
   */
  getAll() {
    // 排除历史遗留的 "defaults" 伪组织条目
    const orgs = {};
    for (const [id, policy] of Object.entries(this._data.orgs)) {
      if (id !== "defaults") {
        orgs[id] = {
          whitelist: [...policy.whitelist],
          blacklist: [...policy.blacklist]
        };
      }
    }
    return {
      orgs,
      defaults: {
        whitelist: [...this._data.defaults.whitelist],
        blacklist: [...this._data.defaults.blacklist]
      }
    };
  }

  /**
   * 设置某组织的独立策略（"defaults" 为保留键，请使用 setDefaults）
   * @param {string} orgId
   * @param {CmdPolicy} policy
   */
  async set(orgId, policy) {
    if (orgId === "defaults") return; // 保留键，忽略
    this._data.orgs[orgId] = {
      whitelist: migrateEntryArray(policy?.whitelist),
      blacklist: migrateEntryArray(policy?.blacklist)
    };
    await this.save();
  }

  /**
   * 设置默认策略
   * @param {CmdPolicy} policy
   */
  async setDefaults(policy) {
    this._data.defaults = {
      whitelist: migrateEntryArray(policy?.whitelist),
      blacklist: migrateEntryArray(policy?.blacklist)
    };
    await this.save();
  }

  /**
   * 删除某组织的独立策略（回退到默认值）
   * @param {string} orgId
   */
  async remove(orgId) {
    delete this._data.orgs[orgId];
    await this.save();
  }
}
