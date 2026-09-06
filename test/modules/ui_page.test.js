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
      _llm: { registerMessageFormatter: mock.fn() },
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

  it("ui_page_notify 应存在且 text 必填", () => {
    const tools = uiPageModule.getToolDefinitions();
    const notify = tools.find((t) => t.function?.name === "ui_page_notify");
    assert.ok(notify, "应有 ui_page_notify 工具定义");
    assert.ok(notify.function.parameters.required.includes("text"), "text 应为必填");
  });
});

describe("ui_page A/B 通道（notify-agent + ui_page_notify）", () => {
  let broker;
  let runtime;
  let handler;
  let formatterRegistry;

  beforeEach(async () => {
    broker = {
      enqueueToActive: mock.fn(() => ({ ok: true, commandId: "cmd-n1" })),
      waitForResult: mock.fn(),
      clearCommand: mock.fn(),
    };
    _setBroker(broker);
    formatterRegistry = [];
    runtime = {
      loggerRoot: { forModule: (name) => makeTestLogger("UIPageAB|" + name) },
      findWorkspaceIdForAgent: mock.fn(() => null),
      configService: makeFakeConfigService(),
      _llm: { registerMessageFormatter: (p, f) => formatterRegistry.push([p, f]) },
      _agents: new Map([["agent-1", { id: "agent-1" }]]),
      bus: { send: mock.fn(() => ({ messageId: "mid-1" })) },
    };
    await uiPageModule.init(runtime);
    handler = uiPageModule.getHttpHandler();
  });

  function makeReq(method = "POST") {
    return { method };
  }

  it("notify-agent 合法请求 → bus.send(kind=page_notify) 投递到指定智能体", async () => {
    const resp = await handler(makeReq(), null, ["notify-agent"], { agentId: "agent-1", text: "页面点完按钮了" });
    assert.deepStrictEqual(resp, { ok: true, messageId: "mid-1" });
    assert.strictEqual(runtime.bus.send.mock.callCount(), 1);
    const sent = runtime.bus.send.mock.calls[0].arguments[0];
    assert.strictEqual(sent.to, "agent-1");
    assert.strictEqual(sent.from, "page");
    assert.deepStrictEqual(sent.payload, { text: "页面点完按钮了" });
    assert.deepStrictEqual(sent.extras, { kind: "page_notify" });
  });

  it("notify-agent 缺 agentId / 缺 text / 未知智能体 → 明确错误且不投递", async () => {
    const r1 = await handler(makeReq(), null, ["notify-agent"], { text: "x" });
    assert.strictEqual(r1.error, "missing_agent_id");
    const r2 = await handler(makeReq(), null, ["notify-agent"], { agentId: "agent-1", text: "" });
    assert.strictEqual(r2.error, "missing_text");
    const r3 = await handler(makeReq(), null, ["notify-agent"], { agentId: "no-such", text: "x" });
    assert.strictEqual(r3.error, "agent_not_found");
    assert.strictEqual(runtime.bus.send.mock.callCount(), 0, "校验失败不应投递");
  });

  it("notify-agent 非 POST → invalid_method", async () => {
    const resp = await handler(makeReq("GET"), null, ["notify-agent"], null);
    assert.strictEqual(resp.error, "invalid_method");
  });

  it("page_notify 格式化器注册：predicate 判别 + 输出【页面通知】前缀", async () => {
    assert.strictEqual(formatterRegistry.length, 1, "init 应注册一个格式化器");
    const [predicate, formatter] = formatterRegistry[0];

    const msg = { extras: { kind: "page_notify" }, payload: { text: "任务完成了" } };
    assert.strictEqual(predicate(msg), true);
    assert.strictEqual(predicate({ extras: { kind: "proc_msg" } }), false);
    assert.strictEqual(formatter(msg), "【页面通知】任务完成了");
    // 字符串 payload 与超长截断
    assert.strictEqual(formatter({ extras: { kind: "page_notify" }, payload: "纯文本" }), "【页面通知】纯文本");
    const long = "字".repeat(600);
    assert.strictEqual(formatter({ extras: { kind: "page_notify" }, payload: { text: long } }).length, "【页面通知】".length + 500);
  });

  it("ui_page_notify 合法 → 投递 notify 命令（带 agentId）并返回 ok，延迟清理心跳消息", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const r = await uiPageModule.executeToolCall(
        { agent: { id: "agent-1" } },
        "ui_page_notify",
        { text: "数据抓完了" }
      );
      assert.deepStrictEqual(r, { ok: true });
      assert.strictEqual(broker.enqueueToActive.mock.callCount(), 1);
      const cmd = broker.enqueueToActive.mock.calls[0].arguments[0];
      assert.strictEqual(cmd.type, "notify");
      assert.deepStrictEqual(cmd.payload, { text: "数据抓完了", agentId: "agent-1" });
      // fire-and-forget：10s 后服务端清理心跳消息，防止页面刷新重复弹通知
      assert.strictEqual(broker.clearCommand.mock.callCount(), 0);
      mock.timers.tick(10_000);
      assert.strictEqual(broker.clearCommand.mock.callCount(), 1);
      assert.strictEqual(broker.clearCommand.mock.calls[0].arguments[0], "cmd-n1");
    } finally {
      mock.timers.reset();
    }
  });

  it("ui_page_notify 缺 text → invalid_params 且不投递", async () => {
    const r1 = await uiPageModule.executeToolCall({ agent: { id: "agent-1" } }, "ui_page_notify", {});
    assert.strictEqual(r1.error, "invalid_params");
    const r2 = await uiPageModule.executeToolCall({ agent: { id: "agent-1" } }, "ui_page_notify", { text: "  " });
    assert.strictEqual(r2.error, "invalid_params");
    assert.strictEqual(broker.enqueueToActive.mock.callCount(), 0);
  });

  it("ui_page_notify broker 不可用 → ui_broker_unavailable", async () => {
    _setBroker(null);
    const r = await uiPageModule.executeToolCall({ agent: { id: "agent-1" } }, "ui_page_notify", { text: "x" });
    assert.deepStrictEqual(r, { ok: false, error: "ui_broker_unavailable" });
  });
});
