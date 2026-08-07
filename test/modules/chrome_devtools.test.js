/**
 * Chrome DevTools 调试采集测试
 * 目标：验证 TabManager.enableDevtools / getDevtoolsContent 的行为与边界
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";
import { makeTestLogger } from "../helpers/test_logger.js";

// @ts-ignore - 测试中使用简化类型
import { TabManager } from "../../modules/chrome/tab_manager.js";

/**
 * 构造一个可记录 page.on 注册回调的 mock Page
 * @returns {{page: any, handlers: Map<string, Function>}}
 */
function createMockPage() {
  const handlers = new Map();
  const page = {
    setViewport: mock.fn(async () => {}),
    authenticate: mock.fn(async () => {}),
    goto: mock.fn(async () => {}),
    url: mock.fn(() => "about:blank"),
    title: mock.fn(async () => "Mock"),
    isClosed: mock.fn(() => false),
    close: mock.fn(async () => {}),
    on: mock.fn((event, handler) => {
      handlers.set(event, handler);
    })
  };
  return { page, handlers };
}

describe("Chrome DevTools 调试采集", () => {
  /** @type {TabManager} */
  let tabManager;
  /** @type {any} */
  let mockBrowserManager;
  /** @type {ReturnType<typeof createMockPage>} */
  let mockData;

  beforeEach(() => {
    mockData = createMockPage();
    const mockBrowser = {
      newPage: mock.fn(async () => mockData.page),
      pages: mock.fn(async () => [])
    };
    mockBrowserManager = {
      getPuppeteerBrowser: mock.fn(() => mockBrowser),
      getBrowser: mock.fn(() => ({ proxy: null })),
      getOrCreateBrowser: mock.fn(async () => ({ ok: true, browserId: "agent-1", isNew: true })),
      getTabCount: mock.fn(() => 0),
      updateTabCount: mock.fn()
    };
    tabManager = new TabManager({ log: makeTestLogger("ChromeDevTools"), browserManager: mockBrowserManager });
  });

  it("enableDevtools 应注册 console/pageerror/requestfailed 监听（且只注册一次）", async () => {
    const created = await tabManager.newTab("agent-1");
    // @ts-ignore - 联合类型属性访问
    assert.strictEqual(created.ok, true);
    // @ts-ignore - 联合类型属性访问
    const tabId = created.tabId;

    const first = await tabManager.enableDevtools(tabId, { maxEntries: 10 });
    // @ts-ignore - 联合类型属性访问
    assert.strictEqual(first.ok, true);
    // @ts-ignore - 使用 mock 验证
    assert.ok(mockData.page.on.mock.callCount() > 0);

    // 检查 console 事件已注册（查找所有调用中匹配的第一个参数）
    const allEventNames = mockData.page.on.mock.calls.map(c => c.arguments[0]);
    assert.ok(allEventNames.includes("console"), "console event should be registered");
    assert.ok(allEventNames.includes("pageerror"), "pageerror event should be registered");
    assert.ok(allEventNames.includes("requestfailed"), "requestfailed event should be registered");

    // 验证回调函数类型
    for (const call of mockData.page.on.mock.calls) {
      if (allEventNames.includes(call.arguments[0])) {
        assert.strictEqual(typeof call.arguments[1], "function");
      }
    }

    // @ts-ignore - mock 属性访问
    const onCallsAfterFirst = mockData.page.on.mock.callCount();
    const second = await tabManager.enableDevtools(tabId, { maxEntries: 10 });
    // @ts-ignore - 联合类型属性访问
    assert.strictEqual(second.ok, true);
    // @ts-ignore - mock 属性访问 - 第二次不应再注册
    assert.strictEqual(mockData.page.on.mock.callCount(), onCallsAfterFirst);
  });

  it("getDevtoolsContent 应按 maxEntries 做环形裁剪并累计 dropped", async () => {
    const created = await tabManager.newTab("agent-1");
    // @ts-ignore - 联合类型属性访问
    const tabId = created.tabId;

    await tabManager.enableDevtools(tabId, { maxEntries: 2, captureConsole: true });

    // @ts-ignore - mock handlers 访问
    const consoleHandler = mockData.handlers.get("console");
    assert.strictEqual(typeof consoleHandler, "function");

    const makeConsoleMsg = (text) => ({
      type: () => "log",
      text: () => text,
      args: () => [],
      location: () => ({ url: "https://example.com", lineNumber: 1, columnNumber: 1 })
    });

    consoleHandler(makeConsoleMsg("a"));
    consoleHandler(makeConsoleMsg("b"));
    consoleHandler(makeConsoleMsg("c"));

    const result = await tabManager.getDevtoolsContent(tabId, {});
    // @ts-ignore - 联合类型属性访问
    assert.strictEqual(result.ok, true);
    // @ts-ignore - 联合类型属性访问
    assert.strictEqual(result.total, 2);
    // @ts-ignore - 联合类型属性访问
    assert.strictEqual(result.dropped, 1);
    // @ts-ignore - 联合类型属性访问
    assert.deepStrictEqual(result.entries.map((e) => e.text), ["b", "c"]);
  });

  it("captureConsole=false 时不应写入 console 日志", async () => {
    const created = await tabManager.newTab("agent-1");
    // @ts-ignore - 联合类型属性访问
    const tabId = created.tabId;

    await tabManager.enableDevtools(tabId, { maxEntries: 10, captureConsole: false });

    // @ts-ignore - mock handlers 访问
    const consoleHandler = mockData.handlers.get("console");
    consoleHandler({
      type: () => "log",
      text: () => "should-not-record",
      args: () => [],
      location: () => ({ url: "https://example.com", lineNumber: 1, columnNumber: 1 })
    });

    const result = await tabManager.getDevtoolsContent(tabId, {});
    // @ts-ignore - 联合类型属性访问
    assert.strictEqual(result.ok, true);
    // @ts-ignore - 联合类型属性访问
    assert.strictEqual(result.total, 0);
  });

  it("clearAfterRead=true 应清空缓存并重置计数", async () => {
    const created = await tabManager.newTab("agent-1");
    // @ts-ignore - 联合类型属性访问
    const tabId = created.tabId;

    await tabManager.enableDevtools(tabId, { maxEntries: 10, captureConsole: true });
    // @ts-ignore - mock handlers 访问
    const consoleHandler = mockData.handlers.get("console");
    consoleHandler({
      type: () => "log",
      text: () => "x",
      args: () => [],
      location: () => ({ url: "https://example.com", lineNumber: 1, columnNumber: 1 })
    });

    const first = await tabManager.getDevtoolsContent(tabId, { clearAfterRead: true });
    // @ts-ignore - 联合类型属性访问
    assert.strictEqual(first.ok, true);
    // @ts-ignore - 联合类型属性访问
    assert.strictEqual(first.total, 1);
    // @ts-ignore - 联合类型属性访问
    assert.strictEqual(first.entries.length, 1);

    const second = await tabManager.getDevtoolsContent(tabId, {});
    // @ts-ignore - 联合类型属性访问
    assert.strictEqual(second.ok, true);
    // @ts-ignore - 联合类型属性访问
    assert.strictEqual(second.total, 0);
    // @ts-ignore - 联合类型属性访问
    assert.strictEqual(second.dropped, 0);
  });
});
