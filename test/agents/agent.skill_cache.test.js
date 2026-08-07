/**
 * Agent 技能缓存字段测试
 *
 * 测试 Agent 类的 skillPromptCache 字段
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { Agent } from "../../src/agents/agent.js";

describe("Agent 技能缓存字段", () => {
  describe("字段初始化", () => {
    it("创建 Agent 时 skillPromptCache 应该为 null", () => {
      const agent = new Agent({
        id: "test-agent",
        roleId: "test-role",
        roleName: "测试岗位",
        rolePrompt: "测试提示词",
        behavior: async () => {}
      });

      assert.strictEqual(agent.skillPromptCache, null);
    });

    it("skillPromptCache 字段应该可修改", () => {
      const agent = new Agent({
        id: "test-agent",
        roleId: "test-role",
        roleName: "测试岗位",
        rolePrompt: "测试提示词",
        behavior: async () => {}
      });

      // 设置为字符串
      agent.skillPromptCache = "# 已掌握技能\n\n## JavaScript";
      assert.strictEqual(agent.skillPromptCache, "# 已掌握技能\n\n## JavaScript");

      // 设置为空字符串
      agent.skillPromptCache = "";
      assert.strictEqual(agent.skillPromptCache, "");

      // 设置为 null
      agent.skillPromptCache = null;
      assert.strictEqual(agent.skillPromptCache, null);
    });

    it("不应该影响其他字段", () => {
      const agent = new Agent({
        id: "test-agent",
        roleId: "test-role",
        roleName: "测试岗位",
        rolePrompt: "测试提示词",
        behavior: async () => {},
        name: "测试智能体",
        systemPromptAppendix: ["附录内容"]
      });

      // 验证其他字段正常
      assert.strictEqual(agent.id, "test-agent");
      assert.strictEqual(agent.roleId, "test-role");
      assert.strictEqual(agent.roleName, "测试岗位");
      assert.strictEqual(agent.name, "测试智能体");
      assert.deepStrictEqual(agent.systemPromptAppendix, ["附录内容"]);

      // 验证 skillPromptCache 为 null
      assert.strictEqual(agent.skillPromptCache, null);
    });
  });

  describe("字段类型", () => {
    it("skillPromptCache 应该接受 string 类型", () => {
      const agent = new Agent({
        id: "test-agent",
        roleId: "test-role",
        roleName: "测试岗位",
        rolePrompt: "测试提示词",
        behavior: async () => {}
      });

      agent.skillPromptCache = "string content";
      assert.strictEqual(typeof agent.skillPromptCache, "string");
    });

    it("skillPromptCache 应该接受 null", () => {
      const agent = new Agent({
        id: "test-agent",
        roleId: "test-role",
        roleName: "测试岗位",
        rolePrompt: "测试提示词",
        behavior: async () => {}
      });

      agent.skillPromptCache = null;
      assert.strictEqual(agent.skillPromptCache, null);
    });
  });

  describe("缓存状态转换", () => {
    it("应该支持从 null 到 string 的转换", () => {
      const agent = new Agent({
        id: "test-agent",
        roleId: "test-role",
        roleName: "测试岗位",
        rolePrompt: "测试提示词",
        behavior: async () => {}
      });

      assert.strictEqual(agent.skillPromptCache, null);

      agent.skillPromptCache = "# 技能总览";
      assert.strictEqual(agent.skillPromptCache, "# 技能总览");
    });

    it("应该支持从 string 到 null 的转换", () => {
      const agent = new Agent({
        id: "test-agent",
        roleId: "test-role",
        roleName: "测试岗位",
        rolePrompt: "测试提示词",
        behavior: async () => {}
      });

      agent.skillPromptCache = "# 技能总览";
      assert.strictEqual(agent.skillPromptCache, "# 技能总览");

      agent.skillPromptCache = null;
      assert.strictEqual(agent.skillPromptCache, null);
    });

    it("应该支持清空为 empty string", () => {
      const agent = new Agent({
        id: "test-agent",
        roleId: "test-role",
        roleName: "测试岗位",
        rolePrompt: "测试提示词",
        behavior: async () => {}
      });

      agent.skillPromptCache = "# 技能总览";
      agent.skillPromptCache = "";

      assert.strictEqual(agent.skillPromptCache, "");
      assert.notStrictEqual(agent.skillPromptCache, null);
    });
  });
});
