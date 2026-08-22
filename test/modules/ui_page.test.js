import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";
import { makeTestLogger } from "../helpers/test_logger.js";
import { assertCalledWith } from "../helpers/test_runner.js";
import { makeFakeConfigService } from "../helpers/fake_config_service.js";

// @ts-ignore - 测试中使用简化类型
import uiPageModule from "../../modules/ui_page/index.js";
import { _setBroker } from "../../modules/ui_page/broker.js";

describe("ui_page 模块工具", () => {
  let broker;
  let runtime;

  beforeEach(async () => {
    broker = {
      enqueueToActive: mock.fn(() => ({ ok: true, commandId: "cmd-1" })),
      waitForResult: mock.fn(async () => ({ ok: true, result: 123 }))
    };
    _setBroker(broker);
    runtime = {
      loggerRoot: { forModule: (name) => makeTestLogger("UIPage|" + name) },
      findWorkspaceIdForAgent: mock.fn(() => null),
      configService: makeFakeConfigService(),
    };
    await uiPageModule.init(runtime);
  });

  it("ui_page_eval_js: 应投递 eval_js 并等待结果", async () => {
    const r = await uiPageModule.executeToolCall({}, "ui_page_eval_js", { script: "return 1;", timeoutMs: 111 });
    // @ts-ignore - mock 方法验证
    assertCalledWith(broker.enqueueToActive, { type: "eval_js", payload: { script: "return 1;", _ws: null } });
    // @ts-ignore - mock 方法验证
    assertCalledWith(broker.waitForResult, "cmd-1", 111);
    assert.deepStrictEqual(r, { ok: true, result: 123 });
  });

  it("ui_page_get_content: 应投递 get_content", async () => {
    await uiPageModule.executeToolCall({}, "ui_page_get_content", { format: "text", selector: "#x", maxChars: 10, timeoutMs: 1000 });
    // @ts-ignore - mock 方法验证
    assertCalledWith(broker.enqueueToActive, {
      type: "get_content",
      payload: { selector: "#x", format: "text", maxChars: 10 }
    });
  });

  it("ui_page_dom_patch: 应投递 dom_patch", async () => {
    await uiPageModule.executeToolCall({}, "ui_page_dom_patch", { operations: [{ op: "setText", selector: "body", value: "x" }], timeoutMs: 1000 });
    // @ts-ignore - mock 方法验证
    assertCalledWith(broker.enqueueToActive, {
      type: "dom_patch",
      payload: { operations: [{ op: "setText", selector: "body", value: "x" }] }
    });
  });

  it("未连接 UI 时应返回 ui_client_not_connected", async () => {
    // 覆盖 mock 返回错误结果
    broker.enqueueToActive = mock.fn(() => ({ ok: false, error: "ui_client_not_connected" }));
    const r = await uiPageModule.executeToolCall({}, "ui_page_eval_js", { script: "return 1;" });
    assert.deepStrictEqual(r, { ok: false, error: "ui_client_not_connected" });
  });

  it("等待超时应返回 ui_timeout", async () => {
    // 覆盖 mock 抛出异常
    broker.waitForResult = mock.fn(async () => {
      throw { code: "ui_timeout" };
    });
    const r = await uiPageModule.executeToolCall({}, "ui_page_eval_js", { script: "return 1;", timeoutMs: 10 });
    assert.deepStrictEqual(r, { error: "ui_timeout" });
  });
});
