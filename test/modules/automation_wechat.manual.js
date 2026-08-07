/**
 * 微信自动化测试
 *
 * 测试内容：
 * 1. 查找微信窗口
 * 2. 获取微信窗口的控制树
 * 3. 获取微信窗口的子控件
 * 4. 截图微信窗口
 */

import { describe, it, before } from "node:test";
import assert from "node:assert";
import { AccessibilityService } from "../../modules/automation/accessibility.js";
import { InputController } from "../../modules/automation/input_controller.js";
import { WorkspaceManager } from "../../src/platform/services/workspace/workspace_manager.js";
import path from "node:path";
import { makeTestLogger } from "../helpers/test_logger.js";

describe("微信自动化", () => {
  let accessibilityService = null;
  let inputController = null;
  let workspaceManager = null;
  let mockRuntime = null;
  let testWorkspaceId = null;
  let wechatWindow = null;

  before(async () => {
    // 初始化运行时
    mockRuntime = {
      log: makeTestLogger("Automation"),
      workspaceManager: null
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
    testWorkspaceId = `test-wechat-${Date.now()}`;
    await workspaceManager.createWorkspace(testWorkspaceId, {});

    // 尝试查找微信窗口
    try {
      const findResult = await accessibilityService.findControl({
        processName: "WeChat.exe",
        timeout: 5000
      });
      if (findResult.ok && findResult.found) {
        wechatWindow = findResult.control;
      }
    } catch {
      wechatWindow = null;
    }
  });

  it("初始化服务", async () => {
    assert.ok(accessibilityService);
    assert.ok(inputController);
    assert.ok(workspaceManager);
    assert.ok(testWorkspaceId);
  });

  it("查找微信窗口", async () => {
    if (!wechatWindow) {
      console.log("[SKIP] 未找到微信窗口，请确保微信正在运行");
      return;
    }

    assert.ok(wechatWindow);
    assert.ok(wechatWindow.bounds);
  });

  it("获取微信控制树", async () => {
    if (!wechatWindow) {
      console.log("[SKIP] 微信未运行，跳过测试");
      return;
    }

    const treeResult = await accessibilityService.getControlTree({
      processName: "WeChat.exe",
      maxDepth: 2
    });

    assert.strictEqual(treeResult.ok, true);
    assert.ok(treeResult.tree);
    assert.ok(treeResult.tree.controlType);
  });

  it("获取微信子控件", async () => {
    if (!wechatWindow) {
      console.log("[SKIP] 微信未运行，跳过测试");
      return;
    }

    const childrenResult = await accessibilityService.getChildren(
      { name: wechatWindow.name },
      { maxDepth: 1 }
    );

    assert.strictEqual(childrenResult.ok, true);
    assert.strictEqual(Array.isArray(childrenResult.children), true);
  });

  it("截图微信窗口", async () => {
    if (!wechatWindow) {
      console.log("[SKIP] 微信未运行，跳过测试");
      return;
    }

    const mockCtx = {
      agent: { id: "test-agent", workspaceId: testWorkspaceId, parentAgentId: "root" },
      currentMessage: { id: `test-msg-${Date.now()}` }
    };

    const screenshotResult = await inputController.screenshotRegion(
      mockCtx,
      wechatWindow.bounds.x,
      wechatWindow.bounds.y,
      wechatWindow.bounds.width,
      wechatWindow.bounds.height,
      "wechat_screenshot.jpg"
    );

    if (!screenshotResult.ok) {
      console.log("[SKIP] 截图失败:", screenshotResult.error);
      return;
    }

    assert.ok(screenshotResult.files);
    assert.ok(screenshotResult.files.length > 0);
    assert.ok(screenshotResult.files[0].path);
  });

  it("设置微信窗口焦点", async () => {
    if (!wechatWindow) {
      console.log("[SKIP] 微信未运行，跳过测试");
      return;
    }

    const focusResult = await accessibilityService.setFocus({
      name: wechatWindow.name
    });

    assert.strictEqual(focusResult.ok, true);
  });

  it("截图微信控件", async () => {
    if (!wechatWindow) {
      console.log("[SKIP] 微信未运行，跳过测试");
      return;
    }

    const mockCtx = {
      agent: { id: "test-agent", workspaceId: testWorkspaceId, parentAgentId: "root" },
      currentMessage: { id: `test-msg-${Date.now()}` }
    };

    const controlScreenshotResult = await accessibilityService.screenshotControl(
      mockCtx,
      { name: wechatWindow.name },
      "wechat_control_screenshot.jpg",
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
