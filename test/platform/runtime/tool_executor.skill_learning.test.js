/**
 * 工具执行器技能相关工具测试
 *
 * 测试 load_skill_detail 工具（含技能学习标记）和 forget_skill 工具。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ToolExecutor } from "../../../src/platform/runtime/tool_executor.js";
import { makeTestLogger } from "../../helpers/test_logger.js";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DATA_PATH = path.join(__dirname, ".tmp_tool_test");

describe("工具执行器 - 技能学习工具", () => {
  let toolExecutor;
  let mockRuntime;
  let mockCtx;

  beforeEach(async () => {
    await mkdir(TEST_DATA_PATH, { recursive: true });

    // Mock Runtime
    mockRuntime = {
      log: makeTestLogger("ToolExecutor"),
      moduleLoader: {
        getToolDefinitions: () => []
      },
      skillsService: {
        resolveVisibleSkill: async (_agentId, skillIdentifier) => {
          if (skillIdentifier === "existing-skill") {
            return { skillId: "existing-skill", displayName: "Existing Skill" };
          }
          return null;
        },
        repository: {
          readSkillFile: async (_skillId, relativePath) => {
            if (relativePath === "SKILL.md") {
              return { resolvedPath: `/skills/existing-skill/${relativePath}`, content: "# 技能内容" };
            }
            return null;
          }
        },
        markSkillLearned: async () => {
          // 测试用空实现
        },
        forgetSkill: async (_agentId, skillId) => {
          if (skillId === "learned-skill") {
            return; // 成功遗忘
          }
          if (skillId === "forget-error") {
            throw new Error("测试异常：遗忘失败");
          }
          return; // 未学习，静默返回
        }
      }
    };

    toolExecutor = new ToolExecutor(mockRuntime);

    // Mock Context
    mockCtx = {
      agent: { id: "test-agent" },
      org: {},
      tools: {}
    };
  });

  afterEach(async () => {
    try {
      await rm(TEST_DATA_PATH, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  });

  describe("load_skill_detail 工具", () => {
    it("工具定义应该存在", () => {
      const tools = toolExecutor.getToolDefinitions();
      const loadTool = tools.find(t => t.function?.name === "load_skill_detail");

      assert.notStrictEqual(loadTool, undefined);
      assert.strictEqual(loadTool.function.name, "load_skill_detail");
      assert.ok(loadTool.function.parameters.required.includes("skill"));
    });

    it("应该加载存在的技能", async () => {
      const result = await toolExecutor._executeLoadSkillDetail(mockCtx, {
        skill: "existing-skill"
      });

      assert.strictEqual(result.content, "# 技能内容");
    });

    it("成功加载技能后应调用 markSkillLearned", async () => {
      let learnedCalled = false;
      let learnedSkillId = null;

      mockRuntime.skillsService.markSkillLearned = async (agentId, skillId) => {
        learnedCalled = true;
        learnedSkillId = skillId;
      };

      await toolExecutor._executeLoadSkillDetail(mockCtx, {
        skill: "existing-skill"
      });

      assert.ok(learnedCalled, "load_skill_detail 成功后应调用 markSkillLearned");
      assert.strictEqual(learnedSkillId, "existing-skill");
    });

    it("技能不存在应该报错", async () => {
      const result = await toolExecutor._executeLoadSkillDetail(mockCtx, {
        skill: "non-existent"
      });

      assert.strictEqual(result.error, "skill_not_visible");
    });

    it("技能不存在时不应调用 markSkillLearned", async () => {
      let learnedCalled = false;

      mockRuntime.skillsService.markSkillLearned = async () => {
        learnedCalled = true;
      };

      await toolExecutor._executeLoadSkillDetail(mockCtx, {
        skill: "non-existent"
      });

      assert.ok(!learnedCalled, "技能不存在时不应调用 markSkillLearned");
    });

    it("应该验证 skill", async () => {
      const result = await toolExecutor._executeLoadSkillDetail(mockCtx, {
        skill: ""
      });

      assert.strictEqual(result.error, "invalid_skill_identifier");
    });

    it("agent 不存在应该报错", async () => {
      const result = await toolExecutor._executeLoadSkillDetail(
        { ...mockCtx, agent: null },
        { skill: "test" }
      );

      assert.strictEqual(result.error, "agent_not_found");
    });
  });

  describe("forget_skill 工具", () => {
    it("工具定义应该存在", () => {
      const tools = toolExecutor.getToolDefinitions();
      const forgetTool = tools.find(t => t.function?.name === "forget_skill");

      assert.notStrictEqual(forgetTool, undefined);
      assert.strictEqual(forgetTool.function.name, "forget_skill");
      assert.ok(forgetTool.function.parameters.required.includes("skillId"));
      assert.ok(forgetTool.function.description.includes("遗忘"));
    });

    it("应该成功遗忘已学习的技能", async () => {
      const result = await toolExecutor._executeForgetSkill(mockCtx, {
        skillId: "learned-skill"
      });

      assert.strictEqual(result.ok, true);
      assert.ok(result.message.includes("遗忘"));
    });

    it("skillId 为空应该报错", async () => {
      const result = await toolExecutor._executeForgetSkill(mockCtx, {
        skillId: ""
      });

      assert.strictEqual(result.error, "invalid_skill_id");
    });

    it("agent 不存在应该报错", async () => {
      const result = await toolExecutor._executeForgetSkill(
        { ...mockCtx, agent: null },
        { skillId: "test" }
      );

      assert.strictEqual(result.error, "agent_not_found");
    });

    it("遗忘异常时应该返回错误", async () => {
      const result = await toolExecutor._executeForgetSkill(mockCtx, {
        skillId: "forget-error"
      });

      assert.strictEqual(result.error, "forget_skill_failed");
      assert.ok(result.message.includes("遗忘失败"));
    });
  });
});
