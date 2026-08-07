/**
 * LocalFile 模块入口
 * 
 * 职责：
 * - 模块初始化和配置
 * - 工具定义导出
 * - 工具调用路由分发
 * - 模块生命周期管理
 * - 提供HTTP API和前端界面
 * 
 * 设计说明：
 * - 模块化设计，各组件职责清晰
 * - 完整的权限控制和审计日志
 * - Web界面用于配置管理
 */

import { ConfigManager } from "./config_manager.js";
import { PermissionManager } from "./permission_manager.js";
import { AccessLogger } from "./access_logger.js";
import { FileService } from "./file_service.js";
import { getToolDefinitions } from "./tools.js";
import path from "node:path";
import { validateParams } from "../../src/platform/utils/validate_params.js";

/** @type {any} 运行时实例 */
let runtime = null;

/** @type {any} 日志对象 */
let log = null;

/** @type {ConfigManager} */
let configManager = null;

/** @type {PermissionManager} */
let permissionManager = null;

/** @type {AccessLogger} */
let accessLogger = null;

/** @type {FileService} */
let fileService = null;

/**
 * LocalFile 模块导出
 */
export default {
  name: "localfile",
  
  // 工具组标识符
  toolGroupId: "localfile",
  
  // 工具组描述
  toolGroupDescription: "本地文件访问工具 - 提供受控的服务器本地文件系统访问能力，支持读写、目录浏览、工作区交互",

  /**
   * 获取Web组件信息
   * @returns {object}
   */
  getWebComponent() {
    return {
      moduleName: "localfile",
      displayName: "本地文件访问管理",
      icon: "📁",
      panelPath: "modules/localfile/web/panel.html"
    };
  },

  /**
   * 获取HTTP处理器
   * @returns {Function}
   */
  getHttpHandler() {
    return async (req, res, pathParts, body) => {
      const [resource, action, id] = pathParts;

      try {
        if (!configManager || !fileService) {
          return { error: "module_not_initialized", message: "LocalFile模块尚未初始化" };
        }

        // 文件夹管理
        if (resource === "folders") {
          // GET /folders - 获取所有文件夹
          if (req.method === "GET" && !action) {
            return { ok: true, folders: configManager.getFolders() };
          }
          
          // POST /folders - 添加文件夹
          if (req.method === "POST" && !action) {
            const validationError = validateParams(body, ["path"]);
            if (validationError) return validationError;
            return await configManager.addFolder(body);
          }
          
          // PUT /folders/:id - 更新文件夹
          if (req.method === "PUT" && action) {
            return await configManager.updateFolder(action, body);
          }
          
          // DELETE /folders/:id - 删除文件夹
          if (req.method === "DELETE" && action) {
            return await configManager.removeFolder(action);
          }
        }

        // 日志查询
        if (resource === "logs") {
          if (req.method === "GET" && !action) {
            const url = new URL(req.url, "http://localhost");
            const filters = {
              startTime: url.searchParams.get("startTime") || undefined,
              endTime: url.searchParams.get("endTime") || undefined,
              agentId: url.searchParams.get("agentId") || undefined,
              operation: url.searchParams.get("operation") || undefined,
              limit: parseInt(url.searchParams.get("limit") || "100", 10),
              offset: parseInt(url.searchParams.get("offset") || "0", 10)
            };
            return await accessLogger.queryLogs(filters);
          }
        }

        // 日志统计
        if (resource === "stats") {
          if (req.method === "GET" && !action) {
            const url = new URL(req.url, "http://localhost");
            const range = {
              startTime: url.searchParams.get("startTime") || undefined,
              endTime: url.searchParams.get("endTime") || undefined
            };
            return { ok: true, stats: await accessLogger.getStats(range) };
          }
        }

        // 设置
        if (resource === "settings") {
          if (req.method === "GET" && action === "retention") {
            return { ok: true, logRetentionDays: configManager.getLogRetentionDays() };
          }
          if (req.method === "PUT" && action === "retention") {
            return await configManager.setLogRetentionDays(body.days);
          }
        }

        // 获取所有组织列表（从 runtime 获取，用于 UI 选择器）
        if (resource === "orgs") {
          if (req.method === "GET" && !action) {
            try {
              if (!runtime || !runtime.org) {
                return { error: "org_runtime_unavailable", message: "组织运行时不可用" };
              }

              const allAgents = runtime.org.listAgents();
              if (!Array.isArray(allAgents)) {
                return { ok: true, orgs: [] };
              }

              const orgConfigMap = new Map();
              for (const c of configManager.getAllOrgConfigs()) {
                orgConfigMap.set(c.orgId, c);
              }

              const orgs = [];
              for (const a of allAgents) {
                if (!a) continue;
                if (a.parentAgentId !== "root" || a.status === "deleted") continue;
                const cfg = orgConfigMap.get(a.id);
                orgs.push({
                  orgId: a.id,
                  orgName: runtime.org.getOrgName(a.id) || a.name || a.id,
                  firstAgentName: a.name,
                  hasConfig: !!cfg,
                  folderCount: cfg ? (cfg.config.folders ? cfg.config.folders.length : 0) : 0
                });
              }

              return { ok: true, orgs };
            } catch (error) {
              log.error("[LocalFile] 获取组织列表失败", {
                error: error.message,
                stack: error.stack
              });
              return { error: "list_orgs_failed", message: error.message };
            }
          }
        }

        // 组织配置管理
        if (resource === "org-configs") {
          // GET /org-configs - 获取所有组织配置
          if (req.method === "GET" && !action) {
            return { ok: true, orgConfigs: configManager.getAllOrgConfigs() };
          }

          // DELETE /org-configs/:orgId - 移除组织配置（惰性清理）
          if (req.method === "DELETE" && action && !id) {
            return await configManager.removeOrgConfig(action);
          }

          // GET /org-configs/:orgId/folders - 获取组织有效文件夹
          if (req.method === "GET" && action && id === "folders") {
            return {
              ok: true,
              folders: configManager.getEffectiveFolders(action)
            };
          }

          // POST /org-configs/:orgId/folders - 为组织添加文件夹
          if (req.method === "POST" && action && id === "folders") {
            const validationError = validateParams(body, ["path"]);
            if (validationError) return validationError;
            return await configManager.addFolderToOrg(action, body);
          }

          // PUT /org-configs/:orgId/folders/:folderId - 更新组织文件夹
          if (req.method === "PUT" && action === "folders" && id) {
            return await configManager.updateFolderInOrg(
              pathParts[0] === "org-configs" ? resource : null,
              id,
              body
            );
          }

          // DELETE /org-configs/:orgId/folders/:folderId - 删除组织文件夹
          if (req.method === "DELETE" && action === "folders" && id) {
            return await configManager.removeFolderFromOrg(
              pathParts[0] === "org-configs" ? resource : null,
              id
            );
          }
        }

        // 组织文件夹管理（简化路由：org-configs/ORGID/folders/FOLDERID）
        if (resource === "org-configs") {
          const orgId = action;
          const subResource = id;
          const folderId = pathParts[3];

          if (subResource === "folders") {
            // PUT /org-configs/:orgId/folders/:folderId
            if (req.method === "PUT" && folderId) {
              return await configManager.updateFolderInOrg(orgId, folderId, body);
            }
            // DELETE /org-configs/:orgId/folders/:folderId
            if (req.method === "DELETE" && folderId) {
              return await configManager.removeFolderFromOrg(orgId, folderId);
            }
          }

          // 组织设置
          if (subResource === "settings") {
            const settingType = folderId; // pathParts[3]
            // GET /org-configs/:orgId/settings/retention
            if (req.method === "GET" && settingType === "retention") {
              return {
                ok: true,
                logRetentionDays: configManager.getEffectiveLogRetentionDays(orgId)
              };
            }
            // PUT /org-configs/:orgId/settings/retention
            if (req.method === "PUT" && settingType === "retention") {
              return await configManager.setLogRetentionDaysForOrg(orgId, body.days);
            }
          }
        }

        // 测试路径权限
        if (resource === "check-path") {
          if (req.method === "POST") {
            const validationError = validateParams(body, ["path"]);
            if (validationError) return validationError;

            const permission = await permissionManager.getPermissionInfo(body.path);
            const exists = await permissionManager.pathExists(body.path);
            const isDirectory = exists ? await permissionManager.isDirectory(body.path) : false;

            return {
              ok: true,
              path: body.path,
              exists,
              isDirectory,
              canRead: permission.canRead,
              canWrite: permission.canWrite,
              folder: permission.folder
            };
          }
        }

        return { error: "not_found", message: "未知的资源路径" };
        
      } catch (error) {
        log.error("[LocalFile] HTTP API 处理失败", {
          pathParts,
          error: error.message,
          stack: error.stack
        });
        return { error: "http_handler_failed", message: error.message };
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
    log = runtime.loggerRoot.forModule("localfile");
    
    log.info("[LocalFile] 模块初始化开始");

    configManager = new ConfigManager({
      configService: runtime.configService,
      log
    });
    await configManager.init();

    // 初始化权限管理器
    permissionManager = new PermissionManager({
      configManager,
      log
    });

    // 初始化访问日志记录器
    // 从 runtime.dataDir 获取数据目录（runtime 保证 dataDir 有值）
    const dataDir = runtime.dataDir;
    const logDir = path.join(dataDir, "localfile", "logs");
    accessLogger = new AccessLogger({
      logDir,
      configManager,
      runtime,
      log
    });
    await accessLogger.init();

    // 初始化文件服务
    fileService = new FileService({
      permissionManager,
      accessLogger,
      runtime,
      log
    });

    log.info("[LocalFile] 模块初始化完成", {
      folderCount: configManager.getFolders().length,
      logDir
    });
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
      log.debug("[LocalFile] 执行工具调用", { toolName, args });

      switch (toolName) {
        // 读取文件
        case "localfile_read": {
          const validationError = validateParams(args, ["path"]);
          if (validationError) return validationError;
          return await fileService.readFile(ctx, args.path, {
            encoding: args.encoding
          });
        }

        // 写入文件
        case "localfile_write": {
          const validationError = validateParams(args, ["path", "content"]);
          if (validationError) return validationError;
          return await fileService.writeFile(ctx, args.path, args.content, {
            encoding: args.encoding
          });
        }

        // 列出目录
        case "localfile_list": {
          const validationError = validateParams(args, ["path"]);
          if (validationError) return validationError;
          return await fileService.listDirectory(ctx, args.path);
        }

        // 创建目录
        case "localfile_create_dir": {
          const validationError = validateParams(args, ["path"]);
          if (validationError) return validationError;
          return await fileService.createDirectory(ctx, args.path, {
            recursive: args.recursive
          });
        }

        // 复制到工作区
        case "localfile_copy_to_workspace": {
          const validationError = validateParams(args, ["sourcePath", "destPath"]);
          if (validationError) return validationError;
          return await fileService.copyToWorkspace(ctx, args.sourcePath, args.destPath);
        }

        // 从工作区复制
        case "localfile_copy_from_workspace": {
          const validationError = validateParams(args, ["sourcePath", "destPath"]);
          if (validationError) return validationError;
          return await fileService.copyFromWorkspace(ctx, args.sourcePath, args.destPath);
        }

        // 检查权限
        case "localfile_check_permission": {
          const validationError = validateParams(args, ["path"]);
          if (validationError) return validationError;
          return await fileService.checkPermission(ctx, args.path);
        }

        // 列出授权文件夹
        case "localfile_list_authorized_folders": {
          return {
            ok: true,
            folders: fileService.getAuthorizedFolders(ctx)
          };
        }

        default:
          return {
            error: "unknown_tool",
            message: `未知的工具: ${toolName}`
          };
      }
    } catch (error) {
      log.error("[LocalFile] 工具调用失败", {
        toolName,
        args,
        error: error.message,
        stack: error.stack
      });
      
      return {
        error: "execution_error",
        message: `工具执行失败: ${error.message}`
      };
    }
  },

  /**
   * 关闭模块并释放资源
   * @returns {Promise<void>}
   */
  async shutdown() {
    log.info("[LocalFile] 模块开始关闭");

    try {
      // 清理资源
      if (accessLogger) {
        await accessLogger.cleanupOldLogs();
      }
    } catch (error) {
      log.error("[LocalFile] 模块关闭时发生错误", {
        error: error.message,
        stack: error.stack
      });
    }

    // 清空模块实例引用
    configManager = null;
    permissionManager = null;
    accessLogger = null;
    fileService = null;
    runtime = null;
    
    log.info("[LocalFile] 模块已关闭");
  }
};
