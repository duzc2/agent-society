/**
 * ProcessEventPusher 单元测试
 *
 * 用 mock.timers 控制节流定时器 + 假 bus 捕获推送消息，直接构造假事件验证：
 * - 30 秒节流（无事件不推送、首事件后 30s 批量推送、flush 后续推间隔）
 * - exit 立即推送、exit 后清定时器且不再推送（terminal）
 * - pushEvents=false / 无 agentId 过滤
 * - 150 行 / 2KB 截断 + 跳过范围提示
 * - 事件按到达顺序聚合、真实时间戳格式
 * - shutdown 行为、多进程隔离、bus.send 异常不向上抛
 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";

import { ProcessEventPusher } from "../../../../src/platform/services/process_events/event_pusher.js";
import { makeTestLogger } from "../../../helpers/test_logger.js";

/**
 * 构造假 log 事件（自动确保以换行结尾，模拟真实数据块语义；
 * 无换行结尾的残留行场景见"exit 补入残留行"用例）
 */
function mkLog(processId, text, ts) {
  const normalized = text.endsWith("\n") ? text : text + "\n";
  return { processId, agentId: "a1", pushEvents: true, type: "log", text: normalized, ts };
}

/**
 * 构造假 started 事件
 */
function mkStarted(processId, ts, pid = 12345, command = "npm", args = ["run", "build"]) {
  return { processId, agentId: "a1", pushEvents: true, type: "started", pid, command, args, ts };
}

/**
 * 构造假 exit 事件
 */
function mkExit(processId, ts, status = "completed", exitCode = 0, signal = null, error = null) {
  return { processId, agentId: "a1", pushEvents: true, type: "exit", status, exitCode, signal, error, ts };
}

/**
 * 提取推送文本中的"最新输出"内容块（仅内容行，不含标题/提示行），用于行数与字节断言
 */
function extractTail(text) {
  const start = text.indexOf("最新输出");
  if (start === -1) {return "";}
  const afterHeader = text.indexOf("\n", start);
  const contentStart = afterHeader === -1 ? text.length : afterHeader + 1;
  const end = text.indexOf("【已跳过】", start);
  const end2 = text.indexOf("（此消息为系统自动推送", start);
  const bounds = [end, end2].filter(i => i !== -1);
  const tailEnd = bounds.length > 0 ? Math.min(...bounds) : text.length;
  return text.slice(contentStart, tailEnd);
}

describe("ProcessEventPusher", () => {
  let log;
  let sent;
  let runtime;
  let pusher;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    log = makeTestLogger("Pusher-Test");
    sent = [];
    runtime = {
      bus: {
        send: (m) => {
          sent.push(m);
          return { messageId: `m${sent.length}` };
        }
      }
    };
    pusher = new ProcessEventPusher({ runtime, log, intervalMs: 30000 });
  });

  afterEach(() => {
    pusher.shutdown();
    mock.timers.reset();
  });

  it("30 秒节流：30s 内不发，首事件后 30s 批量推送（事件顺序一致）", () => {
    pusher.onEvent(mkLog("p1", "line1", 1000));
    pusher.onEvent(mkLog("p1", "line2", 1001));

    mock.timers.tick(29000);
    assert.strictEqual(sent.length, 0, "30s 内不应推送");

    mock.timers.tick(1000);
    assert.strictEqual(sent.length, 1, "30s 到期应推送 1 条");

    const msg = sent[0];
    assert.strictEqual(msg.to, "a1");
    assert.strictEqual(msg.from, "localcmd");
    assert.ok(msg.payload.text.includes("line1"), "应包含 line1");
    assert.ok(msg.payload.text.includes("line2"), "应包含 line2");
    assert.ok(
      msg.payload.text.indexOf("line1") < msg.payload.text.indexOf("line2"),
      "事件应按到达顺序排列"
    );
  });

  it("flush 后再来事件 → 起新定时器 → 第 2 条推送独立（不含第 1 批内容）", () => {
    pusher.onEvent(mkLog("p1", "a", 1));
    mock.timers.tick(30000);
    assert.strictEqual(sent.length, 1);

    pusher.onEvent(mkLog("p1", "b", 2));
    mock.timers.tick(30000);
    assert.strictEqual(sent.length, 2, "续推应产生第 2 条消息");
    // 独立行匹配（避免误匹配标题中 "localcmd" 等子串）
    assert.ok(!sent[1].payload.text.includes("\na\n"), "第 2 条不应含第 1 批内容");
    assert.ok(sent[1].payload.text.includes("\nb\n"), "第 2 条应含新内容");
  });

  it("exit 立即推送：log + exit 无需等待 30s", () => {
    pusher.onEvent(mkLog("p1", "hello", 1000));
    pusher.onEvent(mkExit("p1", 2000, "completed", 0));

    assert.strictEqual(sent.length, 1, "exit 后应立即推送");
    const text = sent[0].payload.text;
    assert.ok(text.includes("hello"), "消息应包含退出前日志");
    assert.ok(text.includes("已结束（status: completed, exitCode: 0）"), "消息应包含结束事件");
  });

  it("exit 后清定时器且 terminal：后续事件与定时器均不再推送", () => {
    pusher.onEvent(mkLog("p1", "a", 1));
    pusher.onEvent(mkExit("p1", 2000));
    assert.strictEqual(sent.length, 1);

    mock.timers.tick(60000);
    assert.strictEqual(sent.length, 1, "exit 后 60s 不应再有推送");

    pusher.onEvent(mkLog("p1", "b", 3));
    mock.timers.tick(30000);
    assert.strictEqual(sent.length, 1, "exit 后的后续事件应被 terminal 忽略");
  });

  it("pushEvents=false 与无 agentId 的事件被过滤", () => {
    pusher.onEvent({ processId: "p1", agentId: "a1", pushEvents: false, type: "log", text: "x", ts: 1 });
    pusher.onEvent({ processId: "p2", agentId: undefined, pushEvents: true, type: "log", text: "y", ts: 1 });
    mock.timers.tick(30000);
    assert.strictEqual(sent.length, 0, "过滤事件不应触发推送");
  });

  it("行数截断：180 行只推最后 150 行，并告知跳过第 1~30 行", () => {
    for (let i = 1; i <= 180; i++) {
      pusher.onEvent(mkLog("p1", `line${i}`, i));
    }
    mock.timers.tick(30000);
    assert.strictEqual(sent.length, 1);

    const text = sent[0].payload.text;
    assert.ok(text.includes("新增输出 180 行"), `时间线应报告新增行数，实际: ${text}`);
    assert.ok(text.includes("仅推送最后 150 行"), "应告知只推送最后 150 行");
    assert.ok(text.includes("跳过第 1~30 行"), `应告知跳过范围，实际: ${text}`);

    // 最新内容不包含被跳过的第一行，包含最后一行（独立行匹配，避免 line1 命中 line10~line180 子串）
    assert.ok(!text.includes("\nline1\n"), "被跳过的行不应出现");
    assert.ok(text.includes("\nline180\n"), "最新一行应出现");
    // 尾部输出块恰好 150 行（join 分隔符产生的尾部空段不计）
    const tail = extractTail(text);
    const tailLines = tail.split("\n").filter(l => l !== "");
    assert.strictEqual(tailLines.length, 150, `尾部输出应为 150 行，实际 ${tailLines.length}`);
  });

  it("字节截断：总输出超 2KB 时按字节删行，尾部块 ≤ maxBytes", () => {
    // 200 行，每行 30 字节 → 6000 字节，先按 150 行（4500B）再按字节删到 ≤2048
    for (let i = 1; i <= 200; i++) {
      pusher.onEvent(mkLog("p1", "x".repeat(30), i));
    }
    mock.timers.tick(30000);
    assert.strictEqual(sent.length, 1);

    const text = sent[0].payload.text;
    assert.ok(text.includes("【已跳过】"), "应有跳过提示");
    const tail = extractTail(text);
    const bytes = Buffer.byteLength(tail, "utf8");
    assert.ok(bytes <= 2048, `尾部输出块应 ≤2048 字节，实际 ${bytes}`);
    assert.ok(tail.length > 0, "尾部输出块不应为空");
  });

  it("单行超 2KB：截取尾部并标记，不产生空推送", () => {
    pusher.onEvent(mkLog("p1", "y".repeat(5000), 1));
    mock.timers.tick(30000);
    assert.strictEqual(sent.length, 1);

    const text = sent[0].payload.text;
    assert.ok(text.includes("…[片段过长已截断]"), `超长行应带截断标记，实际: ${text.slice(-100)}`);
    const tail = extractTail(text);
    assert.ok(tail.length > 0, "不应产生空推送");
  });

  it("事件按到达顺序排列，时间线标注真实时间（本地时间格式）", () => {
    // ts 乱序（第二个事件更早），但按到达顺序展示
    pusher.onEvent(mkStarted("p1", 3000));
    pusher.onEvent(mkLog("p1", "first", 2000));
    pusher.onEvent(mkLog("p1", "second", 1000));
    pusher.onEvent(mkExit("p1", 4000, "error", 1, null, "boom"));
    assert.strictEqual(sent.length, 1);

    const text = sent[0].payload.text;
    const tsPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}/;
    const matches = text.match(tsPattern);
    assert.ok(matches, `时间线应含本地时间戳，实际: ${text}`);
    assert.ok(
      text.indexOf("first") < text.indexOf("second"),
      "事件应按到达顺序而非 ts 顺序排列"
    );
    assert.ok(text.includes("已启动（pid 12345）"), "started 应含 pid");
    assert.ok(text.includes("已结束（status: error, exitCode: 1, 错误: boom）"), "exit 应含错误详情");
  });

  it("标题使用完整进程 ID（不截断），不重复命令", () => {
    pusher.onEvent(mkStarted("full-process-id-1234567890-abcdef", 1000));
    pusher.onEvent(mkLog("full-process-id-1234567890-abcdef", "out\n", 1001));
    mock.timers.tick(30000);
    assert.strictEqual(sent.length, 1);

    const text = sent[0].payload.text;
    assert.ok(text.includes("进程 full-process-id-1234567890-abcdef"), "标题应含完整进程 ID");
    assert.ok(!text.includes("…"), "进程 ID 不应被省略号截断");
    assert.ok(!text.includes("（命令:"), "推送不应重复命令");
  });

  it("shutdown：pending 立即 flush；之后事件忽略；定时器已清", () => {
    pusher.onEvent(mkLog("p1", "pending", 1));
    pusher.shutdown();
    assert.strictEqual(sent.length, 1, "shutdown 应推送剩余批次");
    assert.ok(sent[0].payload.text.includes("pending"));

    pusher.onEvent(mkLog("p1", "after", 2));
    assert.strictEqual(sent.length, 1, "关闭后事件应被忽略");

    mock.timers.tick(60000);
    assert.strictEqual(sent.length, 1, "关闭后定时器不应触发推送");
  });

  it("多进程隔离：各自批次与定时器互不串扰", () => {
    pusher.onEvent(mkLog("p1", "a", 1));
    pusher.onEvent(mkLog("p1", "b", 2));
    pusher.onEvent(mkLog("p2", "c", 3));

    mock.timers.tick(30000);
    assert.strictEqual(sent.length, 2, "两个进程应各推送 1 条");

    const msgP1 = sent.find(m => m.payload.text.includes("\na\n"));
    const msgP2 = sent.find(m => m.payload.text.includes("\nc\n"));
    assert.ok(msgP1, "p1 应有推送");
    assert.ok(msgP2, "p2 应有推送");
    assert.ok(!msgP1.payload.text.includes("\nc\n"), "p1 消息不应含 p2 内容");
    assert.ok(!msgP2.payload.text.includes("\na\n"), "p2 消息不应含 p1 内容");
  });

  it("无换行结尾的残留行在 exit 时补入（交互式提示符场景）", () => {
    // 模拟交互式进程："Enter: " 不带换行（挂起），随后用户输入 + 换行，再退出
    pusher.onEvent({ processId: "p1", agentId: "a1", pushEvents: true, type: "log", text: "Enter: ", ts: 1 });
    pusher.onEvent({ processId: "p1", agentId: "a1", pushEvents: true, type: "log", text: "5+3\n", ts: 2 });
    pusher.onEvent({ processId: "p1", agentId: "a1", pushEvents: true, type: "log", text: "8", ts: 3 });
    pusher.onEvent(mkExit("p1", 4, "completed", 0));

    assert.strictEqual(sent.length, 1);
    const text = sent[0].payload.text;
    assert.ok(text.includes("Enter: "), "挂起的提示符行应被补入");
    assert.ok(text.includes("5+3"), "完整行应出现");
    assert.ok(text.includes("8"), "exit 时的残留行应补入");
  });

  it("仅 started 无日志：30s 后仍推送一条（含 pid 与命令）", () => {
    pusher.onEvent(mkStarted("p1", 1000, 777, "sleep", ["100"]));
    mock.timers.tick(30000);
    assert.strictEqual(sent.length, 1, "静默进程 30s 后仍应推送状态");
    const text = sent[0].payload.text;
    assert.ok(text.includes("已启动（pid 777）"));
  });

  it("bus.send 抛异常：不向上抛，后续推送不受影响", () => {
    const badRuntime = {
      bus: { send: () => { throw new Error("bus down"); } }
    };
    const badPusher = new ProcessEventPusher({ runtime: badRuntime, log, intervalMs: 30000 });
    badPusher.onEvent(mkLog("p1", "a", 1));
    mock.timers.tick(30000); // 不应抛异常
    assert.strictEqual(sent.length, 0, "发送失败不应产生消息");

    // send 返回 {ok:false} 也不抛
    const failRuntime = {
      bus: { send: () => ({ ok: false, error: "queue_full" }) }
    };
    const failPusher = new ProcessEventPusher({ runtime: failRuntime, log, intervalMs: 30000 });
    failPusher.onEvent(mkLog("p1", "b", 2));
    mock.timers.tick(30000); // 不应抛异常
    badPusher.shutdown();
    failPusher.shutdown();
  });

  it("maxBatchEvents 内存上限：超出丢弃最旧行并计入跳过范围", () => {
    const limited = new ProcessEventPusher({ runtime, log, intervalMs: 30000, maxBatchEvents: 5 });
    for (let i = 1; i <= 8; i++) {
      limited.onEvent(mkLog("p1", `line${i}`, i));
    }
    mock.timers.tick(30000);
    assert.strictEqual(sent.length, 1);
    const text = sent[0].payload.text;
    assert.ok(text.includes("新增 8 行"), `应报告含被丢弃行的总数，实际: ${text}`);
    assert.ok(text.includes("跳过第 1~3 行"), `跳过范围应含被丢弃行，实际: ${text}`);
    assert.ok(!text.includes("line1"), "被丢弃的最旧行不应出现");
    limited.shutdown();
  });
});
