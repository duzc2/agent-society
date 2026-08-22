/**
 * ui_page 模块 — 自动加载脚本注册表
 *
 * 职责：
 * - 记录勾选了「自动加载」的 eval 脚本（只记录工作区路径，不复制文件）
 * - 每次页面刷新/加载时，前端按注册顺序读取并执行「启用」的脚本
 * - 持久化到 config/modules/ui_page.json（configService 模块配置）
 *
 * 设计说明：
 * - id 为复合主键 workspaceId:path，天然去重、跨重启稳定、JSON 可读可排查
 * - add 幂等：同 id 已存在则恢复启用并更新名称，不新增
 *   （用户重新勾选「自动加载」并保存，即明确表达启用意图）
 * - 数组顺序 = 注册顺序 = 执行顺序（toggle/remove 不改序）
 * - 读文件直接 fs（remote 模块先例：读不触发功能），带路径越界防护
 */

import path from "node:path";
import fsp from "node:fs/promises";
import { getWorkspaceManager } from "../../src/platform/services/workspace/workspace_manager.js";

const CONFIG_KEY = "autoLoadScripts";

// 脚本头部目的描述约定：保存脚本时写入文件首行 `// purpose: xxx`（withPurposeHeader），
// 读取侧从文件前 20 行内解析（extractPurpose），无匹配返回空字符串。
// 注册表不冗余存储描述——文件是唯一数据源，候选（未注册）脚本与已注册脚本共用同一解析。
const PURPOSE_RE = /^\/\/\s*purpose:\s*(.*)$/;
const MAX_PURPOSE_HEADER_SCAN_LINES = 20;
const MAX_PURPOSE_READ_LENGTH = 500;
const MAX_PURPOSE_WRITE_LENGTH = 200;

/**
 * 校验单条注册表条目（配置文件是外部数据，形状不可信）。
 */
function isValidEntry(s) {
  return (
    s !== null &&
    typeof s === "object" &&
    typeof s.id === "string" &&
    typeof s.workspaceId === "string" &&
    typeof s.path === "string"
  );
}

/**
 * 解析工作区文件绝对路径（带路径越界防护）。
 * @param {{workspaceId: string, path: string}} entry
 * @returns {string}
 */
function _resolveWorkspaceAbsPath(entry) {
  const wm = getWorkspaceManager();
  if (!wm) {
    throw new Error("workspace_manager_unavailable");
  }
  const root = path.resolve(wm.getWorkspacePath(entry.workspaceId));
  const abs = path.resolve(root, entry.path);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`路径超出工作区范围: ${entry.path}`);
  }
  return abs;
}

/**
 * 读取工作区文件内容（直接 fs 读，remote 模块先例），带路径越界防护。
 * @param {{workspaceId: string, path: string}} entry
 * @returns {Promise<string>}
 */
async function _readWorkspaceFile(entry) {
  return await fsp.readFile(_resolveWorkspaceAbsPath(entry), "utf8");
}

/**
 * 只读工作区文件前 maxBytes 字节（供解析头部目的描述，避免为取头部注释整读大脚本）。
 * @param {{workspaceId: string, path: string}} entry
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function _readWorkspaceFilePrefix(entry, maxBytes) {
  const fh = await fsp.open(_resolveWorkspaceAbsPath(entry), "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * 从脚本内容解析头部目的描述（`// purpose: xxx` 约定，首个匹配生效）。
 * 只扫描前 MAX_PURPOSE_HEADER_SCAN_LINES 行；无匹配返回空字符串。
 * @param {string} content
 * @returns {string}
 */
export function extractPurpose(content) {
  if (typeof content !== "string" || !content) return "";
  const lines = content.split(/\r?\n/);
  const limit = Math.min(lines.length, MAX_PURPOSE_HEADER_SCAN_LINES);
  for (let i = 0; i < limit; i++) {
    const m = lines[i].trim().match(PURPOSE_RE);
    if (m) {
      return m[1].trim().slice(0, MAX_PURPOSE_READ_LENGTH);
    }
  }
  return "";
}

/**
 * 生成带头部目的描述的脚本内容：`// purpose: xxx\n` + 原内容。
 * purpose 缺失/非法时原样返回 content（老客户端不传 purpose 行为不变）。
 * 折叠换行与连续空白为单空格——`//` 行注释以换行结尾，描述若含换行会逃逸注释注入代码，
 * 必须清洗；JS 的 \s 同时覆盖 \u2028/\u2029，一并折叠。
 * @param {string} content
 * @param {unknown} purpose
 * @returns {string}
 */
export function withPurposeHeader(content, purpose) {
  if (typeof purpose !== "string") return content;
  const cleaned = purpose.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return content;
  return `// purpose: ${cleaned.slice(0, MAX_PURPOSE_WRITE_LENGTH)}\n${content}`;
}

/**
 * 创建自动加载注册表实例。
 * configService/log 为功能组件必选依赖，缺失直接抛错暴露问题（铁律：禁止空值兼容）。
 * @param {{configService: any, log: any}} options
 */
export function createAutoLoadRegistry({ configService, log }) {
  if (!configService) throw new Error("AutoLoadRegistry 缺少必选依赖: configService");
  if (!log) throw new Error("AutoLoadRegistry 缺少必选依赖: log");

  /** @type {Array<{id: string, name: string, workspaceId: string, path: string, enabled: boolean, createdAt: string}>} */
  let _scripts = [];

  /** 持久化全量列表（configService 合并语义：只覆盖 autoLoadScripts 键） */
  async function _persist() {
    await configService.saveModuleConfig("ui_page", { [CONFIG_KEY]: _scripts });
  }

  return {
    /**
     * 从配置加载注册表；损坏/缺失一律回退空列表，绝不使模块初始化失败。
     */
    async load() {
      try {
        const cfg = await configService.getModuleConfig("ui_page");
        _scripts = Array.isArray(cfg?.[CONFIG_KEY]) ? cfg[CONFIG_KEY].filter(isValidEntry) : [];
      } catch (err) {
        // 配置文件是外部数据：损坏 JSON 等必须容错，但日志要足够排查
        log.error("[AutoLoad] 加载自动加载注册表失败，回退空列表", {
          error: err.message,
          stack: err.stack,
        });
        _scripts = [];
      }
    },

    /**
     * 添加/恢复自动加载条目（幂等：同 workspaceId:path 已存在则恢复启用并更新名称）。
     * @param {{workspaceId: string, path: string, name?: string}} input
     * @returns {Promise<{ok: true, entry: object, alreadyExisted: boolean}>}
     */
    async add({ workspaceId, path: scriptPath, name }) {
      const id = `${workspaceId}:${scriptPath}`;
      const existing = _scripts.find((s) => s.id === id);
      if (existing) {
        existing.enabled = true;
        if (name) existing.name = name;
        await _persist();
        return { ok: true, entry: existing, alreadyExisted: true };
      }
      const entry = {
        id,
        name: name ?? path.basename(scriptPath, ".js"),
        workspaceId,
        path: scriptPath,
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      _scripts.push(entry);
      await _persist();
      return { ok: true, entry, alreadyExisted: false };
    },

    /**
     * 返回注册表列表副本（修改返回值不影响内部状态）。
     */
    list() {
      return _scripts.map((s) => ({ ...s }));
    },

    /**
     * 返回注册表列表副本，并附上从脚本文件头部解析出的目的描述（description）。
     * 逐条读文件前缀解析，单条失败（文件缺失/越界/读取错误）仅该条 description 为空，
     * 不影响其余条目（与 getExecutables 逐条容错同哲学）。
     * @returns {Promise<Array<object>>}
     */
    async listWithDescriptions() {
      const out = [];
      for (const s of _scripts) {
        try {
          const prefix = await _readWorkspaceFilePrefix(s, 4096);
          out.push({ ...s, description: extractPurpose(prefix) });
        } catch (err) {
          log.error("[AutoLoad] 读取脚本描述失败", {
            id: s.id,
            path: s.path,
            error: err?.message ?? String(err),
            stack: err?.stack,
          });
          out.push({ ...s, description: "" });
        }
      }
      return out;
    },

    /**
     * 启用/禁用指定条目。
     * @returns {Promise<{ok: true} | {ok: false, error: string}>}
     */
    async setEnabled(id, enabled) {
      const entry = _scripts.find((s) => s.id === id);
      if (!entry) return { ok: false, error: "not_found" };
      entry.enabled = enabled === true;
      await _persist();
      return { ok: true };
    },

    /**
     * 移除指定条目（仅移除注册记录，不删除工作区文件）。
     * @returns {Promise<boolean>} 是否真的移除
     */
    async remove(id) {
      const idx = _scripts.findIndex((s) => s.id === id);
      if (idx < 0) return false;
      _scripts.splice(idx, 1);
      await _persist();
      return true;
    },

    /**
     * 读取指定条目的脚本内容（供面板"运行"预览）。
     * @param {string} id
     * @returns {Promise<{ok: true, entry: object, script: string} | {ok: false, error: string, message?: string}>}
     */
    async getScriptContent(id) {
      const entry = _scripts.find((s) => s.id === id);
      if (!entry) return { ok: false, error: "not_found" };
      try {
        const script = await _readWorkspaceFile(entry);
        return { ok: true, entry, script };
      } catch (err) {
        return { ok: false, error: "read_failed", message: err?.message ?? String(err) };
      }
    },

    /**
     * 按 workspaceId+path 直接读取文件内容（供面板候选列表"运行"预览，条目未注册也可运行）。
     * @param {string} workspaceId
     * @param {string} scriptPath 工作区内相对路径（如 ui_page_js/foo.js）
     * @returns {Promise<{ok: true, script: string} | {ok: false, error: string, message?: string}>}
     */
    async getFileContent(workspaceId, scriptPath) {
      try {
        const script = await _readWorkspaceFile({ workspaceId, path: scriptPath });
        return { ok: true, script };
      } catch (err) {
        return { ok: false, error: "read_failed", message: err?.message ?? String(err) };
      }
    },

    /**
     * 枚举所有工作区 ui_page_js/ 下的可添加脚本（供面板"添加脚本"使用）。
     * 排除已在注册表中的条目（无论启用与否）；某工作区无该目录或读取失败时跳过。
     * description 从脚本文件头部注释解析（与已注册条目同一数据源），单文件解析失败为 ""。
     * @returns {Promise<Array<{workspaceId: string, path: string, name: string, description: string}>>}
     */
    async getAvailableCandidates() {
      const wm = getWorkspaceManager();
      if (!wm || typeof wm.listWorkspaces !== "function") {
        throw new Error("workspace_manager_unavailable");
      }

      const registered = new Set(_scripts.map((s) => s.id));
      const candidates = [];
      const workspaces = await wm.listWorkspaces();

      for (const ws of workspaces) {
        const dir = path.join(wm.getWorkspacePath(ws.id), "ui_page_js");
        let files;
        try {
          files = await fsp.readdir(dir, { withFileTypes: true });
        } catch (err) {
          // 目录缺失或读取失败：该工作区没有可添加脚本，跳过（记录以排查权限类问题）
          log.debug("[AutoLoad] 读取工作区 ui_page_js 目录失败，跳过", {
            workspaceId: ws.id,
            dir,
            error: err?.message ?? String(err),
          });
          continue;
        }
        for (const f of files) {
          if (!f.isFile() || !f.name.endsWith(".js")) continue;
          const p = `ui_page_js/${f.name}`;
          if (registered.has(`${ws.id}:${p}`)) continue;
          let description = "";
          try {
            const prefix = await _readWorkspaceFilePrefix({ workspaceId: ws.id, path: p }, 4096);
            description = extractPurpose(prefix);
          } catch (err) {
            // 单文件描述读取失败：候选仍可添加，记录以排查权限/路径问题
            log.error("[AutoLoad] 读取候选脚本描述失败", {
              workspaceId: ws.id,
              path: p,
              error: err?.message ?? String(err),
              stack: err?.stack,
            });
          }
          candidates.push({ workspaceId: ws.id, path: p, name: f.name.slice(0, -3), description });
        }
      }

      return candidates;
    },

    /**
     * 取所有「启用」条目的可执行内容（逐条读文件，失败进 errors，不抛整批）。
     * @returns {Promise<{scripts: Array<{id: string, name: string, workspaceId: string, path: string, script: string}>, errors: Array<{id: string, name: string, workspaceId: string, path: string, error: string}>}>}
     */
    async getExecutables() {
      const enabled = _scripts.filter((s) => s.enabled !== false);
      const scripts = [];
      const errors = [];
      for (const entry of enabled) {
        try {
          const content = await _readWorkspaceFile(entry);
          scripts.push({
            id: entry.id,
            name: entry.name,
            workspaceId: entry.workspaceId,
            path: entry.path,
            script: content,
          });
        } catch (err) {
          errors.push({
            id: entry.id,
            name: entry.name,
            workspaceId: entry.workspaceId,
            path: entry.path,
            error: err?.message ?? String(err),
          });
        }
      }
      return { scripts, errors };
    },
  };
}

// 模块内单例（broker.js 同款）：ui_page/index.js init 时创建注入，save-eval-script.js 读取
let _registry = null;

/** 获取注册表单例（模块内部使用） */
export function getAutoLoadRegistry() {
  return _registry;
}

/** 仅供测试/初始化使用：注入注册表实例 */
export function _setAutoLoadRegistry(r) {
  _registry = r;
}
