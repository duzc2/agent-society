import { describe, it } from "node:test";
import assert from "node:assert";
import { RuntimeTools } from "../../../src/platform/runtime/runtime_tools.js";

describe("RuntimeTools - 模型能力工具定义刷新", () => {
  it("应使用最新的 call_image_model 参数定义覆盖工具组中的旧定义", () => {
    const staleImageTool = {
      type: "function",
      function: {
        name: "call_image_model",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string" }
          },
          required: ["prompt"]
        }
      }
    };
    const freshImageTool = {
      type: "function",
      function: {
        name: "call_image_model",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            size: { type: "string" },
            quality: { type: "string", description: "生成图像质量" },
            watermark_enabled: { type: "boolean", description: "控制是否添加水印" }
          },
          required: ["prompt"]
        }
      }
    };

    const runtime = {
      _agentMetaById: new Map([["agent-1", { roleId: "role-1" }]]),
      org: {
        getRole: () => ({ toolGroups: ["model_capability"] })
      },
      toolGroupManager: {
        getToolDefinitions: () => [staleImageTool],
        getAllGroupIds: () => ["model_capability"]
      },
      moduleLoader: {
        getToolDefinitions: () => [],
        hasToolName: () => false
      },
      _toolExecutor: {
        getToolDefinitions: () => [freshImageTool]
      }
    };

    const runtimeTools = new RuntimeTools(runtime);
    const defs = runtimeTools.getToolDefinitionsForAgent("agent-1");
    const imageTool = defs.find((item) => item?.function?.name === "call_image_model");

    assert.ok(imageTool);
    assert.ok(imageTool.function.parameters.properties.quality);
    assert.ok(imageTool.function.parameters.properties.watermark_enabled);
    assert.ok(imageTool.function.parameters.properties.quality.description.includes("生成图像质量"));
  });
});
