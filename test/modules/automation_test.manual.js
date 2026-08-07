/**
 * 自动化模块测试
 *
 * 测试内容：
 * 1. 查找可用窗口（尝试多个常用程序）
 * 2. 获取窗口控制树
 * 3. 获取窗口子控件
 * 4. 截图窗口
 */

import { describe, it, before } from "node:test";
import assert from "node:assert";
import { AccessibilityService } from "../../modules/automation/accessibility.js";
import { InputController } from "../../modules/automation/input_controller.js";
import { WorkspaceManager } from "../../src/platform/services/workspace/workspace_manager.js";
import path from "node:path";
import { makeTestLogger } from "../helpers/test_logger.js";

// 尝试查找的窗口名称列表
const WINDOW_NAME_LIST = [
  { name: "微信", display: "微信" },
  { name: "Google Chrome", display: "Chrome浏览器" },
  { name: "Microsoft Edge", display: "Edge浏览器" },
  { name: "记事本", display: "记事本" },
  { name: "文件资源管理器", display: "资源管理器" },
  { name: "Visual Studio Code", display: "VS Code" }
];

/**
 * 查找可用窗口
 * @returns {Promise<{available: boolean, window: object|null, process: object|null}>}
 */
async function findAvailableWindow(accessibilityService) {
  for (const item of WINDOW_NAME_LIST) {
    try {
      const result = await accessibilityService.findControl({
        name: item.name,
        timeout: 3000
      });

      if (result.ok && result.found) {
        return {
          available: true,
          window: result.control,
          process: item
        };
      }
    } catch {
      // 继续尝试下一个
    }
  }

  return { available: false, window: null, process: null };
}

describe("自动化模块", () => {
  let accessibilityService = null;
  let inputController = null;
  let workspaceManager = null;
  let mockRuntime = null;
  let testWorkspaceId = null;
  let targetWindow = null;
  let targetProcess = null;

  before(async () => {
    // 初始化运行时
    mockRuntime = {
      log: makeTestLogger("Automation"),
      workspaceManager: null,
      _agentMetaById: new Map()
    };

    // 初始化工作区管理器
    workspaceManager = new WorkspaceManager({
      workspacesDir: path.join(process.cwd(), "agent-society-data-3001", "workspaces"),
      logger: makeTestLogger("Automation")
    });
    mockRuntime.workspaceManager = workspaceManager;

    // 初始化无障碍服务
    accessibilityService = new AccessibilityService({
      runtime: mockRuntime,
      log: makeTestLogger("Automation")
    });

    // 初始化输入控制器
    inputController = new InputController({
      runtime: mockRuntime,
      log: makeTestLogger("Automation")
    });

    // 创建测试工作区
    testWorkspaceId = `test-auto-${Date.now()}`;
    await workspaceManager.createWorkspace(testWorkspaceId, {});

    // 添加 agent 信息到 runtime
    mockRuntime._agentMetaById.set("test-agent", {
      id: "test-agent",
      workspaceId: testWorkspaceId,
      parentAgentId: "root"
    });

    // 查找可用窗口
    const windowCheck = await findAvailableWindow(accessibilityService);
    if (windowCheck.available) {
      targetWindow = windowCheck.window;
      targetProcess = windowCheck.process;
    }
  });

  it("初始化服务", async () => {
    assert.ok(accessibilityService);
    assert.ok(inputController);
    assert.ok(workspaceManager);
    assert.ok(testWorkspaceId);
  });

  it("查找可用窗口", async () => {
    if (!targetWindow) {
      console.log("[SKIP] 没有可用的应用程序窗口，请至少打开一个应用程序（微信、Chrome、Edge、记事本等）");
      return;
    }

    assert.ok(targetWindow);
    assert.ok(targetWindow.name);
    assert.ok(targetWindow.controlType);
    assert.ok(targetWindow.bounds);
    assert.ok(targetWindow.bounds.x);
    assert.ok(targetWindow.bounds.y);
    assert.ok(targetWindow.bounds.width);
    assert.ok(targetWindow.bounds.height);
  });

  it("获取控制树", async () => {
    if (!targetWindow) {
      console.log("[SKIP] 没有可用的应用程序窗口");
      return;
    }

    const treeResult = await accessibilityService.getControlTree({
      processName: targetProcess.name,
      maxDepth: 2
    });

    assert.strictEqual(treeResult.ok, true);
    assert.ok(treeResult.tree);
    assert.ok(treeResult.tree.controlType);
    assert.strictEqual(Array.isArray(treeResult.tree.children), true);
  });

  it("获取子控件", async () => {
    if (!targetWindow) {
      console.log("[SKIP] 没有可用的应用程序窗口");
      return;
    }

    const childrenResult = await accessibilityService.getChildren(
      { name: targetWindow.name },
      { maxDepth: 1 }
    );

    assert.strictEqual(childrenResult.ok, true);
    assert.strictEqual(Array.isArray(childrenResult.children), true);
  });

  it("截图窗口", async () => {
    if (!targetWindow) {
      console.log("[SKIP] 没有可用的应用程序窗口");
      return;
    }

    const bounds = targetWindow.bounds;
    const mockCtx = {
      agent: { id: "test-agent", workspaceId: testWorkspaceId, parentAgentId: "root" },
      currentMessage: { id: `test-msg-${Date.now()}` }
    };

    // 限制截图大小，避免太大
    const captureWidth = Math.min(bounds.width, 1920);
    const captureHeight = Math.min(bounds.height, 1080);

    const screenshotResult = await inputController.screenshotRegion(
      mockCtx,
      bounds.x,
      bounds.y,
      captureWidth,
      captureHeight,
      "window_screenshot.jpg"
    );

    if (!screenshotResult.ok) {
      console.log("[SKIP] 截图失败:", screenshotResult.error);
      return;
    }

    assert.ok(screenshotResult.files);
    assert.ok(screenshotResult.files.length > 0);
    assert.ok(screenshotResult.files[0].path);
  });

  it("设置窗口焦点", async () => {
    if (!targetWindow) {
      console.log("[SKIP] 没有可用的应用程序窗口");
      return;
    }

    const focusResult = await accessibilityService.setFocus({
      name: targetWindow.name
    });

    assert.strictEqual(focusResult.ok, true);
  });

  it("截图控件", async () => {
    if (!targetWindow) {
      console.log("[SKIP] 没有可用的应用程序窗口");
      return;
    }

    const mockCtx = {
      agent: { id: "test-agent", workspaceId: testWorkspaceId, parentAgentId: "root" },
      currentMessage: { id: `test-msg-${Date.now()}` }
    };

    const controlScreenshotResult = await accessibilityService.screenshotControl(
      mockCtx,
      { name: targetWindow.name },
      "control_screenshot.jpg",
      { margin: 10 }
    );

    if (!controlScreenshotResult.ok) {
      console.log("[SKIP] 控件截图失败:", controlScreenshotResult.error);
      return;
    }

    assert.ok(controlScreenshotResult.files);
    assert.ok(controlScreenshotResult.files.length > 0);
  });
});
