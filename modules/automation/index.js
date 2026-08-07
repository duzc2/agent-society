/**
 * Automation 模块入口
 * 
 * 职责：
 * - 模块初始化和配置
 * - 工具定义导出
 * - 工具调用路由分发
 * - 模块生命周期管理
 * - 权限控制和安全检查
 * 
 * 安全警告：
 * 此模块允许智能体控制鼠标键盘和访问屏幕控件，具有高风险性。
 * 请在受控环境中使用，并仔细配置权限。
 */

import { ConfigManager } from "./config_manager.js";
import { InputController } from "./input_controller.js";
import { AccessibilityService } from "./accessibility.js";
import { getToolDefinitions } from "./tools.js";
import { validateParams } from "../../src/platform/utils/validate_params.js";

/** @type {any} 运行时实例 */
let runtime = null;

/** @type {any} 日志对象 */
let log = null;

/** @type {ConfigManager} */
let configManager = null;

/** @type {InputController} */
let inputController = null;

/** @type {AccessibilityService} */
let accessibilityService = null;

/**
 * 检查坐标是否在受限区域内
 * @param {number} x
 * @param {number} y
 * @returns {{allowed: boolean, reason?: string}}
 */
function checkRestrictedRegion(x, y) {
  if (!configManager) return { allowed: true };
  return configManager.checkRestrictedRegion(x, y);
}

/**
 * Automation 模块导出
 */
export default {
  name: "automation",
  
  // 工具组标识符
  toolGroupId: "automation",
  
  // 工具组描述
  toolGroupDescription: "自动化控制工具 - 提供鼠标键盘控制和屏幕无障碍接口交互能力，用于GUI自动化操作",

  /**
   * 获取Web组件信息
   * @returns {object}
   */
  getWebComponent() {
    return {
      moduleName: "automation",
      displayName: "自动化控制",
      icon: "🤖",
      panelPath: "modules/automation/web/panel.html"
    };
  },

  /**
   * 获取HTTP处理器
   * @returns {Function}
   */
  getHttpHandler() {
    return async (req, res, pathParts, body) => {
      const [resource, action] = pathParts;

      try {
        if (!configManager) {
          return { error: "module_not_initialized", message: "Automation模块尚未初始化" };
        }

        // 获取配置
        if (resource === "config") {
          if (req.method === "GET") {
            return { ok: true, config: configManager.getConfig() };
          }
          if (req.method === "PUT") {
            return await configManager.updateConfig(body);
          }
        }

        // 获取屏幕信息
        if (resource === "screen") {
          if (req.method === "GET" && action === "info") {
            const size = await inputController.getScreenSize();
            const mousePos = await inputController.getMousePosition();
            return {
              ok: true,
              screen: size.ok ? { width: size.width, height: size.height } : null,
              mouse: mousePos.ok ? { x: mousePos.x, y: mousePos.y } : null
            };
          }
        }

        return { error: "not_found", message: "未知的资源路径" };
        
      } catch (error) {
        log.error("[Automation] HTTP API 处理失败", {
          pathParts,
          error: error.message
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
    log = runtime.loggerRoot.forModule("automation");
    
    log.info("[Automation] 模块初始化开始");

    // 检查平台
    if (process.platform !== "win32") {
      log.warn("[Automation] 当前平台不支持自动化功能，仅支持 Windows");
    }

    configManager = new ConfigManager({
      configService: runtime.configService,
      log
    });
    await configManager.init();

    // 初始化输入控制器
    inputController = new InputController({
      configManager,
      runtime,
      log
    });

    // 初始化无障碍服务
    accessibilityService = new AccessibilityService({
      configManager,
      runtime,
      log
    });

    log.info("[Automation] 模块初始化完成", {
      enabled: configManager.enabled,
      allowMouse: configManager.allowMouse,
      allowKeyboard: configManager.allowKeyboard,
      allowAccessibility: configManager.allowAccessibility
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
      log.debug("[Automation] 执行工具调用", { toolName, args });

      // 检查模块是否启用
      if (!configManager?.enabled) {
        return { ok: false, error: "module_disabled", message: "自动化模块已禁用" };
      }

      // 检查平台
      if (process.platform !== "win32") {
        return { ok: false, error: "unsupported_platform", message: "仅支持 Windows 平台" };
      }

      switch (toolName) {
        // ========== 鼠标控制 ==========
        case "automation_mouse_move": {
          const validationError = validateParams(args, ["x", "y"]);
          if (validationError) return validationError;
          
          if (!configManager.allowMouse) {
            return { ok: false, error: "mouse_disabled", message: "鼠标控制已禁用" };
          }
          
          const restriction = checkRestrictedRegion(args.x, args.y);
          if (restriction.restricted) {
            return { ok: false, error: "restricted_region", message: `坐标位于受限区域: ${restriction.reason}` };
          }
          
          return await inputController.mouseMove(args.x, args.y);
        }

        case "automation_mouse_click": {
          if (!configManager.allowMouse) {
            return { ok: false, error: "mouse_disabled", message: "鼠标控制已禁用" };
          }
          
          if (args.x !== undefined && args.y !== undefined) {
            const restriction = checkRestrictedRegion(args.x, args.y);
            if (restriction.restricted) {
              return { ok: false, error: "restricted_region", message: `坐标位于受限区域: ${restriction.reason}` };
            }
          }
          
          return await inputController.mouseClick({
            button: args.button,
            x: args.x,
            y: args.y
          });
        }

        case "automation_mouse_double_click": {
          if (!configManager.allowMouse) {
            return { ok: false, error: "mouse_disabled", message: "鼠标控制已禁用" };
          }
          
          if (args.x !== undefined && args.y !== undefined) {
            const restriction = checkRestrictedRegion(args.x, args.y);
            if (restriction.restricted) {
              return { ok: false, error: "restricted_region", message: `坐标位于受限区域: ${restriction.reason}` };
            }
          }
          
          return await inputController.mouseDoubleClick({ x: args.x, y: args.y });
        }

        case "automation_mouse_drag": {
          const validationError = validateParams(args, ["fromX", "fromY", "toX", "toY"]);
          if (validationError) return validationError;
          
          if (!configManager.allowMouse) {
            return { ok: false, error: "mouse_disabled", message: "鼠标控制已禁用" };
          }
          
          return await inputController.mouseDrag(args.fromX, args.fromY, args.toX, args.toY);
        }

        case "automation_mouse_scroll": {
          const validationError = validateParams(args, ["delta"]);
          if (validationError) return validationError;
          
          if (!configManager.allowMouse) {
            return { ok: false, error: "mouse_disabled", message: "鼠标控制已禁用" };
          }
          
          return await inputController.mouseScroll(args.delta);
        }

        case "automation_mouse_get_position": {
          if (!configManager.allowMouse) {
            return { ok: false, error: "mouse_disabled", message: "鼠标控制已禁用" };
          }
          
          return await inputController.getMousePosition();
        }

        // ========== 键盘控制 ==========
        case "automation_key_press": {
          const validationError = validateParams(args, ["key"]);
          if (validationError) return validationError;
          
          if (!configManager.allowKeyboard) {
            return { ok: false, error: "keyboard_disabled", message: "键盘控制已禁用" };
          }
          
          return await inputController.keyPress(args.key);
        }

        case "automation_key_combination": {
          const validationError = validateParams(args, ["keys"]);
          if (validationError) return validationError;
          
          if (!configManager.allowKeyboard) {
            return { ok: false, error: "keyboard_disabled", message: "键盘控制已禁用" };
          }
          
          return await inputController.keyCombination(args.keys);
        }

        case "automation_type_text": {
          const validationError = validateParams(args, ["text"]);
          if (validationError) return validationError;
          
          if (!configManager.allowKeyboard) {
            return { ok: false, error: "keyboard_disabled", message: "键盘控制已禁用" };
          }
          
          return await inputController.typeText(args.text);
        }

        // ========== 屏幕操作 ==========
        case "automation_screen_get_size": {
          return await inputController.getScreenSize();
        }

        case "automation_screen_get_info": {
          const size = await inputController.getScreenSize();
          const mouse = await inputController.getMousePosition();
          return {
            ok: true,
            screen: size.ok ? { width: size.width, height: size.height } : null,
            mouse: mouse.ok ? { x: mouse.x, y: mouse.y } : null,
            platform: process.platform
          };
        }

        // ========== 无障碍接口 ==========
        case "automation_find_control": {
          if (!configManager.allowAccessibility) {
            return { ok: false, error: "accessibility_disabled", message: "无障碍接口已禁用" };
          }
          
          return await accessibilityService.findControl({
            controlType: args.controlType,
            name: args.name,
            automationId: args.automationId,
            className: args.className,
            processName: args.processName,
            timeout: args.timeout
          });
        }

        case "automation_get_control_tree": {
          if (!configManager.allowAccessibility) {
            return { ok: false, error: "accessibility_disabled", message: "无障碍接口已禁用" };
          }
          
          return await accessibilityService.getControlTree({
            maxDepth: args.maxDepth,
            processName: args.processName
          });
        }

        case "automation_control_get_children": {
          if (!configManager.allowAccessibility) {
            return { ok: false, error: "accessibility_disabled", message: "无障碍接口已禁用" };
          }
          
          return await accessibilityService.getChildren(
            { automationId: args.automationId, name: args.name },
            { maxDepth: args.maxDepth }
          );
        }

        case "automation_control_click": {
          if (!configManager.allowAccessibility) {
            return { ok: false, error: "accessibility_disabled", message: "无障碍接口已禁用" };
          }
          
          if (!configManager.allowMouse) {
            return { ok: false, error: "mouse_disabled", message: "鼠标控制已禁用" };
          }
          
          return await accessibilityService.clickControl({
            automationId: args.automationId,
            name: args.name
          });
        }

        case "automation_control_set_focus": {
          if (!configManager.allowAccessibility) {
            return { ok: false, error: "accessibility_disabled", message: "无障碍接口已禁用" };
          }
          
          return await accessibilityService.setFocus({
            automationId: args.automationId,
            name: args.name
          });
        }

        case "automation_control_send_text": {
          const validationError = validateParams(args, ["text"]);
          if (validationError) return validationError;
          
          if (!configManager.allowAccessibility) {
            return { ok: false, error: "accessibility_disabled", message: "无障碍接口已禁用" };
          }
          
          if (!configManager.allowKeyboard) {
            return { ok: false, error: "keyboard_disabled", message: "键盘控制已禁用" };
          }
          
          return await accessibilityService.sendTextToControl(
            { automationId: args.automationId, name: args.name },
            args.text
          );
        }

        // ========== 截图 ==========
        case "automation_screenshot_region": {
          const validationError = validateParams(args, ["x", "y", "width", "height", "destPath"]);
          if (validationError) return validationError;
          
          // 截图不检查 mouse 权限，因为这是一个观察操作而非控制操作
          return await inputController.screenshotRegion(
            ctx,
            args.x,
            args.y,
            args.width,
            args.height,
            args.destPath
          );
        }

        case "automation_screenshot_control": {
          const validationError = validateParams(args, ["destPath"]);
          if (validationError) return validationError;
          
          if (!configManager.allowAccessibility) {
            return { ok: false, error: "accessibility_disabled", message: "无障碍接口已禁用" };
          }
          
          return await accessibilityService.screenshotControl(
            ctx,
            { automationId: args.automationId, name: args.name },
            args.destPath,
            { margin: args.margin }
          );
        }

        // ========== 等待 ==========
        case "automation_wait_for_control": {
          if (!configManager.allowAccessibility) {
            return { ok: false, error: "accessibility_disabled", message: "无障碍接口已禁用" };
          }
          
          return await accessibilityService.waitForControl({
            controlType: args.controlType,
            name: args.name,
            automationId: args.automationId
          }, args.timeout);
        }

        case "automation_wait": {
          const validationError = validateParams(args, ["milliseconds"]);
          if (validationError) return validationError;
          
          await new Promise(resolve => setTimeout(resolve, args.milliseconds));
          return { ok: true, milliseconds: args.milliseconds };
        }

        default:
          return {
            error: "unknown_tool",
            message: `未知的工具: ${toolName}`
          };
      }
    } catch (error) {
      log.error("[Automation] 工具调用失败", {
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
    log.info("[Automation] 模块开始关闭");

    // 清空模块实例引用
    configManager = null;
    inputController = null;
    accessibilityService = null;
    runtime = null;
    
    log.info("[Automation] 模块已关闭");
  }
};
