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
 * 读取工作区文件内容（直接 fs 读，remote 模块先例），带路径越界防护。
 * @param {{workspaceId: string, path: string}} entry
 * @returns {Promise<string>}
 */
async function _readWorkspaceFile(entry) {
  const wm = getWorkspaceManager();
  if (!wm) {
    throw new Error("workspace_manager_unavailable");
  }
  const root = path.resolve(wm.getWorkspacePath(entry.workspaceId));
  const abs = path.resolve(root, entry.path);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`路径超出工作区范围: ${entry.path}`);
  }
  return await fsp.readFile(abs, "utf8");
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
     * @returns {Promise<Array<{workspaceId: string, path: string, name: string}>>}
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
          candidates.push({ workspaceId: ws.id, path: p, name: f.name.slice(0, -3) });
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
