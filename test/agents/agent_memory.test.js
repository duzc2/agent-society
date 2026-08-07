/**
 * Agent 类记忆字段测试
 *
 * 测试内容：
 * 1. lastMemoryMessageId 字段初始化
 * 2. lastMemoryMessageId 从 options 恢复
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { Agent } from "../../src/agents/agent.js";

describe("Agent Memory Fields", () => {
  const createMockBehavior = () => async () => {};

  describe("lastMemoryMessageId", () => {
    it("默认应为 null", () => {
      const agent = new Agent({
        id: "test-1",
        roleId: "role-1",
        roleName: "测试岗位",
        rolePrompt: "测试",
        behavior: createMockBehavior()
      });

      assert.strictEqual(agent.lastMemoryMessageId, null);
    });

    it("应从 options 中恢复", () => {
      const agent = new Agent({
        id: "test-1",
        roleId: "role-1",
        roleName: "测试岗位",
        rolePrompt: "测试",
        behavior: createMockBehavior(),
        lastMemoryMessageId: "msg-123"
      });

      assert.strictEqual(agent.lastMemoryMessageId, "msg-123");
    });

    it("应可修改", () => {
      const agent = new Agent({
        id: "test-1",
        roleId: "role-1",
        roleName: "测试岗位",
        rolePrompt: "测试",
        behavior: createMockBehavior()
      });

      agent.lastMemoryMessageId = "msg-new";
      assert.strictEqual(agent.lastMemoryMessageId, "msg-new");
    });

    it("应与其他字段共存", () => {
      const agent = new Agent({
        id: "test-1",
        roleId: "role-1",
        roleName: "测试岗位",
        rolePrompt: "测试",
        behavior: createMockBehavior(),
        name: "张三",
        systemPromptAppendix: ["自定义附录"],
        lastMemoryMessageId: "msg-456"
      });

      assert.strictEqual(agent.id, "test-1");
      assert.strictEqual(agent.name, "张三");
      assert.deepStrictEqual(agent.systemPromptAppendix, ["自定义附录"]);
      assert.strictEqual(agent.lastMemoryMessageId, "msg-456");
    });
  });
});
