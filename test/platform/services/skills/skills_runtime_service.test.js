/**
 * SkillsRuntimeService 测试。
 *
 * 验证技能提示词生成、已学习技能管理、持久化与懒加载。
 *
 * 注意：内容不缓存，每次 _buildLearnedContent 从磁盘实时读取。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { SkillsRuntimeService } from "../../../../src/platform/services/skills/skills_runtime_service.js";
import { makeTestLogger } from "../../../helpers/test_logger.js";

describe("SkillsRuntimeService", () => {
  let service;
  let repository;
  let bindingService;
  let testDir;

  beforeEach(async () => {
    testDir = path.join(import.meta.dirname ?? __dirname, ".tmp_skills_runtime_test");
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });

    repository = {
      async getSkill(skillId) {
        const records = {
          "provider:skill:alpha": {
            displayName: "Alpha Skill",
            description: "负责处理 Alpha 任务",
            installState: "installed"
          },
          "provider:skill:hidden": {
            displayName: "Hidden Skill",
            description: "未启用技能",
            installState: "installed"
          },
          "custom:skill:disabled": {
            displayName: "Disabled Custom Skill",
            description: "已停用的自定义技能",
            installState: "installed",
            sourceType: "custom",
            status: "disabled"
          },
          "provider:skill:beta": {
            displayName: "Beta Skill",
            description: "负责处理 Beta 任务",
            installState: "installed"
          }
        };
        return records[skillId] ?? null;
      },

      /**
       * 模拟读取技能包文件。
       */
      async readSkillFile(skillId, relativePath) {
        const files = {
          "provider:skill:alpha::SYSTEM_PROMPT.md": {
            resolvedPath: `/skills/provider:skill:alpha/${relativePath}`,
            content: "# Alpha System Prompt\n这是 Alpha 的系统提示词。"
          },
          "provider:skill:alpha::SKILL.md": {
            resolvedPath: `/skills/provider:skill:alpha/${relativePath}`,
            content: "# Alpha 技能\n这是 Alpha 的 SKILL.md。"
          },
          "provider:skill:beta::SYSTEM_PROMPT.md": null,
          "provider:skill:beta::SKILL.md": {
            resolvedPath: `/skills/provider:skill:beta/${relativePath}`,
            content: "# Beta 技能\n这是 Beta 的 SKILL.md。"
          },
          "provider:skill:hidden::SYSTEM_PROMPT.md": null,
          "provider:skill:hidden::SKILL.md": null,
          "custom:skill:disabled::SYSTEM_PROMPT.md": null,
          "custom:skill:disabled::SKILL.md": null
        };
        const key = `${skillId}::${relativePath}`;
        return files[key] ?? null;
      }
    };

    bindingService = {
      resolveAgentBindings() {
        return [
          { skillId: "provider:skill:alpha", configuredEnabled: true, source: "agent", roleConfiguredEnabled: true, agentConfiguredEnabled: true },
          { skillId: "provider:skill:hidden", configuredEnabled: false, source: "agent", roleConfiguredEnabled: false, agentConfiguredEnabled: false },
          { skillId: "custom:skill:disabled", configuredEnabled: true, source: "agent", roleConfiguredEnabled: true, agentConfiguredEnabled: true },
          { skillId: "provider:skill:beta", configuredEnabled: true, source: "agent", roleConfiguredEnabled: true, agentConfiguredEnabled: true }
        ];
      }
    };

    service = new SkillsRuntimeService({
      repository,
      bindingService,
      dataDir: testDir,
      logger: makeTestLogger("Skills")
    });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  });

  describe("buildAgentSkillPrompt", () => {
    it("没有可见技能时应该返回空字符串，warnings 为空", async () => {
      bindingService.resolveAgentBindings = () => [];

      const result = await service.buildAgentSkillPrompt("agent-1");

      assert.strictEqual(result.prompt, "");
      assert.deepStrictEqual(result.warnings, []);
    });

    it("应该在提示词中要求优先加载技能详情", async () => {
      const result = await service.buildAgentSkillPrompt("agent-1");

      assert.ok(result.prompt.includes("先调用 load_skill_detail"));
      assert.ok(result.prompt.includes("不要臆造不存在的技能标识"));
    });

    it("应该为每个真实可见技能提供读取 SKILL.md 的调用方式", async () => {
      const result = await service.buildAgentSkillPrompt("agent-1");

      assert.ok(result.prompt.includes("Alpha Skill"));
      assert.ok(result.prompt.includes("provider:skill:alpha"));
      assert.ok(result.prompt.includes('load_skill_detail({ skill: "provider:skill:alpha" })'));
    });

    it("应该只列出当前可见技能", async () => {
      const result = await service.buildAgentSkillPrompt("agent-1");

      assert.ok(!result.prompt.includes("Hidden Skill"));
      assert.ok(!result.prompt.includes("Disabled Custom Skill"));
    });

    it("返回结果应包含 prompt 和 warnings 字段", async () => {
      const result = await service.buildAgentSkillPrompt("agent-1");

      assert.strictEqual(typeof result.prompt, "string");
      assert.ok(Array.isArray(result.warnings));
    });
  });

  describe("markSkillLearned", () => {
    it("buildAgentSkillPrompt 应使用 SYSTEM_PROMPT.md 内容（优先于 SKILL.md）", async () => {
      await service.markSkillLearned("agent-1", "provider:skill:alpha");

      const result = await service.buildAgentSkillPrompt("agent-1");

      // Alpha 有 SYSTEM_PROMPT.md，应出现其内容而非 SKILL.md
      assert.ok(result.prompt.includes("Alpha System Prompt"));
      // 不应该出现 SKILL.md 内容（因为 SYSTEM_PROMPT.md 优先）
      assert.ok(!result.prompt.includes("这是 Alpha 的 SKILL.md"));
    });

    it("无 SYSTEM_PROMPT.md 时应回退到 SKILL.md 内容", async () => {
      await service.markSkillLearned("agent-1", "provider:skill:beta");

      const result = await service.buildAgentSkillPrompt("agent-1");

      assert.ok(result.prompt.includes("Beta 技能"));
    });

    it("已学习技能应该出现在 buildAgentSkillPrompt 中", async () => {
      await service.markSkillLearned("agent-1", "provider:skill:alpha");

      const result = await service.buildAgentSkillPrompt("agent-1");

      assert.ok(result.prompt.includes("【已学习技能 —"));
      assert.ok(result.prompt.includes("【已学习技能结束】"));
      assert.ok(result.prompt.includes("Alpha System Prompt"));
    });

    it("已学习技能应该在可见列表中标注 （已学习）", async () => {
      await service.markSkillLearned("agent-1", "provider:skill:alpha");

      const result = await service.buildAgentSkillPrompt("agent-1");

      assert.ok(result.prompt.includes("（已学习）"));
    });

    it("已存在时应该跳过（不重复记录）", async () => {
      await service.markSkillLearned("agent-1", "provider:skill:alpha");
      await service.markSkillLearned("agent-1", "provider:skill:alpha"); // 重复

      await service._loadLearned("agent-1");
      const skillIds = service._learnedByAgent.get("agent-1");
      assert.strictEqual(skillIds.size, 1);
    });

    it("两者都不存在时应该不记录", async () => {
      await service.markSkillLearned("agent-1", "provider:skill:hidden");

      await service._loadLearned("agent-1");
      const skillIds = service._learnedByAgent.get("agent-1");
      assert.strictEqual(skillIds.size, 0);
    });

    it("内容不缓存：修改 mock 返回值后 buildAgentSkillPrompt 应立即反映新内容", async () => {
      await service.markSkillLearned("agent-1", "provider:skill:beta");

      // 第一次：原始内容
      let result = await service.buildAgentSkillPrompt("agent-1");
      assert.ok(result.prompt.includes("Beta 技能"));

      // 修改 mock 的返回值，模拟用户编辑了 SKILL.md
      repository.readSkillFile = async (skillId, relativePath) => {
        if (skillId === "provider:skill:beta" && relativePath === "SKILL.md") {
          return { content: "# Beta 技能 v2\n这是修改后的内容。" };
        }
        return null;
      };

      // 第二次：应立即反映新内容（无需重启）
      result = await service.buildAgentSkillPrompt("agent-1");
      assert.ok(result.prompt.includes("这是修改后的内容"));
    });
  });

  describe("forgetSkill", () => {
    it("应从 ID 集合中删除技能", async () => {
      await service.markSkillLearned("agent-1", "provider:skill:alpha");
      await service.forgetSkill("agent-1", "provider:skill:alpha");

      await service._loadLearned("agent-1");
      const skillIds = service._learnedByAgent.get("agent-1");
      assert.ok(!skillIds.has("provider:skill:alpha"));
    });

    it("遗忘后不应再出现在 buildAgentSkillPrompt 中", async () => {
      await service.markSkillLearned("agent-1", "provider:skill:alpha");
      await service.forgetSkill("agent-1", "provider:skill:alpha");

      const result = await service.buildAgentSkillPrompt("agent-1");

      assert.ok(!result.prompt.includes("【已学习技能 —"));
      assert.ok(!result.prompt.includes("【已学习技能结束】"));
      assert.ok(!result.prompt.includes("（已学习）"));
    });

    it("未学习时应该静默返回", async () => {
      await service.forgetSkill("agent-1", "provider:skill:never_learned");
    });
  });

  describe("持久化", () => {
    it("markSkillLearned 后应写入 skills.json", async () => {
      await service.markSkillLearned("agent-1", "provider:skill:alpha");

      const filePath = path.join(testDir, "agents", "agent-1", "skills.json");
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);

      assert.ok(Array.isArray(parsed.learnedSkillIds));
      assert.ok(parsed.learnedSkillIds.includes("provider:skill:alpha"));
    });

    it("forgetSkill 后应更新 skills.json", async () => {
      await service.markSkillLearned("agent-1", "provider:skill:alpha");
      await service.forgetSkill("agent-1", "provider:skill:alpha");

      const filePath = path.join(testDir, "agents", "agent-1", "skills.json");
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);

      assert.ok(Array.isArray(parsed.learnedSkillIds));
      assert.strictEqual(parsed.learnedSkillIds.length, 0);
    });

    it("skills.json 不应包含技能内容（只存 ID）", async () => {
      await service.markSkillLearned("agent-1", "provider:skill:alpha");

      const filePath = path.join(testDir, "agents", "agent-1", "skills.json");
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);

      assert.ok(Array.isArray(parsed.learnedSkillIds));
      assert.strictEqual(parsed.learnedSkillIds.length, 1);
      assert.ok(!parsed.contents);
      assert.ok(typeof parsed.learnedSkillIds[0] === "string");
    });

    it("重启后应从 skills.json 重新加载 ID 并实时读内容", async () => {
      await service.markSkillLearned("agent-1", "provider:skill:alpha");

      const newService = new SkillsRuntimeService({
        repository,
        bindingService,
        dataDir: testDir,
        logger: makeTestLogger("Skills-New")
      });

      await newService._loadLearned("agent-1");
      const newSkillIds = newService._learnedByAgent.get("agent-1");
      assert.ok(newSkillIds.has("provider:skill:alpha"));

      // 内容从磁盘实时读取
      const result = await newService.buildAgentSkillPrompt("agent-1");
      assert.ok(result.prompt.includes("Alpha System Prompt"));
    });
  });

  describe("_loadLearned（懒加载）", () => {
    it("首次加载时返回 failedIds 列表（不缓存内容）", async () => {
      const agentDir = path.join(testDir, "agents", "agent-1");
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        path.join(agentDir, "skills.json"),
        JSON.stringify({ learnedSkillIds: ["provider:skill:ghost", "provider:skill:alpha"] }, null, 2),
        "utf-8"
      );

      const newService = new SkillsRuntimeService({
        repository,
        bindingService,
        dataDir: testDir,
        logger: makeTestLogger("Skills")
      });

      const result = await newService._loadLearned("agent-1");

      assert.ok(Array.isArray(result.failedIds));
      assert.ok(result.failedIds.includes("provider:skill:ghost"));

      // alpha 应该成功注册（只是 ID，不缓存内容）
      const skillIds = newService._learnedByAgent.get("agent-1");
      assert.ok(skillIds.has("provider:skill:alpha"));

      // ghost 应该已被剔除
      const filePath = path.join(testDir, "agents", "agent-1", "skills.json");
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      assert.ok(!parsed.learnedSkillIds.includes("provider:skill:ghost"));
    });

    it("已加载时应该直接返回（缓存命中，跳过后继验证）", async () => {
      await service._loadLearned("agent-1");

      const result = await service._loadLearned("agent-1");

      assert.deepStrictEqual(result.failedIds, []);
    });
  });
});
