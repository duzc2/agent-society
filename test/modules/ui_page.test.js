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
    const r = await uiPageModule.executeToolCall({}, "ui_page_eval_js", { script: "return 1;", purpose: "测试目的", suggestedFilename: "测试脚本", timeoutMs: 111 });
    // @ts-ignore - mock 方法验证
    assertCalledWith(broker.enqueueToActive, {
      type: "eval_js",
      payload: { script: "return 1;", _ws: null, purpose: "测试目的", suggestedFilename: "测试脚本" }
    });
    // @ts-ignore - mock 方法验证
    assertCalledWith(broker.waitForResult, "cmd-1", 111);
    assert.deepStrictEqual(r, { ok: true, result: 123 });
  });

  it("ui_page_eval_js: 透传 purpose 与 suggestedFilename 给保存提示", async () => {
    await uiPageModule.executeToolCall({}, "ui_page_eval_js", {
      script: "return 1;",
      purpose: "在右下角创建股票价格小窗口",
      suggestedFilename: "股票小窗",
      timeoutMs: 1000
    });
    // @ts-ignore - mock 方法验证
    assertCalledWith(broker.enqueueToActive, {
      type: "eval_js",
      payload: {
        script: "return 1;",
        _ws: null,
        purpose: "在右下角创建股票价格小窗口",
        suggestedFilename: "股票小窗"
      }
    });
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
    const r = await uiPageModule.executeToolCall({}, "ui_page_eval_js", { script: "return 1;", purpose: "测试目的", suggestedFilename: "测试脚本" });
    assert.deepStrictEqual(r, { ok: false, error: "ui_client_not_connected" });
  });

  it("等待超时应返回 ui_timeout", async () => {
    // 覆盖 mock 抛出异常
    broker.waitForResult = mock.fn(async () => {
      throw { code: "ui_timeout" };
    });
    const r = await uiPageModule.executeToolCall({}, "ui_page_eval_js", { script: "return 1;", purpose: "测试目的", suggestedFilename: "测试脚本", timeoutMs: 10 });
    assert.deepStrictEqual(r, { error: "ui_timeout" });
  });

  it("ui_page_eval_js: 缺少 purpose 应返回 invalid_params 且不投递", async () => {
    const r = await uiPageModule.executeToolCall({}, "ui_page_eval_js", { script: "return 1;", suggestedFilename: "测试脚本" });
    assert.deepStrictEqual(r, { error: "invalid_params", message: "ui_page_eval_js 缺少必填参数 purpose（本次执行脚本的目的，面向用户展示的简短说明），请补充后再调用" });
    // @ts-ignore - mock 方法验证
    assert.strictEqual(broker.enqueueToActive.mock.callCount(), 0, "参数校验失败不应投递到 broker");
  });

  it("ui_page_eval_js: 缺少 suggestedFilename 应返回 invalid_params 且不投递", async () => {
    const r = await uiPageModule.executeToolCall({}, "ui_page_eval_js", { script: "return 1;", purpose: "测试目的" });
    assert.deepStrictEqual(r, { error: "invalid_params", message: "ui_page_eval_js 缺少必填参数 suggestedFilename（建议的保存文件名，不含 .js 后缀），请补充后再调用" });
    // @ts-ignore - mock 方法验证
    assert.strictEqual(broker.enqueueToActive.mock.callCount(), 0, "参数校验失败不应投递到 broker");
  });
});

describe("ui_page 工具定义", () => {
  it("ui_page_eval_js 应包含 purpose 与 suggestedFilename 参数（必填）", () => {
    const tools = uiPageModule.getToolDefinitions();
    const evalJs = tools.find((t) => t.function?.name === "ui_page_eval_js");
    assert.ok(evalJs, "应有 ui_page_eval_js 工具定义");
    const props = evalJs.function.parameters.properties;
    assert.ok(props.purpose, "应有 purpose 参数");
    assert.ok(props.suggestedFilename, "应有 suggestedFilename 参数");
    assert.ok(evalJs.function.parameters.required.includes("purpose"), "purpose 应为必填（保存提示需展示执行目的）");
    assert.ok(evalJs.function.parameters.required.includes("suggestedFilename"), "suggestedFilename 应为必填（保存提示需预填文件名）");
  });
});
