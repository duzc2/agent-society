/**
 * UiCommandBroker 离线保活重投（P5.2 / B2）
 *
 * 覆盖：
 * - 无 keepAliveMs：行为与既有完全一致（TTL 60s 到期后 drain 不可见）
 * - keepAliveMs 开启：窗口期内周期性 refreshTtl，消息在原 TTL 过期后仍可 drain
 * - resolveResult / clearCommand：保活循环停止，消息立即清除
 * - 超窗自停：deadline 后不再刷新，消息最终过期
 *
 * 时间推进用 node:test mock.timers（Date + setInterval 同步 mock）。
 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";

import { HeartbeatBroker } from "../../src/platform/services/heartbeat/heartbeat_broker.js";
import { UiCommandBroker } from "../../modules/ui_page/broker.js";

function makeLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

describe("UiCommandBroker 保活重投", () => {
  let heartbeatBroker;
  let broker;

  beforeEach(() => {
    // setTimeout 一并 mock：waitForResult 挂起的超时定时器不能成为真实句柄拖住事件循环
    mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
    heartbeatBroker = new HeartbeatBroker({ logger: makeLogger() });
    broker = new UiCommandBroker({ logger: makeLogger() });
    broker.setHeartbeatBroker(heartbeatBroker);
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it("无 keepAliveMs：TTL 60s 到期后消息不可见（既有行为不回归）", () => {
    const enq = broker.enqueueToActive({ type: "eval_js", payload: {} });
    assert.strictEqual(enq.ok, true);
    assert.strictEqual(heartbeatBroker.drain(0).length, 1);

    mock.timers.tick(70_000);
    assert.strictEqual(heartbeatBroker.drain(0).length, 0, "未保活的消息应正常过期");
  });

  it("keepAliveMs 窗口期内周期刷新，消息超过原 TTL 仍可 drain", async () => {
    const enq = broker.enqueueToActive({ type: "get_content", payload: {} }, { keepAliveMs: 25_000 });
    const wp = broker.waitForResult(enq.commandId, 500_000);

    assert.strictEqual(heartbeatBroker.drain(0).length, 1, "投递后立即可 drain");
    mock.timers.tick(30_000);
    assert.strictEqual(heartbeatBroker.drain(0).length, 1, "窗口内已超过原 TTL，保活后仍可见");

    broker.resolveResult(enq.commandId, { ok: true, result: null });
    await wp;
  });

  it("resolveResult 停止保活：消息立即清除且不再复活", async () => {
    const enq = broker.enqueueToActive({ type: "eval_js", payload: {} }, { keepAliveMs: 100_000 });

    // 真实流程：工具侧先挂 pending，客户端回传时 resolveResult 才有目标
    const waitPromise = broker.waitForResult(enq.commandId, 500_000);
    const resolved = broker.resolveResult(enq.commandId, { ok: true, result: 1 });
    assert.strictEqual(resolved.ok, true);
    assert.deepStrictEqual(await waitPromise, { ok: true, result: 1 });
    assert.strictEqual(heartbeatBroker.drain(0).length, 0, "结果回传后消息应立即清除");

    mock.timers.tick(70_000);
    assert.strictEqual(heartbeatBroker.drain(0).length, 0, "保活停止后不应再刷新复活");
  });

  it("pending 消失（工具已超时返回）后保活自停，不再刷新", () => {
    broker.enqueueToActive({ type: "eval_js", payload: {} }, { keepAliveMs: 100_000 });
    // 无 waitForResult → 无 pending：首个刷新周期即自停，消息按原 TTL 过期

    mock.timers.tick(70_000);
    assert.strictEqual(heartbeatBroker.drain(0).length, 0, "无 pending 时不应保活");
  });

  it("clearCommand 停止保活：消息立即清除且不再复活", () => {
    const enq = broker.enqueueToActive({ type: "eval_js", payload: {} }, { keepAliveMs: 100_000 });
    broker.clearCommand(enq.commandId);
    assert.strictEqual(heartbeatBroker.drain(0).length, 0);

    mock.timers.tick(70_000);
    assert.strictEqual(heartbeatBroker.drain(0).length, 0);
  });

  it("超窗自停：deadline 后不再刷新，消息最终过期", () => {
    const enq = broker.enqueueToActive({ type: "eval_js", payload: {} }, { keepAliveMs: 25_000 });
    broker.waitForResult(enq.commandId, 500_000);

    mock.timers.tick(20_000);
    assert.strictEqual(heartbeatBroker.drain(0).length, 1, "窗口内应保活");
    const msgId = heartbeatBroker.drain(0)[0].messageId;

    mock.timers.tick(80_000);
    // deadline=25s 后无刷新；最后一次刷新在 20s（expiresAt=80s），80s 时过期
    assert.strictEqual(heartbeatBroker.drain(0).length, 0, "超窗后应自然过期");
    assert.ok(msgId > 0);
  });
});
