/**
 * HeartbeatBroker 在线感知 + refreshTtl（P5.1 / B2 前置）
 *
 * 覆盖：
 * - markClientSeen / isClientOnline（初始离线、seen 后在线、窗口边界）
 * - onClientOnline：离线→在线转变触发一次；在线期间重复 seen 不再触发；回调异常隔离
 * - refreshTtl：过期消息复活可 drain；clearMessage 后静默忽略
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

import { HeartbeatBroker } from "../../src/platform/services/heartbeat/heartbeat_broker.js";

function makeLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

describe("HeartbeatBroker 在线感知", () => {
  let broker;

  beforeEach(() => {
    broker = new HeartbeatBroker({ logger: makeLogger() });
  });

  it("初始（从未见过客户端）为离线", () => {
    assert.strictEqual(broker.isClientOnline(), false);
  });

  it("markClientSeen 后在线；窗口外视为离线", () => {
    broker.markClientSeen();
    assert.strictEqual(broker.isClientOnline(), true);
    // 窗口 0ms：任何时间差都算离线（边界语义：seen 只是历史，窗口决定在线）
    assert.strictEqual(broker.isClientOnline(0), false);
  });

  it("离线→在线转变触发一次 onClientOnline；在线期间重复 seen 不再触发", () => {
    const calls = [];
    broker.onClientOnline(() => calls.push("online"));

    broker.markClientSeen();
    assert.strictEqual(calls.length, 1, "首次上线应触发一次");

    broker.markClientSeen();
    broker.markClientSeen();
    assert.strictEqual(calls.length, 1, "在线期间重复 seen 不应重复触发");
  });

  it("单个回调异常不影响其他回调与 markClientSeen 本身", () => {
    const calls = [];
    broker.onClientOnline(() => { throw new Error("boom"); });
    broker.onClientOnline(() => calls.push("second"));

    assert.doesNotThrow(() => broker.markClientSeen());
    assert.deepStrictEqual(calls, ["second"], "异常后的回调仍应执行");
  });

  it("offClientOnline 移除后不再触发", () => {
    const calls = [];
    const fn = () => calls.push("x");
    broker.onClientOnline(fn);
    broker.offClientOnline(fn);
    broker.markClientSeen();
    assert.strictEqual(calls.length, 0);
  });
});

describe("HeartbeatBroker refreshTtl（保活重投）", () => {
  let broker;

  beforeEach(() => {
    broker = new HeartbeatBroker({ logger: makeLogger() });
  });

  it("过期消息 drain 不可见；refreshTtl 后复活可 drain", () => {
    const id = broker.broadcast("ui_command", { type: "eval_js" }, 50);
    // 消息未过期
    assert.strictEqual(broker.drain(0).length, 1);
    // 过期后不可见（消息仍在队列，仅 drain 过滤）
    const expiresAt = broker._messages.get(id).expiresAt;
    broker._messages.get(id).expiresAt = Date.now() - 1;
    assert.notStrictEqual(expiresAt, null);
    assert.strictEqual(broker.drain(0).length, 0, "过期消息不应 drain 到");

    broker.refreshTtl(id, 60_000);
    assert.strictEqual(broker.drain(0).length, 1, "refreshTtl 后应复活");
  });

  it("refreshTtl 对已清除的消息静默忽略", () => {
    const id = broker.broadcast("ui_command", {}, 60_000);
    broker.clearMessage(id);
    assert.doesNotThrow(() => broker.refreshTtl(id, 60_000));
    assert.strictEqual(broker.drain(0).length, 0);
  });
});
