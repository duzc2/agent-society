import { describe, it } from "node:test";
import assert from "node:assert";
import { RuntimeLlm } from "../../../src/platform/runtime/runtime_llm.js";
import { makeTestLogger } from "../../helpers/test_logger.js";

// mock.fn polyfill for node:test compatibility with bun
function mockFn(impl) {
  const calls = [];
  const fn = (...args) => { calls.push({ arguments: args }); return impl ? impl(...args) : undefined; };
  fn.mock = { calls, resetCalls: () => { calls.length = 0; }, callCount: () => calls.length };
  return fn;
}

describe("RuntimeLlm - tool prompt handling", () => {
  it("should include parameter summaries for model_capability tool groups", () => {
    const runtime = {
      toolGroupManager: {
        listGroups: () => [{
          id: "model_capability",
          description: "model tools",
          tools: ["call_image_model"]
        }],
        getToolDefinitions: () => [{
          type: "function",
          function: {
            name: "call_image_model",
            parameters: {
              type: "object",
              properties: {
                prompt: { type: "string", description: "prompt text" },
                size: { type: "string", description: "image size" },
                quality: { type: "string", description: "image quality" },
                watermark_enabled: { type: "boolean", description: "watermark toggle" }
              },
              required: ["prompt"]
            }
          }
        }]
      }
    };
    const runtimeLlm = new RuntimeLlm(runtime);

    const text = runtimeLlm.formatToolGroupsInfo();

    assert.ok(text.includes("call_image_model"));
    assert.ok(text.includes("prompt(\u5fc5\u586b)"));
    assert.ok(text.includes("size"));
    assert.ok(text.includes("quality"));
    assert.ok(text.includes("watermark_enabled"));
    assert.ok(text.includes("image quality"));
  });

  it("root prompt should replace embedded legacy tool group content", async () => {
    const runtime = {
      _state: { setAgentComputePhase: () => {} },
      _agentMetaById: new Map(),
      getSystemPromptAppendix: () => "",
      toolGroupManager: {
        listGroups: () => [{
          id: "model_capability",
          description: "model tools",
          tools: ["call_image_model"]
        }],
        getToolDefinitions: () => [{
          type: "function",
          function: {
            name: "call_image_model",
            parameters: {
              type: "object",
              properties: {
                prompt: { type: "string", description: "prompt text" },
                quality: { type: "string", description: "image quality" }
              },
              required: ["prompt"]
            }
          }
        }]
      }
    };
    const runtimeLlm = new RuntimeLlm(runtime);
    const ctx = {
      agent: {
        id: "root",
        rolePrompt: "you are root\\n\\n\u3010\u53ef\u7528\u5de5\u5177\u7ec4\u5217\u8868\u3011\\n- model_capability: legacy content"
      }
    };

    const prompt = await runtimeLlm.buildSystemPromptForAgent(ctx);

    assert.ok(prompt.includes("\u53c2\u6570\u8bf4\u660e"));
    assert.ok(prompt.includes("prompt(\u5fc5\u586b)"));
    assert.ok(prompt.includes("quality"));
    assert.ok(!prompt.includes("legacy content"));
  });

  it("unsupported models should keep role prompt first and retain required plain-text sections", async () => {
    const runtime = {
      _state: { setAgentComputePhase: () => {} },
      _agentMetaById: new Map([["agent-1", { parentAgentId: "root" }]]),
      getSystemPromptAppendix: () => "\\n\\nMODULE_APPENDIX",
      toolGroupManager: {
        listGroups: () => [],
        getToolDefinitions: () => []
      },
      org: {
        getRole: () => ({ orgPrompt: "ORG_PROMPT" })
      },
      _agentTaskBriefs: new Map(),

      skillsService: { buildAgentSkillPrompt: async () => "" },
      log: makeTestLogger("RuntimeLLM")
    };
    const runtimeLlm = new RuntimeLlm(runtime);
    runtimeLlm._buildMemoryContext = async () => "\\n\\nMEMORY_CONTEXT";
    const composePrompt = mockFn(() => "COMPOSED_PROMPT");

    const ctx = {
      agent: {
        id: "agent-1",
        roleId: "role-1",
        rolePrompt: "ROLE_PROMPT",
        name: "Alice",
        skillPromptCache: "",
        systemPromptAppendix: ["AGENT_APPENDIX"]
      },
      systemBasePrompt: "BASE_PROMPT",
      systemComposeTemplate: "{{BASE}}\\n{{ROLE}}\\n{{TASK}}",
      systemToolRules: "TOOL_RULES",
      systemWorkspacePrompt: "WORKSPACE_PROMPT",
      tools: {
        composePrompt
      }
    };
    const llmClient = {
      _clientConfig: {
        capabilities: {
          output: ["text"]
        }
      }
    };

    const prompt = await runtimeLlm.buildSystemPromptForAgent(ctx, llmClient);

    assert.strictEqual(composePrompt.mock.callCount(), 0);
    assert.strictEqual(prompt.startsWith("ROLE_PROMPT"), true);
    assert.ok(prompt.includes("ROLE_PROMPT"));
    assert.ok(prompt.includes("Alice"));
    assert.ok(prompt.includes("ORG_PROMPT"));
    assert.ok(!prompt.includes("BASE_PROMPT"));
    assert.ok(!prompt.includes("WORKSPACE_PROMPT"));
    assert.ok(!prompt.includes("agentId=agent-1"));
    assert.ok(!prompt.includes("MODULE_APPENDIX"));
    assert.ok(prompt.includes("AGENT_APPENDIX"));
    assert.ok(!prompt.includes("MEMORY_CONTEXT"));
    assert.ok(!prompt.includes("TOOL_RULES"));
  });

  it("supported models should still include workspace prompt", async () => {
    const runtime = {
      _state: { setAgentComputePhase: () => {} },
      _agentMetaById: new Map([["agent-1", { parentAgentId: "root" }]]),
      getSystemPromptAppendix: () => "",
      toolGroupManager: {
        listGroups: () => [],
        getToolDefinitions: () => []
      },
      org: {
        getRole: () => ({ orgPrompt: "ORG_PROMPT" })
      },
      _agentTaskBriefs: new Map(),

      skillsService: { buildAgentSkillPrompt: async () => "" },
      log: makeTestLogger("RuntimeLLM")
    };
    const runtimeLlm = new RuntimeLlm(runtime);
    runtimeLlm._buildMemoryContext = async () => null;

    const ctx = {
      agent: {
        id: "agent-1",
        roleId: "role-1",
        rolePrompt: "ROLE_PROMPT",
        name: "Alice",
        skillPromptCache: ""
      },
      systemBasePrompt: "BASE_PROMPT",
      systemComposeTemplate: "{{BASE}}\n{{ROLE}}\n{{TASK}}",
      systemToolRules: "TOOL_RULES",
      systemWorkspacePrompt: "WORKSPACE_PROMPT",
      tools: {
        composePrompt: ({ base, rolePrompt, workspace }) => `${base}\n${rolePrompt}\n${workspace}`
      }
    };
    const llmClient = {
      _clientConfig: {
        capabilities: {
          output: ["text", "tool_calling"]
        }
      }
    };

    const prompt = await runtimeLlm.buildSystemPromptForAgent(ctx, llmClient);

    assert.ok(prompt.includes("WORKSPACE_PROMPT"));
    assert.ok(prompt.includes("TOOL_RULES"));
  });

  it("should recursively inherit orgPrompt from ancestor roles for supported models", async () => {
    const runtime = {
      _state: { setAgentComputePhase: () => {} },
      _agentMetaById: new Map([
        ["agent-1", { roleId: "role-1", parentAgentId: "agent-parent" }],
        ["agent-parent", { roleId: "role-parent", parentAgentId: "agent-root-child" }],
        ["agent-root-child", { roleId: "role-root-child", parentAgentId: "root" }]
      ]),
      getSystemPromptAppendix: () => "",
      toolGroupManager: {
        listGroups: () => [],
        getToolDefinitions: () => []
      },
      org: {
        getRole: (roleId) => {
          if (roleId === "role-1") return { orgPrompt: "" };
          if (roleId === "role-parent") return { orgPrompt: "PARENT_ORG_PROMPT" };
          if (roleId === "role-root-child") return { orgPrompt: "" };
          return null;
        }
      },
      _agentTaskBriefs: new Map(),

      skillsService: { buildAgentSkillPrompt: async () => "" },
      log: makeTestLogger("RuntimeLLM")
    };
    const runtimeLlm = new RuntimeLlm(runtime);

    const ctx = {
      agent: {
        id: "agent-1",
        roleId: "role-1",
        rolePrompt: "ROLE_PROMPT",
        name: "Alice",
        skillPromptCache: ""
      },
      systemBasePrompt: "BASE_PROMPT",
      systemComposeTemplate: "{{BASE}}\n{{ROLE}}\n{{TASK}}",
      systemToolRules: "TOOL_RULES",
      systemWorkspacePrompt: "WORKSPACE_PROMPT",
      tools: {
        composePrompt: ({ base, rolePrompt, workspace }) => `${base}\n${rolePrompt}\n${workspace}`
      }
    };
    const llmClient = {
      _clientConfig: {
        capabilities: {
          output: ["text", "tool_calling"]
        }
      }
    };

    const prompt = await runtimeLlm.buildSystemPromptForAgent(ctx, llmClient);

    assert.ok(prompt.includes("PARENT_ORG_PROMPT"));
  });

  it("should stop orgPrompt lookup at root and return null when ancestors are empty", () => {
    const runtime = {
      _agentMetaById: new Map([
        ["agent-1", { roleId: "role-1", parentAgentId: "agent-parent" }],
        ["agent-parent", { roleId: "role-parent", parentAgentId: "root" }]
      ]),
      org: {
        getRole: (roleId) => {
          if (roleId === "role-1") return { orgPrompt: "   " };
          if (roleId === "role-parent") return { orgPrompt: "" };
          return null;
        }
      }
    };
    const runtimeLlm = new RuntimeLlm(runtime);

    const orgPrompt = runtimeLlm._resolveOrgPromptForAgent({
      id: "agent-1",
      roleId: "role-1"
    });

    assert.strictEqual(orgPrompt, null);
  });

  it("unsupported models should recursively inherit orgPrompt from ancestor roles", async () => {
    const runtime = {
      _state: { setAgentComputePhase: () => {} },
      _agentMetaById: new Map([
        ["agent-1", { roleId: "role-1", parentAgentId: "agent-parent" }],
        ["agent-parent", { roleId: "role-parent", parentAgentId: "root" }]
      ]),
      getSystemPromptAppendix: () => "",
      toolGroupManager: {
        listGroups: () => [],
        getToolDefinitions: () => []
      },
      org: {
        getRole: (roleId) => {
          if (roleId === "role-1") return { orgPrompt: "" };
          if (roleId === "role-parent") return { orgPrompt: "PARENT_ORG_PROMPT" };
          return null;
        }
      },
      _agentTaskBriefs: new Map(),

      skillsService: { buildAgentSkillPrompt: async () => "" },
      log: makeTestLogger("RuntimeLLM")
    };
    const runtimeLlm = new RuntimeLlm(runtime);

    const ctx = {
      agent: {
        id: "agent-1",
        roleId: "role-1",
        rolePrompt: "ROLE_PROMPT",
        name: "Alice",
        skillPromptCache: "",
        systemPromptAppendix: []
      },
      tools: {
        composePrompt: () => "COMPOSED_PROMPT"
      }
    };
    const llmClient = {
      _clientConfig: {
        capabilities: {
          output: ["text"]
        }
      }
    };

    const prompt = await runtimeLlm.buildSystemPromptForAgent(ctx, llmClient);

    assert.ok(prompt.includes("PARENT_ORG_PROMPT"));
  });

  it("should NOT inject memory into formatted messages (formatMessageForLlm is now format-only)", async () => {
    const runtime = {
      _state: { setAgentComputePhase: () => {} },
      _agents: new Map(),
      _agentMetaById: new Map(),
      log: makeTestLogger("RuntimeLLM")
    };
    const runtimeLlm = new RuntimeLlm(runtime);

    const ctx = {
      agent: {
        id: "agent-1"
      }
    };
    const message = {
      from: "user",
      payload: {
        text: "hello"
      }
    };

    const formatted = await runtimeLlm.formatMessageForLlm(ctx, message);

    // 验证 formatMessageForLlm 只做消息格式化，不注入 memory 或 trailing text
    assert.strictEqual(typeof formatted, "string");
    assert.ok(formatted === "hello" || formatted.startsWith("hello") || formatted.includes("hello"));
    assert.ok(!formatted.includes("MEMORY_CONTEXT"));
    assert.ok(!formatted.includes("CONTEXT_STATUS"));
  });

  it("should append memory to plain text via appendEphemeralToMessages", () => {
    const runtime = {
      _state: { setAgentComputePhase: () => {} },
      _agents: new Map(),
      _agentMetaById: new Map(),
      log: makeTestLogger("RuntimeLLM")
    };
    const runtimeLlm = new RuntimeLlm(runtime);

    const messages = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" }
    ];
    const memoryContext = "\n\nMEMORY_CONTEXT";

    const { messages: enhanced } = runtimeLlm.appendEphemeralToMessages(messages, memoryContext);

    // 原始 messages 不应被修改
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[1].content, "hello");
    // 增强副本应在最后一条 user 消息之前插入独立的记忆消息
    assert.strictEqual(enhanced.length, 3);
    assert.strictEqual(enhanced[1].role, "user");
    assert.strictEqual(enhanced[1].content, "MEMORY_CONTEXT");
    // 原始 user 消息现在在 index 2
    assert.strictEqual(enhanced[2].role, "user");
    assert.strictEqual(enhanced[2].content, "hello");
  });

  it("should append memory as the last element of multimodal content via appendEphemeralToMessages", () => {
    const runtime = {
      _state: { setAgentComputePhase: () => {} },
      _agents: new Map(),
      _agentMetaById: new Map(),
      log: makeTestLogger("RuntimeLLM")
    };
    const runtimeLlm = new RuntimeLlm(runtime);

    const multimodalContent = [
      { type: "text", text: "hello" },
      { type: "image_url", image_url: { url: "data:image/png;base64,xxx" } }
    ];
    const messages = [
      { role: "system", content: "system prompt" },
      { role: "user", content: multimodalContent }
    ];
    const memoryContext = "\n\nMEMORY_CONTEXT";

    const { messages: enhanced } = runtimeLlm.appendEphemeralToMessages(messages, memoryContext);

    // 原始 messages 不应被修改
    assert.strictEqual(messages[1].content.length, 2);
    // 增强副本：index 1 是记忆上下文消息（独立 user message），index 2 是原始多模态消息
    assert.strictEqual(enhanced.length, 3);
    assert.strictEqual(enhanced[1].role, "user");
    assert.strictEqual(enhanced[1].content, "MEMORY_CONTEXT");
    // 原始多模态消息内容不变
    const originalContent = enhanced[2].content;
    assert.strictEqual(Array.isArray(originalContent), true);
    assert.strictEqual(originalContent.length, 2);
    assert.deepStrictEqual(originalContent[0], { type: "text", text: "hello" });
  });

  it("should pass the current message text as recall query via buildEphemeralContexts", async () => {
    let receivedRecallOptions = null;
    const runtime = {
      _state: { setAgentComputePhase: () => {} },
      _agents: new Map(),
      _agentMetaById: new Map(),
      org: {
        getRole: () => ({ agentMemoryEnabled: true })
      },
      agentMemoryManager: {
        config: {
          recall: {
            limit: 3,
            minConfidence: 0.5
          }
        },
        getOrCreateMemory: async () => ({
          recall: async (options) => {
            receivedRecallOptions = options;
            return [{
              type: "text",
              content: "history hit",
              confidence: 0.9
            }];
          }
        })
      },
      log: makeTestLogger("RuntimeLLM")
    };
    const runtimeLlm = new RuntimeLlm(runtime);

    const ctx = {
      agent: {
        id: "agent-1"
      }
    };
    const message = {
      from: "user",
      payload: {
        text: "server test failed"
      }
    };

    const memoryContext = await runtimeLlm.buildEphemeralContexts(ctx, message);

    assert.ok(receivedRecallOptions);
    assert.strictEqual(receivedRecallOptions.query, "server test failed");
    assert.strictEqual(typeof memoryContext, "string");
    assert.ok(memoryContext.includes("history hit"));
  });
});
