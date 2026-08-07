/**
 * 步骤 8: LifecycleRegistry 测试
 *
 * 验证以下场景：
 * 1. register() → getByAgent() 正确返回
 * 2. getByType() 按类型过滤
 * 3. unregister() 调用 cleanup 并从 Map 移除
 * 4. cleanup 失败时资源仍从 Map 移除（finally 块）
 * 5. forceCleanupAgent() 按正确顺序清理
 * 6. getStats() 返回正确计数
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { LifecycleRegistry } from "../../src/platform/runtime/resource_lifecycle.js";

describe("LifecycleRegistry", () => {
  /** @type {LifecycleRegistry} */
  let registry;

  beforeEach(() => {
    registry = new LifecycleRegistry();
  });

  // ==================== 1. register + getByAgent ====================

  it("注册资源后 getByAgent() 应正确返回", () => {
    registry.register({
      id: "chrome:agent-1:123",
      type: "chrome",
      ownerAgentId: "agent-1",
      cleanup: () => {}
    });

    const resources = registry.getByAgent("agent-1");
    assert.strictEqual(resources.length, 1);
    assert.strictEqual(resources[0].id, "chrome:agent-1:123");
    assert.strictEqual(resources[0].type, "chrome");
    assert.strictEqual(resources[0].ownerAgentId, "agent-1");
    assert.strictEqual(resources[0].state, "active");
    assert.ok(resources[0].createdAt > 0);
  });

  it("同一个智能体注册多个资源应全部返回", () => {
    registry.register({ id: "res-1", type: "chrome", ownerAgentId: "agent-1" });
    registry.register({ id: "res-2", type: "subprocess", ownerAgentId: "agent-1" });

    const resources = registry.getByAgent("agent-1");
    assert.strictEqual(resources.length, 2);
  });

  it("不存在智能体的 getByAgent 返回空数组", () => {
    assert.deepStrictEqual(registry.getByAgent("nonexistent"), []);
  });

  // ==================== 2. getByType ====================

  it("getByType() 应按类型过滤", () => {
    registry.register({ id: "c-1", type: "chrome", ownerAgentId: "a" });
    registry.register({ id: "c-2", type: "chrome", ownerAgentId: "b" });
    registry.register({ id: "s-1", type: "subprocess", ownerAgentId: "a" });

    assert.strictEqual(registry.getByType("chrome").length, 2);
    assert.strictEqual(registry.getByType("subprocess").length, 1);
    assert.strictEqual(registry.getByType("agent_memory").length, 0);
  });

  // ==================== 3. unregister ====================

  it("unregister() 应调用 cleanup 并从 Map 移除", async () => {
    let cleaned = false;
    registry.register({
      id: "res-1",
      type: "subprocess",
      ownerAgentId: "agent-1",
      cleanup: () => { cleaned = true; }
    });

    await registry.unregister("res-1");

    assert.strictEqual(cleaned, true);
    assert.strictEqual(registry.getByAgent("agent-1").length, 0);
    assert.strictEqual(registry.getByType("subprocess").length, 0);
  });

  it("unregister 不存在的资源不报错", async () => {
    await registry.unregister("nonexistent");
    // 不应抛出异常
  });

  // ==================== 4. cleanup 失败仍从 Map 移除 ====================

  it("cleanup 失败时资源仍被从 Map 移除（finally 块执行）", async () => {
    registry.register({
      id: "res-1",
      type: "chrome",
      ownerAgentId: "agent-1",
      cleanup: () => { throw new Error("cleanup failed"); }
    });

    try {
      await registry.unregister("res-1");
    } catch {
      // 预期异常
    }

    // cleanup 虽然失败，但资源仍被移除
    assert.strictEqual(registry.getByAgent("agent-1").length, 0);
    assert.strictEqual(registry.getByType("chrome").length, 0);
  });

  // ==================== 5. forceCleanupAgent ====================

  it("forceCleanupAgent() 应按正确顺序清理所有资源", async () => {
    const cleanupOrder = [];

    registry.register({
      id: "data", type: "data_folder", ownerAgentId: "agent-1",
      cleanup: () => { cleanupOrder.push("data_folder"); }
    });
    registry.register({
      id: "chrome", type: "chrome", ownerAgentId: "agent-1",
      cleanup: () => { cleanupOrder.push("chrome"); }
    });
    registry.register({
      id: "sub", type: "subprocess", ownerAgentId: "agent-1",
      cleanup: () => { cleanupOrder.push("subprocess"); }
    });

    const results = await registry.forceCleanupAgent("agent-1", "test");

    // 验证顺序：chrome → subprocess → data_folder
    assert.strictEqual(cleanupOrder[0], "chrome");
    assert.strictEqual(cleanupOrder[1], "subprocess");
    assert.strictEqual(cleanupOrder[2], "data_folder");

    // 验证返回结果
    assert.strictEqual(results.length, 3);
    assert.strictEqual(results.every(r => r.status === "ok"), true);

    // 验证已全部清理
    assert.strictEqual(registry.getByAgent("agent-1").length, 0);
  });

  it("forceCleanupAgent 某个资源清理失败时继续清理其余", async () => {
    const cleanupLog = [];

    registry.register({
      id: "good", type: "chrome", ownerAgentId: "agent-1",
      cleanup: () => { cleanupLog.push("good"); }
    });
    registry.register({
      id: "bad", type: "subprocess", ownerAgentId: "agent-1",
      cleanup: () => { throw new Error("fail"); }
    });
    registry.register({
      id: "also-good", type: "agent_memory", ownerAgentId: "agent-1",
      cleanup: () => { cleanupLog.push("also-good"); }
    });

    const results = await registry.forceCleanupAgent("agent-1");

    assert.ok(cleanupLog.includes("good"));
    assert.ok(cleanupLog.includes("also-good"));

    const badResult = results.find(r => r.id === "bad");
    assert.strictEqual(badResult.status, "error");
    assert.strictEqual(badResult.error, "fail");

    // 所有资源均被移除
    assert.strictEqual(registry.getByAgent("agent-1").length, 0);
  });

  it("forceCleanupAgent 不存在的智能体返回空数组", async () => {
    const results = await registry.forceCleanupAgent("nonexistent");
    assert.deepStrictEqual(results, []);
  });

  // ==================== 6. getStats ====================

  it("getStats() 应返回正确计数", () => {
    assert.deepStrictEqual(registry.getStats(), { total: 0, byType: {}, byAgent: 0 });

    registry.register({ id: "c-1", type: "chrome", ownerAgentId: "a" });
    registry.register({ id: "c-2", type: "chrome", ownerAgentId: "b" });
    registry.register({ id: "s-1", type: "subprocess", ownerAgentId: "a" });

    const stats = registry.getStats();
    assert.strictEqual(stats.total, 3);
    assert.strictEqual(stats.byType.chrome, 2);
    assert.strictEqual(stats.byType.subprocess, 1);
    assert.strictEqual(stats.byAgent, 2);
  });

  // ==================== 7. 注册后资源 id 唯一 ====================

  it("再次注册相同 id 应更新资源条目", () => {
    registry.register({ id: "dup", type: "chrome", ownerAgentId: "a" });
    registry.register({ id: "dup", type: "subprocess", ownerAgentId: "b" });

    // id "dup" 的资源条目被覆盖为 type=subprocess, ownerAgentId=b
    // 但 _byAgent 中两者都仍持有该 id（Set 无重复检测）
    const resourcesB = registry.getByAgent("b");
    assert.strictEqual(resourcesB.length, 1);
    assert.strictEqual(resourcesB[0].type, "subprocess");
    assert.strictEqual(resourcesB[0].ownerAgentId, "b");
  });

  // ==================== 8. 无 cleanup 函数清理 ====================

  it("无 cleanup 函数的资源也能正常 unregister", async () => {
    registry.register({ id: "no-cleanup", type: "agent_memory", ownerAgentId: "agent-1" });

    await registry.unregister("no-cleanup");

    assert.strictEqual(registry.getByAgent("agent-1").length, 0);
    assert.strictEqual(registry.getByType("agent_memory").length, 0);
  });

  // ==================== 9. 跨智能体隔离 ====================

  it("清理一个智能体不影响其他智能体的资源", async () => {
    registry.register({ id: "r-a", type: "chrome", ownerAgentId: "agent-a" });
    registry.register({ id: "r-b", type: "chrome", ownerAgentId: "agent-b" });
    registry.register({ id: "r-c", type: "subprocess", ownerAgentId: "agent-b" });

    await registry.forceCleanupAgent("agent-a");

    assert.strictEqual(registry.getByAgent("agent-a").length, 0);
    assert.strictEqual(registry.getByAgent("agent-b").length, 2);
  });
});
