/**
 * SSH模块入口
 * 
 * 职责：
 * - 模块初始化和配置
 * - 工具定义导出
 * - 工具调用路由分发
 * - 模块生命周期管理
 * - 子模块实例管理
 * 
 * 设计说明：
 * - 参考chrome模块的系统集成方式
 * - 使用函数式导出而非类实例
 * - 统一错误处理和日志记录
 * - 参数验证在路由层完成
 */

// 导入子模块
import ConnectionManager from './connection_manager.js';
import ShellManager from './shell_manager.js';
import FileTransfer from './file_transfer.js';
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getToolDefinitions } from './tools.js';
import { validateParams } from "../../src/platform/utils/validate_params.js";

/** @type {any} 运行时实例 */
let runtime = null;

/** @type {any} 日志对象 */
let log = null;

/** @type {object} 模块配置 */
let moduleConfig = {};

/** @type {any} 连接管理器实例 */
let connectionManager = null;

/** @type {any} Shell会话管理器实例 */
let shellManager = null;

/** @type {any} 文件传输管理器实例 */
let fileTransfer = null;

/**
 * 清理字符串参数，去除大模型可能添加的多余引号
 * 例如："shell_123\"" -> "shell_123" 或 "shell_123" -> "shell_123"
 * @param {string} value - 原始字符串值
 * @returns {string} 清理后的字符串
 */
function cleanStringParam(value) {
  if (typeof value !== 'string') {
    return value;
  }
  let cleaned = value;
  // 处理 \" 结尾的情况（转义的引号）
  if (cleaned.endsWith('\\"')) {
    cleaned = cleaned.slice(0, -2);
  } else if (cleaned.endsWith('"')) {
    // 处理单独的 " 结尾的情况
    cleaned = cleaned.slice(0, -1);
  }
  // 处理开头的引号
  if (cleaned.startsWith('"')) {
    cleaned = cleaned.slice(1);
  }
  return cleaned;
}

/**
 * SSH模块导出
 */
export default {
  name: 'ssh',
  
  // 工具组标识符
  toolGroupId: 'ssh',
  
  // 工具组描述
  toolGroupDescription: 'SSH远程操作工具，提供SSH连接、Shell会话和文件传输能力',

  getWebComponent() {
    return {
      moduleName: 'ssh',
      displayName: 'SSH 连接与传输管理',
      icon: '🖧',
      panelPath: 'modules/ssh/web/panel.html'
    };
  },

  getHttpHandler() {
    return async (req, res, pathParts, body) => {
      const [resource, id, action] = pathParts;

      try {
        if (!connectionManager || !fileTransfer) {
          return { error: 'module_not_initialized', message: 'SSH模块尚未初始化' };
        }

        if (resource === 'overview') {
          const url = new URL(req.url, 'http://localhost');
          const showCompleted = url.searchParams.get('showCompleted') !== '0';

          const hostsResult = connectionManager.listHosts();
          if (hostsResult?.error) return hostsResult;

          const connectionsResult = connectionManager.listConnections();
          if (connectionsResult?.error) return connectionsResult;

          const transfersResult = fileTransfer.listTransfers({
            includeCompleted: showCompleted,
            includeFailed: showCompleted,
            includeCancelled: showCompleted
          });
          if (transfersResult?.error) return transfersResult;

          const hosts = hostsResult.hosts ?? [];
          const connections = connectionsResult.connections ?? [];
          const transfers = transfersResult.transfers ?? [];
          const activeTransfersCount = transfers.filter(t => t.status === 'pending' || t.status === 'transferring').length;

          return {
            ok: true,
            stats: {
              hostsCount: hosts.length,
              connectionsCount: connections.length,
              transfersCount: transfers.length,
              activeTransfersCount
            },
            hosts,
            connections,
            transfers
          };
        }

        if (resource === 'connections') {
          if (!id) {
            return connectionManager.listConnections();
          }
          if (!action) {
            const connectionsResult = connectionManager.listConnections();
            if (connectionsResult?.error) return connectionsResult;
            const connections = connectionsResult.connections ?? [];
            const found = connections.find(c => String(c.connectionId) === String(id));
            if (!found) {
              return { error: 'connection_not_found', message: `连接不存在：${id}` };
            }
            return { ok: true, connection: found };
          }
          if (action === 'disconnect') {
            return await connectionManager.disconnect(id);
          }
        }

        if (resource === 'transfers') {
          if (!id) {
            const url = new URL(req.url, 'http://localhost');
            const showCompleted = url.searchParams.get('showCompleted') !== '0';
            return fileTransfer.listTransfers({
              includeCompleted: showCompleted,
              includeFailed: showCompleted,
              includeCancelled: showCompleted
            });
          }
          if (!action) {
            return fileTransfer.getTransferStatus(id);
          }
          if (action === 'cancel') {
            return await fileTransfer.cancelTransfer(id);
          }
        }

        if (resource === 'hosts') {
          return connectionManager.listHosts();
        }

        return { error: 'not_found', message: '未知的资源路径' };
      } catch (error) {
        log.error('[SSH] HTTP API 处理失败', {
          pathParts,
          error: error.message,
          stack: error.stack
        });
        return { error: 'http_handler_failed', message: error.message };
      }
    };
  },

  /**
   * 初始化模块
   * @param {any} rt - 运行时实例
   * @returns {Promise<void>}
   */
  async init(rt) {
    runtime = rt;
    const { configService } = rt;

    // 向 configService 注册默认值，然后获取与 config/modules/ssh.json 合并后的配置
    configService.registerModuleConfig('ssh', {
      maxConnections: 10,
      connectionTimeout: 30000,
      commandTimeout: 30000,
      idleTimeout: 300000,
      maxOutputSize: 10485760,
      verifyHostKey: false,
      keepaliveInterval: 10000,
      hosts: {}
    });
    moduleConfig = await configService.getModuleConfig('ssh');
    log = runtime.loggerRoot.forModule("ssh");
    
    log.info('[SSH] 模块初始化开始', { config: moduleConfig });

    // 初始化连接管理器
    connectionManager = new ConnectionManager(moduleConfig, log);
    
    // 初始化Shell会话管理器
    shellManager = new ShellManager(connectionManager, runtime, log);
    
    // 初始化文件传输管理器
    fileTransfer = new FileTransfer(connectionManager, runtime, log);

    log.info('[SSH] 模块初始化完成');
  },

  /**
   * 获取工具定义列表
   * @returns {Array<{type: string, function: object}>}
   */
  getToolDefinitions() {
    return getToolDefinitions();
  },

  /**
   * 执行工具调用
   * @param {any} ctx - 调用上下文
   * @param {string} toolName - 工具名称
   * @param {any} args - 工具参数
   * @returns {Promise<any>}
   */
  async executeToolCall(ctx, toolName, args) {
    try {
      log.debug('[SSH] 执行工具调用', { toolName, args });

      // 参数验证和路由到具体的工具实现
      switch (toolName) {
        // 主机管理
        case 'ssh_list_hosts': {
          // 无需参数验证
          return connectionManager.listHosts();
        }

        // 交互式会话
        case 'ssh_shell_create': {
          const validationError = validateParams(args, ['hostName']);
          if (validationError) return validationError;
          return await shellManager.createShellByHost(args.hostName, ctx?.agent?.id);
        }
        
        case 'ssh_shell_send': {
          const validationError = validateParams(args, ['shellId', 'command']);
          if (validationError) return validationError;
          const shellId = cleanStringParam(args.shellId);
          return await shellManager.sendCommand(shellId, args.command);
        }
        
        case 'ssh_shell_read': {
          const validationError = validateParams(args, ['shellId', 'offset']);
          if (validationError) return validationError;
          const shellId = cleanStringParam(args.shellId);
          return await shellManager.readOutput(shellId, args.offset);
        }
        
        case 'ssh_shell_close': {
          const validationError = validateParams(args, ['shellId']);
          if (validationError) return validationError;
          const shellId = cleanStringParam(args.shellId);
          return await shellManager.closeShell(shellId);
        }

        case 'ssh_shell_list': {
          // 无需参数验证，但需要传递agentId进行过滤
          return shellManager.listShells(ctx?.agent?.id);
        }

        // 文件传输
        case 'ssh_upload': {
          const validationError = validateParams(args, ['hostName', 'path', 'remotePath']);
          if (validationError) return validationError;
          log.info('[SSH] 执行上传工具', { 
            hostName: args.hostName, 
            path: args.path, 
            remotePath: args.remotePath,
            agentId: ctx?.agent?.id 
          });
          const result = await fileTransfer.uploadByHost(args.hostName, args.path, args.remotePath, ctx);
          log.info('[SSH] 上传工具执行完成', { 
            hostName: args.hostName,
            hasTaskId: !!result?.taskId,
            hasError: !!result?.error,
            error: result?.error 
          });
          return result;
        }
        
        case 'ssh_download': {
          const validationError = validateParams(args, ['hostName', 'remotePath', 'path']);
          if (validationError) return validationError;
          return await fileTransfer.downloadByHost(args.hostName, args.remotePath, args.path, ctx);
        }
        
        case 'ssh_transfer_status': {
          const validationError = validateParams(args, ['taskId']);
          if (validationError) return validationError;
          const taskId = cleanStringParam(args.taskId);
          return fileTransfer.getTransferStatus(taskId);
        }
        
        case 'ssh_transfer_cancel': {
          const validationError = validateParams(args, ['taskId']);
          if (validationError) return validationError;
          const taskId = cleanStringParam(args.taskId);
          return await fileTransfer.cancelTransfer(taskId);
        }

        default:
          return {
            error: 'unknown_tool',
            message: `未知的工具: ${toolName}`
          };
      }
    } catch (error) {
      // 记录完整的错误堆栈供开发人员调试
      log.error('[SSH] 工具调用失败', {
        toolName,
        args,
        error: error.message,
        stack: error.stack
      });
      
      // 返回友好的错误信息给调用者
      return {
        error: 'execution_error',
        message: `工具执行失败: ${error.message}`
      };
    }
  },

  /**
   * 关闭模块并释放资源
   * @returns {Promise<void>}
   */
  async shutdown() {
    log.info('[SSH] 模块开始关闭');

    try {
      // 按照依赖关系的逆序清理资源
      // 先清理文件传输任务
      if (fileTransfer) {
        await fileTransfer.cleanup();
      }
      
      // 再清理Shell会话
      if (shellManager) {
        await shellManager.cleanup();
      }
      
      // 最后关闭所有连接
      if (connectionManager) {
        await connectionManager.closeAll();
      }
    } catch (error) {
      log.error('[SSH] 模块关闭时发生错误', {
        error: error.message,
        stack: error.stack
      });
    }

    // 清空模块实例引用
    connectionManager = null;
    shellManager = null;
    fileTransfer = null;
    runtime = null;
    
    log.info('[SSH] 模块已关闭');
  }
};
