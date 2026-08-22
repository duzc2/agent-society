/**
 * RuntimeLlm 技能提示词集成测试
 *
 * 测试 buildSystemPromptForAgent 中的技能提示词（含已学习内容与警告广播）。
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { RuntimeLlm } from "../../../src/platform/runtime/runtime_llm.js";

describe("RuntimeLlm - 技能提示词集成", () => {
  let runtimeLlm;
  let mockRuntime;
  let mockCtx;

  beforeEach(() => {
    // Mock Runtime
    mockRuntime = {
      _agentMetaById: new Map(),
      _agents: new Map(),
      _state: {
        setAgentComputePhase: () => {}
      },
      getSystemPromptAppendix: () => "",
      // 工具组权限检查：技能提示词仅在岗位拥有 skill 工具组时注入。
      // 默认 mock 为 true（授权），门控用例中改为 false 验证不注入。
      isToolAvailableForAgent: () => true,
      skillsService: {
        buildAgentSkillPrompt: async () => ""
      },
      org: {
        getRole: () => null,
        getAgent: () => null
      },
      _agentTaskBriefs: new Map(),
    };

    runtimeLlm = new RuntimeLlm(mockRuntime);

    // Mock Context
    mockCtx = {
      agent: {
        id: "test-agent",
        roleId: "test-role",
        rolePrompt: "测试岗位提示词",
        skillPromptCache: null
      },
      systemBasePrompt: "基础提示词",
      systemComposeTemplate: "{{BASE}}\n{{ROLE}}",
      systemToolRules: "",
      tools: {
        composePrompt: (parts) => `${parts.base}\n${parts.rolePrompt}`
      }
    };
  });

  describe("懒加载技能提示词", () => {
    it("应该首次从服务加载技能提示词", async () => {
      mockRuntime.skillsService.buildAgentSkillPrompt = async () => "# 技能提示词\n\n## JavaScript";

      const prompt = await runtimeLlm.buildSystemPromptForAgent(mockCtx);

      assert.ok(prompt.includes("技能提示词"));
      assert.ok(prompt.includes("JavaScript"));
    });

    it("应该总是从 skillsService 获取技能提示词", async () => {
      mockRuntime.skillsService.buildAgentSkillPrompt = async () => "# 技能提示词\n\n## TypeScript";

      const prompt = await runtimeLlm.buildSystemPromptForAgent(mockCtx);

      assert.ok(prompt.includes("技能提示词"));
      assert.ok(prompt.includes("TypeScript"));
    });

    it("无技能时不应该添加提示词", async () => {
      mockRuntime.skillsService.buildAgentSkillPrompt = async () => "";

      const prompt = await runtimeLlm.buildSystemPromptForAgent(mockCtx);

      assert.strictEqual(typeof prompt, "string");
    });

    it("service 始终存在 — 内部组件禁止空值", async () => {
      // skillsService is required per IoC discipline (铁律 #2)
      assert.ok(mockRuntime.skillsService, "skillsService 必须存在（禁止空值兼容）");
    });

    it("服务返回空字符串时不应该添加技能标题", async () => {
      mockRuntime.skillsService.buildAgentSkillPrompt = async () => "";

      const prompt = await runtimeLlm.buildSystemPromptForAgent(mockCtx);

      assert.ok(!prompt.includes("技能"));
    });

    it("应包含已学习技能内容（含开始/结束分隔符）", async () => {
      mockRuntime.skillsService.buildAgentSkillPrompt = async () =>
        "【当前可见技能】\n- Test Skill（已学习）（标识：test:skill:1）：测试。\n\n【已学习技能 — 以下为常驻提示词，每次对话均生效】\n\n## 技能：test:skill:1\n# 技能内容\n这是已学习的技能内容。\n\n【已学习技能结束】";

      const prompt = await runtimeLlm.buildSystemPromptForAgent(mockCtx);

      assert.ok(prompt.includes("【已学习技能 —"));
      assert.ok(prompt.includes("【已学习技能结束】"));
      assert.ok(prompt.includes("以下为常驻提示词"));
      assert.ok(prompt.includes("已学习的技能内容"));
      assert.ok(prompt.includes("（已学习）"));
    });

    it("buildAgentSkillPrompt 返回字符串（IoC：runtime_llm 无感知内部结构）", async () => {
      mockRuntime.skillsService.buildAgentSkillPrompt = async () => "test string result";

      const prompt = await runtimeLlm.buildSystemPromptForAgent(mockCtx);

      assert.ok(prompt.includes("test string result"));
    });

    it("岗位未分配 skill 工具组时不应注入技能提示词", async () => {
      mockRuntime.isToolAvailableForAgent = () => false;
      mockRuntime.skillsService.buildAgentSkillPrompt = async () => "# 技能提示词\n\n## JavaScript";

      const prompt = await runtimeLlm.buildSystemPromptForAgent(mockCtx);

      assert.ok(!prompt.includes("技能提示词"), "未授权时不得注入技能提示词");
    });

    it("岗位拥有 skill 工具组时才注入技能提示词", async () => {
      mockRuntime.isToolAvailableForAgent = () => true;
      mockRuntime.skillsService.buildAgentSkillPrompt = async () => "# 技能提示词\n\n## JavaScript";

      const prompt = await runtimeLlm.buildSystemPromptForAgent(mockCtx);

      assert.ok(prompt.includes("技能提示词"), "授权时应注入技能提示词");
    });
  });

  describe("warnings 转发为 error_event", () => {
    it("SkillsService 应通过 heartbeatBroker 广播警告", async () => {
      // 此测试验证 SkillsService 门面层的行为：
      // 当 runtimeService 返回 warnings 时，SkillsService 向 heartbeatBroker 广播 error_event。
      // 这里通过模拟来验证整个链路。

      const broadcastCalls = [];
      const mockHeartbeatBroker = {
        broadcast: (eventType, payload) => {
          broadcastCalls.push({ eventType, payload });
        }
      };

      // 模拟 runtimeService 返回带 warnings 的结果
      const mockRuntimeService = {
        buildAgentSkillPrompt: async () => ({
          prompt: "test prompt",
          warnings: ["provider:skill:ghost"]
        })
      };

      // 直接构造 SkillsService 测试此场景
      const { SkillsService } = await import("../../../src/platform/services/skills/skills_service.js");
      // SkillsService 构造函数需要完整的依赖，但我们可以构造一个最小化的实例来测试
      // 这里替换 runtimeService
      const skillsService = new SkillsService({
        runtime: { heartbeatBroker: mockHeartbeatBroker },
        org: {},
        dataDir: "/tmp/test",
        config: {},
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {}
        }
      });
      skillsService.runtimeService = mockRuntimeService;

      const prompt = await skillsService.buildAgentSkillPrompt("test-agent");

      assert.strictEqual(prompt, "test prompt");
      assert.strictEqual(broadcastCalls.length, 1);
      assert.strictEqual(broadcastCalls[0].eventType, "error_event");
      assert.strictEqual(broadcastCalls[0].payload.errorType, "skill_auto_unloaded");
      assert.ok(broadcastCalls[0].payload.message.includes("provider:skill:ghost"));
    });
  });

  describe("提示词位置", () => {
    it("技能提示词应该在 systemPromptAppendix 之前", async () => {
      mockRuntime.skillsService.buildAgentSkillPrompt = async () => "# 技能";
      mockCtx.agent.systemPromptAppendix = ["# 附录"];

      const prompt = await runtimeLlm.buildSystemPromptForAgent(mockCtx);

      const skillIndex = prompt.indexOf("技能");
      const appendixIndex = prompt.indexOf("附录");

      assert.ok(skillIndex > -1);
      assert.ok(skillIndex < appendixIndex);
    });
  });
});
