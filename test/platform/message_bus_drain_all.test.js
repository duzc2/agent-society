/**
 * MessageBus drainAll() 原子排空边界条件测试
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { MessageBus } from "../../src/platform/core/message_bus.js";

describe("MessageBus drainAll 边界条件", () => {
  let bus;

  beforeEach(() => {
    bus = new MessageBus();
  });

  afterEach(() => {
    bus = null;
  });

  describe("空队列", () => {
    it("空队列返回空数组", () => {
      assert.deepStrictEqual(bus.drainAll("no-agent"), []);
    });

    it("drainAll 空队列后不影响后续 send", () => {
      bus.drainAll("agent-a");
      bus.send({ from: "x", to: "agent-a", payload: "hello" });
      assert.strictEqual(bus.getQueueDepth("agent-a"), 1);
    });

    it("drainAll 对从未存在的 agent 返回空数组", () => {
      for (let i = 0; i < 3; i++) {
        assert.deepStrictEqual(bus.drainAll("unknown-" + i), []);
      }
    });
  });

  describe("单/多消息排空", () => {
    it("单条消息排空后队列深度为 0", () => {
      bus.send({ from: "a", to: "b", payload: "solo" });
      const msgs = bus.drainAll("b");
      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(bus.getQueueDepth("b"), 0);
    });

    it("多条消息排空后队列完全清空", () => {
      for (let i = 0; i < 100; i++) {
        bus.send({ from: "a", to: "b", payload: "msg-" + i });
      }
      const msgs = bus.drainAll("b");
      assert.strictEqual(msgs.length, 100);
      assert.strictEqual(bus.getQueueDepth("b"), 0);
      assert.strictEqual(bus.hasPending(), false);
    });

    it("消息按 FIFO 顺序返回", () => {
      bus.send({ from: "a", to: "b", payload: "first" });
      bus.send({ from: "a", to: "b", payload: "second" });
      bus.send({ from: "a", to: "b", payload: "third" });

      const msgs = bus.drainAll("b");
      assert.strictEqual(msgs[0].payload, "first");
      assert.strictEqual(msgs[1].payload, "second");
      assert.strictEqual(msgs[2].payload, "third");
    });
  });

  describe("只影响目标 agent", () => {
    it("drainAll 不影响其他 agent 的队列", () => {
      bus.send({ from: "a", to: "agent-x", payload: "msg1" });
      bus.send({ from: "a", to: "agent-y", payload: "msg2" });
      bus.send({ from: "a", to: "agent-y", payload: "msg3" });

      bus.drainAll("agent-x");

      assert.strictEqual(bus.getQueueDepth("agent-x"), 0);
      assert.strictEqual(bus.getQueueDepth("agent-y"), 2);
      assert.strictEqual(bus.hasPending(), true);
    });

    it("三个 agent 各自排空互不干扰", () => {
      bus.send({ from: "a", to: "x", payload: "x1" });
      bus.send({ from: "a", to: "y", payload: "y1" });
      bus.send({ from: "a", to: "z", payload: "z1" });
      bus.send({ from: "a", to: "x", payload: "x2" });

      const xMsgs = bus.drainAll("x");
      const yMsgs = bus.drainAll("y");
      const zMsgs = bus.drainAll("z");

      assert.strictEqual(xMsgs.length, 2);
      assert.strictEqual(yMsgs.length, 1);
      assert.strictEqual(zMsgs.length, 1);
      assert.strictEqual(bus.hasPending(), false);
    });
  });

  describe("send 与 drainAll 交替", () => {
    it("drainAll 后再次 send 可正确排空", () => {
      bus.send({ from: "a", to: "b", payload: "batch1-1" });
      bus.send({ from: "a", to: "b", payload: "batch1-2" });
      const batch1 = bus.drainAll("b");
      assert.strictEqual(batch1.length, 2);

      bus.send({ from: "a", to: "b", payload: "batch2-1" });
      bus.send({ from: "a", to: "b", payload: "batch2-2" });
      bus.send({ from: "a", to: "b", payload: "batch2-3" });
      const batch2 = bus.drainAll("b");
      assert.strictEqual(batch2.length, 3);
    });

    it("send → drainAll → send → drainAll 多次循环", () => {
      for (let round = 0; round < 10; round++) {
        for (let i = 0; i < 5; i++) {
          bus.send({ from: "a", to: "b", payload: "r" + round + "-" + i });
        }
        const msgs = bus.drainAll("b");
        assert.strictEqual(msgs.length, 5);
        assert.strictEqual(bus.getQueueDepth("b"), 0);
      }
    });

    it("大量消息循环 send + drainAll", () => {
      for (let i = 0; i < 200; i++) {
        bus.send({ from: "a", to: "b", payload: "msg-" + i });
      }
      const msgs = bus.drainAll("b");
      assert.strictEqual(msgs.length, 200);
      assert.strictEqual(msgs[0].payload, "msg-0");
      assert.strictEqual(msgs[199].payload, "msg-199");
      assert.strictEqual(bus.hasPending(), false);
    });
  });

  describe("消息属性完整性", () => {
    it("drainAll 返回完整消息属性", () => {
      bus.send({ from: "agent-a", to: "agent-b", payload: { text: "hello" }, taskId: "task-1" });
      const msgs = bus.drainAll("agent-b");

      const msg = msgs[0];
      assert.notStrictEqual(msg.id, undefined);
      assert.notStrictEqual(msg.createdAt, undefined);
      assert.strictEqual(msg.to, "agent-b");
      assert.strictEqual(msg.from, "agent-a");
      assert.deepStrictEqual(msg.payload, { text: "hello" });
      assert.strictEqual(msg.taskId, "task-1");
    });

    it("多条消息各自保留独立 id", () => {
      bus.send({ from: "a", to: "b", payload: "m1" });
      bus.send({ from: "a", to: "b", payload: "m2" });
      bus.send({ from: "a", to: "b", payload: "m3" });

      const msgs = bus.drainAll("b");
      assert.notStrictEqual(msgs[0].id, msgs[1].id);
      assert.notStrictEqual(msgs[1].id, msgs[2].id);
      assert.notStrictEqual(msgs[0].id, msgs[2].id);
    });
  });

  describe("同 agent 多 receiver", () => {
    it("同一 sender 给多个 receiver 的消息独立 drainAll", () => {
      bus.send({ from: "s", to: "r1", payload: "to-r1" });
      bus.send({ from: "s", to: "r2", payload: "to-r2" });
      bus.send({ from: "s", to: "r1", payload: "to-r1-again" });

      const r1Msgs = bus.drainAll("r1");
      const r2Msgs = bus.drainAll("r2");

      assert.strictEqual(r1Msgs.length, 2);
      assert.strictEqual(r1Msgs[0].to, "r1");
      assert.strictEqual(r1Msgs[1].to, "r1");
      assert.strictEqual(r2Msgs.length, 1);
      assert.strictEqual(r2Msgs[0].to, "r2");
    });
  });

  describe("延迟消息排空", () => {
    it("延迟消息在 deliverDueMessages 后被 drainAll 获取", async () => {
      bus.send({ from: "a", to: "b", payload: "delayed", delayMs: 1 });
      assert.deepStrictEqual(bus.drainAll("b"), []); // 尚未投递

      await new Promise(r => setTimeout(r, 10));
      bus.deliverDueMessages();

      const msgs = bus.drainAll("b");
      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(msgs[0].payload, "delayed");
    });

    it("forceDeliverAllDelayed 后 drainAll 可获取", () => {
      bus.send({ from: "a", to: "b", payload: "forced", delayMs: 100000 });
      assert.deepStrictEqual(bus.drainAll("b"), []);

      bus.forceDeliverAllDelayed();
      const msgs = bus.drainAll("b");
      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(msgs[0].payload, "forced");
    });
  });

  describe("drainAll 后 hasPending 和 getPendingCount", () => {
    it("排空后 hasPending 返回 false", () => {
      bus.send({ from: "a", to: "x", payload: "m1" });
      bus.send({ from: "a", to: "y", payload: "m2" });
      bus.drainAll("x");
      bus.drainAll("y");
      assert.strictEqual(bus.hasPending(), false);
      assert.strictEqual(bus.getPendingCount(), 0);
    });

    it("部分排空后 hasPending 仍为 true", () => {
      bus.send({ from: "a", to: "x", payload: "m1" });
      bus.send({ from: "a", to: "y", payload: "m2" });
      bus.drainAll("x");

      assert.strictEqual(bus.hasPending(), true);
      assert.strictEqual(bus.getPendingCount(), 1);
    });
  });
});
