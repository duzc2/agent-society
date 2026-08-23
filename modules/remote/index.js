/**
 * Remote 模块入口
 *
 * 职责：
 * - 将 Agent 的工具调用桥接到远程 SSH 服务器
 * - 工作区操作保持本地，工作区外的文件/命令操作通过 SSH 执行
 * - 提供 Web 配置界面
 *
 * 设计说明：
 * - 在 init 时 hook runtime.toolExecutor.executeToolCall
 * - 对配置了 remote 的 Agent，拦截文件/命令工具调用，翻译为 SSH 命令
 * - 使用 ssh2 库直接管理 SSH 连接
 * - 不修改任何现有源代码文件
 */

import RemoteManager from './remote_manager.js';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { getWorkspaceManager } from '../../src/platform/services/workspace/workspace_manager.js';

/** @type {any} 运行时实例 */
let runtime = null;

/** @type {any} 日志对象 */
let log = null;

/** @type {RemoteManager} */
let remoteManager = null;

/** @type {object} 模块配置 */
let moduleConfig = {};

/** @type {Map<string, object>} agentId -> remote server config */
let agentMappings = new Map();

/** @type {Function|null} 保存原始 executeToolCall */
let _originalExecuteToolCall = null;

// ========== 需要拦截的工具名称 ==========
// 同时收录新旧两套命名（语义等价，只覆盖执行函数，不重新声明工具）：
// - 新名：file_read / file_read_lines / edit_file / replace_file / ...
// - 旧名（agent-society workspace 工具组沿用 spec 命名）：read_file / write_file / list_directory
const INTERCEPTED_TOOLS = new Set([
  'exec_command',
  'file_read',
  'read_file', // 旧名：等价 file_read（参数 path/offset/length 一致）
  'file_read_lines',
  'list_files',
  'list_directory', // 旧名：等价 list_files（参数 path 一致）
  'file_info',
  'file_line_count',
  'file_search',
  'edit_file',
  'replace_file',
  'write_file', // 旧名：等价 replace_file（参数 path/content 一致）
  'delete_file',
  'move_file',
  'copy_file',
  'search_text',
  'file_create_directory',
  'file_stats',
  'file_json_tree',
  'file_json_keys',
  'file_jsonl_filter',
  'file_check_permission',
  'file_list_authorized_folders',
  'append_file',
  // localcmd 系列：仅 localcmd_spawn 需要桥接（选择 SSH 传输并注册进 localcmd）。
  // 其余 localcmd 工具（send_input/read_output/get_status/list/kill）随进程进入
  // localcmd 的 ProcessManager 后走原有本地代码路径，不再拦截
  'localcmd_spawn',
]);

/**
 * 判断一个路径是否在工作区内。
 * 语义与本地 file 工具一致：相对路径 = 工作区路径（必须在本地工作区执行）；
 * 绝对路径 = 已授权的外部路径（工作区外，桥接到远程）。
 */
function _isInWorkspace(filePath, workspacePath) {
  if (!filePath || !workspacePath) return false;
  // 相对路径（./x、x/y、../ 等）一律视为工作区路径，走本地
  if (!path.isAbsolute(filePath)) return true;
  const normalized = path.resolve(filePath);
  const normalizedWs = path.resolve(workspacePath);
  return normalized.startsWith(normalizedWs + path.sep) || normalized === normalizedWs;
}

/**
 * 获取 Agent 的工作区路径
 */
function _getWorkspacePath(agentId) {
    if (runtime.findWorkspaceIdForAgent) {
      const workspaceId = runtime.findWorkspaceIdForAgent(agentId);
      if (workspaceId) {
        const wm = getWorkspaceManager();
        if (wm && wm.getWorkspacePath) {
          return wm.getWorkspacePath(workspaceId);
        }
      }
    }
  return null;
}

/**
 * 把工作区路径（相对路径或工作区内绝对路径）解析为本地工作区绝对路径。
 * 用于跨侧复制时定位本地侧文件。
 * @param {string} filePath - 相对路径（如 docs/npu/README.md）或工作区绝对路径
 * @param {string} workspacePath - 工作区根目录绝对路径
 * @returns {string} 本地绝对路径
 */
function _toLocalPath(filePath, workspacePath) {
  if (!filePath) return filePath;
  if (!path.isAbsolute(filePath)) {
    return path.resolve(workspacePath, filePath);
  }
  return path.resolve(filePath);
}

/**
 * 获取工作区文件访问服务（所有工作区读写都必须走该接口，确保权限校验/元数据/审计生效）
 */
function _getWorkspaceFileAccess() {
  return runtime?.workspaceFileAccessService || null;
}

/**
 * 跨侧复制：工作区 <-> 远程
 *
 * 规则（用户语义模型）：
 * - 相对路径 = 本地工作区，绝对路径（工作区外）= 远程
 * - 写入工作区必须走 workspaceFileAccessService（权限、元数据、审计全触发）
 * - 读取工作区直接 fs 读，不折腾接口（读不触发功能）
 * - 远程侧通过 sftp 中转临时文件（remote 数据目录，工作区外），不直接操作工作区磁盘
 *
 * 与本地 copy_file 语义对齐：只支持文件，目录源返回 source_is_directory。
 *
 * @param {object} ctx
 * @param {object} mgr - RemoteManager 实例
 * @param {string} agentId
 * @param {object} remoteConfig
 * @param {string} sourcePath - 用户传入的源路径（原始参数）
 * @param {string} destPath - 用户传入的目标路径（原始参数）
 * @param {boolean} srcInWs - 源是否在工作区
 * @param {string} workspacePath - 工作区根路径
 * @param {object} fileAccess - workspaceFileAccessService 实例
 * @param {{overwrite?: boolean}} [options]
 * @returns {Promise<{ok: boolean, from?: string, to?: string, size?: number|null, error?: string, message?: string}>}
 */
async function _copyAcrossBoundary(ctx, mgr, agentId, remoteConfig, sourcePath, destPath, srcInWs, workspacePath, fileAccess, options = {}) {
  const overwrite = Boolean(options.overwrite);
  if (!fileAccess) {
    return { ok: false, error: 'workspace_service_unavailable', message: 'workspaceFileAccessService 未初始化' };
  }

  // 远程侧路径（绝对路径）
  const remotePath = srcInWs ? destPath : sourcePath;

  if (srcInWs) {
    // ===== 本地工作区 → 远程 =====
    // 1. 源在工作区：直接读取本地文件（读取不触发工作区功能，无需走接口）
    let buffer;
    try {
      buffer = await fsp.readFile(_toLocalPath(sourcePath, workspacePath));
    } catch (err) {
      return { ok: false, error: 'source_not_found', message: `源文件不存在或不可读: ${err.message}` };
    }

    // 2. 写到工作区外的临时文件
    const tmp = mgr.tmpPath(agentId);
    try {
      await fsp.mkdir(path.dirname(tmp), { recursive: true });
      await fsp.writeFile(tmp, buffer);

      // 3. sftp 上传到远程
      const up = await mgr.sftpUpload(agentId, remoteConfig, tmp, remotePath);
      if (!up.ok) return { ok: false, error: up.error || 'copy_failed', message: up.message };
      return { ok: true, from: sourcePath, to: destPath, size: buffer.length };
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }

  // ===== 远程 → 本地工作区 =====
  // 1. 检查远程源类型（对齐本地 copyFile：目录源报错）
  const typeInfo = await mgr.remotePathType(agentId, remoteConfig, remotePath);
  if (typeInfo.type === 'error') {
    // 命令执行失败（SSH 连接/channel 问题），不是源不存在，必须如实上报
    return { ok: false, error: 'remote_check_failed', message: `无法检查远程源: ${typeInfo.error || '未知错误'}` };
  }
  if (typeInfo.type === 'missing') {
    return { ok: false, error: 'source_not_found', message: '源文件不存在' };
  }
  if (typeInfo.type === 'directory') {
    return { ok: false, error: 'source_is_directory', message: '源路径是目录，不是文件' };
  }

  // 2. 下载到工作区外的临时文件（纯中转）
  const tmp = mgr.tmpPath(agentId);
  try {
    const dl = await mgr.sftpDownload(agentId, remoteConfig, remotePath, tmp);
    if (!dl.ok) return { ok: false, error: dl.error || 'copy_failed', message: dl.message };

    // 3. 目标在工作区：通过工作区接口写入（Buffer 直接写，无大小限制，二进制安全）
    const buffer = await fsp.readFile(tmp);
    const writeResult = await fileAccess.writeFile(ctx, destPath, buffer, {
      mimeType: undefined,
      operator: ctx?.agent?.id,
      messageId: ctx?.currentMessage?.id ?? `remote-copy-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    });
    if (!writeResult?.ok) {
      return { ok: false, error: writeResult?.error || 'copy_failed', message: writeResult?.message || '写入工作区失败' };
    }
    return { ok: true, from: sourcePath, to: destPath, size: writeResult.size ?? buffer.length };
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * 加载 Agent 映射配置
 */
/**
 * 解析 Agent 的组织归属上下文（与 web/v3 heartbeatService.resolveAgentContext 语义一致）：
 * 沿 parentAgentId 链向上找第一个设置了 orgName 的节点，该节点即组织管理者；
 * 若 Agent 自己设置了组织名则管理者即它自己。
 * @param {object} org - OrgPrimitives 实例
 * @param {string} agentId
 * @returns {{orgName: string|null, orgManagerName: string|null}}
 */
function resolveOrgContext(org, agentId) {
  let node = org.getAgent(agentId);
  const seen = new Set([agentId]);
  while (node && !org.getOrgName(node.id)) {
    const parentId = node.parentAgentId;
    if (!parentId || seen.has(parentId)) {
      node = null;
      break;
    }
    seen.add(parentId);
    node = org.getAgent(parentId);
  }
  if (!node) {
    // 组织名称必有值；走到这里说明组织数据链路异常，如实暴露
    return { orgName: null, orgManagerName: null };
  }
  const role = node.roleId ? org.getRole(node.roleId) : null;
  return {
    orgName: org.getOrgName(node.id) ?? null,
    orgManagerName: node.name || role?.name || node.roleId || null,
  };
}

/**
 * 解析 Agent 的远程绑定：
 * 自己显式绑定优先；未绑定时沿 parentAgentId 链向上找第一个有绑定的祖先（继承绑定关系）。
 * 运行时解析、不复制配置——父级解绑/改绑后子级自动跟随。
 * @param {string} agentId
 * @returns {{config: object, sourceAgentId: string}|null} 无绑定（含链路无绑定）返回 null
 */
function _resolveAgentMapping(agentId) {
  const own = agentMappings.get(String(agentId));
  if (own) return { config: own, sourceAgentId: String(agentId) };

  const org = runtime?.org;
  if (!org || typeof org.getAgent !== 'function') return null;

  const seen = new Set([String(agentId)]);
  let node = org.getAgent(String(agentId));
  while (node) {
    const parentId = node.parentAgentId;
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    const inherited = agentMappings.get(String(parentId));
    if (inherited) return { config: inherited, sourceAgentId: String(parentId) };
    node = org.getAgent(String(parentId));
  }
  return null;
}

/**
 * 构建继承映射表：所有未显式绑定但沿链可继承绑定的 Agent。
 * @returns {Object<string, {sourceAgentId: string, config: object}>}
 */
function _buildInheritedMappings() {
  const inherited = {};
  const org = runtime?.org;
  if (!org || typeof org.listAgents !== 'function') return inherited;

  for (const agent of org.listAgents()) {
    if (!agent || !agent.id) continue;
    if (agentMappings.has(String(agent.id))) continue; // 显式绑定的不参与继承
    const mapping = _resolveAgentMapping(String(agent.id));
    if (mapping) {
      inherited[String(agent.id)] = { sourceAgentId: mapping.sourceAgentId, config: mapping.config };
    }
  }
  return inherited;
}

function _loadMappings() {
  agentMappings.clear();
  const mappings = moduleConfig.mappings || {};
  for (const [agentId, config] of Object.entries(mappings)) {
    if (config && config.enabled !== false) {
      agentMappings.set(agentId, config);
    }
  }
  log?.info(`[Remote] 已加载 ${agentMappings.size} 个 Agent 映射`);
}

export default {
  name: 'remote',
  toolGroupId: 'remote',
  toolGroupDescription: 'Remote 桥接 — 将 Agent 工具调用桥接到远程 SSH 服务器执行',

  getWebComponent() {
    return {
      moduleName: 'remote',
      displayName: 'Remote 远程桥接',
      icon: '🌐',
      panelPath: 'modules/remote/web/panel.html'
    };
  },

  getHttpHandler() {
    return async (req, res, pathParts, body) => {
      const [resource, action] = pathParts;

      try {
        if (resource === 'mappings') {
          if (req.method === 'GET') {
            const mappings = moduleConfig.mappings || {};
            return { ok: true, mappings, inherited: _buildInheritedMappings() };
          }

          if (req.method === 'POST' && body) {
            const { agentId, config } = body;
            if (!agentId) {
              return { error: 'missing_agent_id', message: '缺少 agentId' };
            }

            const current = moduleConfig.mappings || {};
            if (config === null) {
              // 删除映射
              delete current[agentId];
            } else {
              current[agentId] = config;
            }

            const configService = runtime.configService;
            if (configService && configService.saveModuleConfig) {
              await configService.saveModuleConfig('remote', { mappings: current });
              moduleConfig.mappings = current;
              _loadMappings();
              // 删除映射时关闭远程连接，并清理 localcmd 中该 agent 的运行中进程
              // （远程进程由 localcmd 统一管理）
              if (config === null) {
                remoteManager?.closeAgent(agentId);
                const localcmdModule = runtime.moduleLoader?.getModule?.('localcmd');
                localcmdModule?.killByAgent?.(agentId);
              }
              return { ok: true, mappings: current, inherited: _buildInheritedMappings(), message: '映射已保存' };
            }
            return { error: 'config_service_unavailable' };
          }

          return { error: 'invalid_method' };
        }

        if (resource === 'test') {
          if (req.method === 'POST' && body) {
            const { host, port, username, password, privateKey, passphrase } = body;
            if (!host || !username) {
              return { error: 'missing_params', message: '缺少 host 或 username' };
            }

            try {
              const testConfig = { host, port: port || 22, username, password, privateKey, passphrase };
              const result = await remoteManager.execCommand(
                '_test_',
                testConfig,
                'echo "CONNECTION_OK" && uname -a',
                { timeout: 10000 }
              );
              return {
                ok: true,
                connected: result.stdout.includes('CONNECTION_OK'),
                systemInfo: result.stdout.replace('CONNECTION_OK\n', '').trim(),
              };
            } catch (err) {
              return { error: 'connection_failed', message: err.message };
            } finally {
              remoteManager.closeAgent('_test_');
            }
          }
          return { error: 'invalid_method' };
        }

        if (resource === 'agents') {
          // 返回所有 Agent 列表（供配置界面选择）
          // 数据源用 org（与主界面 buildOrgTree / localcmd GET /policies 一致），
          // 提供显示名、岗位名、组织名称与组织管理者名称
          try {
            const agents = [];
            const org = runtime.org;
            if (org && typeof org.listAgents === 'function') {
              const roles = new Map(
                (typeof org.listRoles === 'function' ? org.listRoles() : []).map((r) => [r.id, r])
              );
              for (const agent of org.listAgents()) {
                if (!agent || !agent.id) continue;
                const role = agent.roleId ? roles.get(agent.roleId) : null;
                const roleName = role?.name ?? agent.roleId ?? '';
                const orgCtx = resolveOrgContext(org, String(agent.id));
                agents.push({
                  id: String(agent.id),
                  // 显示名：自定义名优先，其次岗位名
                  name: String(agent.name || roleName || agent.id),
                  customName: agent.name ?? null,
                  roleName: String(roleName),
                  orgName: orgCtx.orgName,
                  orgManagerName: orgCtx.orgManagerName,
                });
              }
            }
            return { ok: true, agents };
          } catch (err) {
            return { error: 'list_agents_failed', message: err.message };
          }
        }

        return { error: 'not_found', message: '未知的资源路径' };
      } catch (error) {
        log?.error('[Remote] HTTP API 处理失败', { pathParts, error: error.message });
        return { error: 'http_handler_failed', message: error.message };
      }
    };
  },

  /**
   * 初始化模块
   */
  async init(rt) {
    runtime = rt;
    const { configService } = rt;

    // 注册模块配置
    configService.registerModuleConfig('remote', {
      mappings: {}
    });
    moduleConfig = await configService.getModuleConfig('remote');
    log = runtime.loggerRoot.forModule('remote');

    log.info('[Remote] 模块初始化开始');

    // 初始化 RemoteManager（仅 SSH 通信：连接、一次性命令、sftp。
    // 远程进程的生命周期由 localcmd 统一管理，remote 只做桥接）
    remoteManager = new RemoteManager(log, runtime.dataDir);

    // 加载映射
    _loadMappings();

    // Hook toolExecutor
    _hookToolExecutor();

    log.info('[Remote] 模块初始化完成');
  },

  /**
   * 获取工具定义（remote 模块不需要注册新工具，它 hook 现有工具）
   */
  getToolDefinitions() {
    return [];
  },

  /**
   * 执行工具调用（remote 模块通过 hook 拦截，不需要此方法，但必须实现接口）
   */
  async executeToolCall(ctx, toolName, args) {
    return { error: 'not_implemented', message: 'Remote module uses hook interception, not direct tool calls' };
  },

  /**
   * 关闭模块
   */
  async shutdown() {
    log?.info('[Remote] 模块开始关闭');

    if (remoteManager) {
      await remoteManager.closeAll();
    }

    remoteManager = null;
    runtime = null;
    agentMappings.clear();

    log?.info('[Remote] 模块已关闭');
  },
};

// ========== Tool Executor Hook ==========

/**
 * Hook runtime.toolExecutor.executeToolCall
 * 拦截配置了 remote 的 Agent 的工具调用
 */
function _hookToolExecutor() {
  if (!runtime || !runtime._toolExecutor) {
    log?.warn('[Remote] 无法 hook toolExecutor，runtime._toolExecutor 不可用');
    return;
  }

  const toolExecutor = runtime._toolExecutor;
  _originalExecuteToolCall = toolExecutor.executeToolCall.bind(toolExecutor);

  toolExecutor.executeToolCall = async function (ctx, toolName, args) {
    const agentId = ctx?.agent?.id;

    // 检查该 Agent 是否配置了 remote（未配置时沿父链继承祖先绑定）
    const mapping = agentId ? _resolveAgentMapping(agentId) : null;

    if (mapping && INTERCEPTED_TOOLS.has(toolName)) {
      log?.info('[Remote] 拦截工具调用，桥接到远程', { agentId, toolName, sourceAgentId: mapping.sourceAgentId });
      return _handleRemoteToolCall(ctx, toolName, args, mapping.config, agentId);
    }

    // 非 remote Agent 或不需要拦截的工具，走原始逻辑
    return _originalExecuteToolCall(ctx, toolName, args);
  };

  log?.info('[Remote] 已 hook toolExecutor.executeToolCall');
}

/**
 * 处理远程工具调用
 */
async function _handleRemoteToolCall(ctx, toolName, args, remoteConfig, agentId) {
  const workspacePath = _getWorkspacePath(agentId);
  const mgr = remoteManager;

  try {
    switch (toolName) {
      case 'exec_command': {
        const cmd = args?.command;
        if (!cmd) return { error: 'missing_command' };
        const result = await mgr.execCommand(agentId, remoteConfig, cmd, { timeout: 60000 });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      }

      case 'file_read':
      case 'read_file': {
        const filePath = args?.path;
        if (!filePath) return { error: 'invalid_arguments', message: '缺少必需参数 path。请提供要读取的文件路径。' };

        // 如果路径在工作区内，使用本地读取
        if (workspacePath && _isInWorkspace(filePath, workspacePath)) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }

        return await mgr.readBytes(agentId, remoteConfig, filePath, {
          offset: args?.offset,
          length: args?.length,
        });
      }

      case 'file_read_lines': {
        const filePath = args?.path;
        if (!filePath) return { error: 'invalid_arguments', message: '缺少必需参数 path。请提供要读取的文件路径。' };

        if (workspacePath && _isInWorkspace(filePath, workspacePath)) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }

        return await mgr.readLines(agentId, remoteConfig, filePath, {
          start_line: args?.start_line,
          end_line: args?.end_line,
        });
      }

      case 'list_files':
      case 'list_directory': {
        const dirPath = args?.path || '.';
        if (workspacePath && _isInWorkspace(dirPath, workspacePath)) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }

        return await mgr.listFiles(agentId, remoteConfig, dirPath);
      }

      case 'file_info': {
        const filePath = args?.path;
        if (!filePath) return { error: 'invalid_arguments', message: '缺少必需参数 path。请提供文件路径。' };

        if (workspacePath && _isInWorkspace(filePath, workspacePath)) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }

        return await mgr.getFileInfo(agentId, remoteConfig, filePath);
      }

      case 'file_line_count': {
        const filePath = args?.path;
        if (!filePath) return { error: 'invalid_arguments', message: '缺少必需参数 path。请提供文件路径。' };

        if (workspacePath && _isInWorkspace(filePath, workspacePath)) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }

        return await mgr.getLineCount(agentId, remoteConfig, filePath);
      }

      case 'file_search': {
        const filePath = args?.path;
        const pattern = args?.pattern;
        if (!filePath) return { error: 'invalid_arguments', message: '缺少必需参数 path。请提供要搜索的文件路径。' };
        if (!pattern) return { error: 'invalid_arguments', message: '缺少必需参数 pattern。请提供搜索模式。' };

        if (workspacePath && _isInWorkspace(filePath, workspacePath)) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }

        return await mgr.searchInFile(agentId, remoteConfig, filePath, pattern, {
          is_regex: Boolean(args?.is_regex),
          max_results: args?.max_results ?? 100,
        });
      }

      case 'search_text': {
        const dirPath = args?.path || '.';
        const text = args?.text;
        if (!text) return { error: 'missing_text', message: '必须提供要搜索的文本' };

        if (workspacePath && _isInWorkspace(dirPath, workspacePath)) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }

        const result = await mgr.searchTextInDir(agentId, remoteConfig, dirPath, text, {
          caseSensitive: Boolean(args?.caseSensitive),
          maxResults: args?.maxResults ?? 1000,
        });
        if (!result.ok) return result;
        return {
          ok: true,
          results: result.results,
          count: result.results.length,
          path: dirPath,
          text,
        };
      }

      case 'edit_file': {
        const filePath = args?.path;
        if (!filePath) return { error: 'invalid_arguments', message: '缺少必需参数 path。请提供文件路径。' };

        if (workspacePath && _isInWorkspace(filePath, workspacePath)) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }

        const oldText = args?.old_string !== undefined ? args.old_string : args?.old_text;
        const newText = args?.new_string !== undefined ? args.new_string : args?.new_text;
        if (oldText === undefined || oldText === null) {
          return { error: 'invalid_arguments', message: '缺少必需参数 old_string。请提供要替换的原始文本。' };
        }
        if (newText === undefined || newText === null) {
          return { error: 'invalid_arguments', message: '缺少必需参数 new_string。请提供替换后的新文本。' };
        }
        return await mgr.editFile(agentId, remoteConfig, filePath, oldText, newText, {
          replace_all: Boolean(args?.replace_all),
        });
      }

      case 'replace_file':
      case 'write_file': {
        const filePath = args?.path;
        const content = args?.content;
        if (!filePath) return { error: 'invalid_arguments', message: '缺少必需参数 path。请提供要写入的文件路径。' };
        if (content === undefined || content === null) {
          return { error: 'invalid_arguments', message: '缺少必需参数 content。请提供要写入的文件内容。' };
        }

        if (workspacePath && _isInWorkspace(filePath, workspacePath)) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }

        return await mgr.writeFile(agentId, remoteConfig, filePath, content, args?.mimeType);
      }

      case 'append_file': {
        const filePath = args?.path;
        const content = args?.content;
        if (!filePath) return { error: 'invalid_arguments', message: '缺少必需参数 path。请提供要追加内容的文件路径。' };
        if (content === undefined || content === null) {
          return { error: 'invalid_arguments', message: '缺少必需参数 content。请提供要追加的文件内容。' };
        }

        if (workspacePath && _isInWorkspace(filePath, workspacePath)) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }

        return await mgr.appendFile(agentId, remoteConfig, filePath, content, args?.mimeType);
      }

      case 'delete_file': {
        const filePath = args?.path;
        if (!filePath) return { error: 'invalid_arguments', message: '缺少必需参数 path。请提供要删除的文件路径。' };

        if (workspacePath && _isInWorkspace(filePath, workspacePath)) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }

        return await mgr.deleteFile(agentId, remoteConfig, filePath);
      }

      case 'move_file': {
        const sourcePath = args?.sourcePath || args?.source || args?.path;
        const destPath = args?.destPath || args?.destination || args?.dest;
        if (!sourcePath) return { error: 'invalid_arguments', message: '缺少必需参数 sourcePath。请提供源文件路径。' };
        if (!destPath) return { error: 'invalid_arguments', message: '缺少必需参数 destPath。请提供目标文件路径。' };

        const srcInWs = workspacePath && _isInWorkspace(sourcePath, workspacePath);
        const dstInWs = workspacePath && _isInWorkspace(destPath, workspacePath);

        // 两侧都在工作区：本地执行
        if (srcInWs && dstInWs) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }

        // 跨侧（工作区 <-> 远程）：工作区侧走工作区接口，远程侧走 sftp 中转
        if (srcInWs !== dstInWs) {
          const copy = await _copyAcrossBoundary(ctx, mgr, agentId, remoteConfig, sourcePath, destPath, srcInWs, workspacePath, _getWorkspaceFileAccess(), {
            overwrite: Boolean(args?.overwrite),
          });
          if (!copy.ok) return copy;

          // 删除源（走对应侧接口）
          if (srcInWs) {
            // 源在本地工作区：删除本地源
            const del = await _originalExecuteToolCall(ctx, 'delete_file', { path: sourcePath });
            if (del && del.ok === false) return { ok: false, error: 'move_failed', message: '复制成功但删除本地源失败' };
          } else {
            // 源在远程：删除远程源
            const del = await mgr.deleteFile(agentId, remoteConfig, sourcePath);
            if (del && del.ok === false) return { ok: false, error: 'move_failed', message: '复制成功但删除远程源失败' };
          }
          return { ok: true, from: sourcePath, to: destPath };
        }

        // 两侧都在远程
        return await mgr.moveFile(agentId, remoteConfig, sourcePath, destPath, {
          overwrite: Boolean(args?.overwrite),
        });
      }

      case 'copy_file': {
        const sourcePath = args?.sourcePath || args?.source || args?.path;
        const destPath = args?.destPath || args?.destination || args?.dest;
        if (!sourcePath) return { error: 'invalid_arguments', message: '缺少必需参数 sourcePath。请提供源文件路径。' };
        if (!destPath) return { error: 'invalid_arguments', message: '缺少必需参数 destPath。请提供目标文件路径。' };

        const srcInWs = workspacePath && _isInWorkspace(sourcePath, workspacePath);
        const dstInWs = workspacePath && _isInWorkspace(destPath, workspacePath);

        // 两侧都在工作区：本地执行
        if (srcInWs && dstInWs) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }

        // 跨侧（工作区 <-> 远程）：工作区侧走工作区接口，远程侧走 sftp 中转
        if (srcInWs !== dstInWs) {
          return await _copyAcrossBoundary(ctx, mgr, agentId, remoteConfig, sourcePath, destPath, srcInWs, workspacePath, _getWorkspaceFileAccess(), {
            overwrite: Boolean(args?.overwrite),
          });
        }

        // 两侧都在远程
        return await mgr.copyFile(agentId, remoteConfig, sourcePath, destPath, {
          overwrite: Boolean(args?.overwrite),
        });
      }

      case 'file_create_directory': {
        const dirPath = args?.path;
        if (!dirPath) return { error: 'invalid_arguments', message: '缺少必需参数 path。请提供要创建的目录路径。' };

        if (workspacePath && _isInWorkspace(dirPath, workspacePath)) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }

        return await mgr.createDirectory(agentId, remoteConfig, dirPath, {
          recursive: args?.recursive !== false,
        });
      }

      case 'file_stats': {
        const filePath = args?.path;
        if (!filePath) return { error: 'invalid_arguments', message: '缺少必需参数 path。请提供文件路径。' };
        if (!Array.isArray(args?.rules) || args.rules.length === 0) {
          return { error: 'invalid_arguments', message: '缺少必需参数 rules。请提供至少一个统计规则。' };
        }

        if (workspacePath && _isInWorkspace(filePath, workspacePath)) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }

        return await mgr.statsFile(agentId, remoteConfig, filePath, args.rules, {
          line_range: args?.line_range,
        });
      }

      case 'file_json_tree': {
        const filePath = args?.path;
        if (!filePath) return { error: 'invalid_arguments', message: '缺少必需参数 path。请提供 JSON 文件路径。' };

        if (workspacePath && _isInWorkspace(filePath, workspacePath)) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }

        return await mgr.jsonTree(agentId, remoteConfig, filePath, args?.path_expr, args?.max_depth);
      }

      case 'file_json_keys': {
        const filePath = args?.path;
        if (!filePath) return { error: 'invalid_arguments', message: '缺少必需参数 path。请提供 JSON 文件路径。' };

        if (workspacePath && _isInWorkspace(filePath, workspacePath)) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }

        return await mgr.jsonKeys(agentId, remoteConfig, filePath, args?.path_expr);
      }

      case 'file_jsonl_filter': {
        const filePath = args?.path;
        if (!filePath) return { error: 'invalid_arguments', message: '缺少必需参数 path。请提供 JSONL 文件路径。' };
        if (!args?.field) return { error: 'invalid_arguments', message: '缺少必需参数 field。请提供要过滤的字段名。' };
        if (!args?.pattern) return { error: 'invalid_arguments', message: '缺少必需参数 pattern。请提供过滤模式。' };

        if (workspacePath && _isInWorkspace(filePath, workspacePath)) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }

        return await mgr.jsonlFilter(agentId, remoteConfig, filePath, args.field, args.pattern, {
          is_regex: Boolean(args?.is_regex),
          max_results: args?.max_results,
          max_chars_per_record: args?.max_chars_per_record,
        });
      }

      case 'file_check_permission': {
        const filePath = args?.path;
        if (!filePath) return { error: 'invalid_arguments', message: '缺少必需参数 path。请提供要检查的文件路径。' };

        if (workspacePath && _isInWorkspace(filePath, workspacePath)) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }

        return await mgr.checkPermission(agentId, remoteConfig, filePath);
      }

      case 'file_list_authorized_folders': {
        // 远程模式下工作区外路径全部通过 SSH 访问，无额外授权文件夹概念
        if (workspacePath) {
          return _originalExecuteToolCall(ctx, toolName, args);
        }
        return { ok: true, folders: [] };
      }

      // ========== localcmd 系列：localcmd_spawn 桥接（进程生命周期由 localcmd 统一管理） ==========
      case 'localcmd_spawn': {
        const command = args?.command;
        if (!command) return { ok: false, error: 'missing_command' };

        // remote 只负责通信：打开 SSH channel 并包装成"进程样对象"，
        // 交给 localcmd 的 ProcessManager 管理（日志、解码、live 状态、历史、终止）。
        // 其余 localcmd 工具不再被拦截，随进程进入 localcmd 后走原有本地代码路径。
        const localcmdModule = runtime.moduleLoader?.getModule?.('localcmd');
        if (!localcmdModule || typeof localcmdModule.spawnExternalProcess !== 'function') {
          return { ok: false, error: 'localcmd_unavailable', message: 'localcmd 模块未加载，无法管理远程进程' };
        }

        const shellCmd = mgr.buildRemoteShellCommand(
          command,
          args?.args || [],
          args?.cwd,
          args?.env
        );
        let client;
        try {
          client = await mgr.getConnection(agentId, remoteConfig);
        } catch (err) {
          return { ok: false, error: 'ssh_connection_failed', message: err.message };
        }

        const adapter = await _execRemoteChannel(client, shellCmd);
        if (!adapter.ok) {
          return { ok: false, error: adapter.error, message: adapter.message };
        }

        return await localcmdModule.spawnExternalProcess(command, args?.args || [], {
          agentId,
          pushEvents: args?.pushEvents !== false,
          childProcess: adapter.processLike
        });
      }

      default:
        return _originalExecuteToolCall(ctx, toolName, args);
    }
  } catch (err) {
    log?.error('[Remote] 远程工具调用失败', {
      toolName,
      agentId,
      error: err.message,
      stack: err.stack,
    });
    return { error: 'remote_tool_error', toolName, message: err.message };
  }
}

/**
 * 打开 SSH exec channel 并包装成 localcmd 认识的"进程样对象"。
 *
 * 契约（与 localcmd ProcessManager.spawnExternalProcess 的 childProcess 参数一致）：
 * - stdout / stderr：发出 'data'（Buffer）的 EventEmitter
 * - stdin：{ write(data), destroyed }
 * - kill(signal)：终止（幂等，关闭后调用不抛错）
 * - on('close',(code,signal)) / on('error',(err)) / once('spawn',cb) 事件
 * - pid：null（远程拿不到真实 pid）
 *
 * @param {import('ssh2').Client} client
 * @param {string} shellCmd
 * @returns {Promise<{ok: boolean, processLike?: object, error?: string, message?: string}>}
 * @private
 */
function _execRemoteChannel(client, shellCmd) {
  return new Promise((resolve) => {
    client.exec(shellCmd, (err, stream) => {
      if (err) {
        log?.error('[Remote] 远程进程 exec 失败', { shellCmd, error: err.message });
        resolve({ ok: false, error: 'exec_failed', message: err.message });
        return;
      }

      let closed = false;
      stream.on('close', () => { closed = true; });

      const processLike = {
        pid: null,
        // ssh2 stream 本身就是 stdout（'data' 事件天然兼容）
        stdout: stream,
        stderr: stream.stderr,
        stdin: {
          write: (data) => {
            if (!closed) {
              stream.write(data);
              return true;
            }
            return false;
          },
          // getter 跟随 close 状态：channel 关闭后 localcmd 的 write 返回 stdin_closed
          get destroyed() { return closed; }
        },
        kill: (signal = 'SIGTERM') => {
          // 等价保留原 killRemoteProcess 语义：先发信号（部分服务端不支持则忽略），再关闭 channel
          try { stream.signal(signal); } catch (_) { /* ignore */ }
          try { stream.close(); } catch (_) { /* ignore */ }
        },
        on: (evt, cb) => stream.on(evt, cb),
        once: (evt, cb) => {
          // ssh2 无 'spawn' 事件：立即回调，保证 localcmd 的 started 推送时机与远程一致
          if (evt === 'spawn') {
            cb();
            return;
          }
          stream.once(evt, cb);
        },
      };
      resolve({ ok: true, processLike });
    });
  });
}