import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { ToolExecutor } from "../../../src/platform/runtime/tool_executor.js";
import { makeTestLogger } from "../../helpers/test_logger.js";
import { _setTestWorkspaceManager, _resetWorkspaceManager } from "../../../src/platform/services/workspace/workspace_manager.js";

describe("工具执行器 - 模型能力工具", () => {
  let runtime;
  let toolExecutor;
  let workspace;

  beforeEach(() => {
    workspace = {
      getFileInfo: async () => ({ size: 12, mimeType: "image/jpeg" }),
      readFile: async () => ({ content: "ZmFrZV9pbWFnZQ==" }),
      writeFile: async () => ({ size: 12, mimeType: "image/png" })
    };
    _setTestWorkspaceManager({
      getWorkspace: async () => workspace,
      createDirectory: async () => ({ ok: true, existed: false }),
      checkWorkspaceExists: () => true,
      writeFile: async () => ({ size: 12, mimeType: "image/png" }),
      bindWorkspace: async () => ({ ok: true }),
      getWorkspacePath: (id) => `/tmp/workspaces/${id}`,
      hasWorkspace: () => true,
    });
    runtime = {
      _llmServicesSnapshot: [
        {
          id: "vision-a",
          name: "视觉模型A",
          model: "glm-vision-a",
          description: "视觉理解模型A",
          capabilityTags: ["视觉理解"],
          capabilities: {
            input: ["text", "vision"],
            output: ["text"]
          }
        },
        {
          id: "vision-b",
          name: "视觉模型B",
          model: "glm-vision-b",
          description: "视觉理解模型B",
          capabilityTags: ["视觉理解"],
          capabilities: {
            input: ["text", "vision"],
            output: ["text"]
          }
        }
      ],
      log: makeTestLogger("ToolExecutor"),
      moduleLoader: {
        getToolDefinitions: () => [],
        hasToolName: () => false
      },
      findWorkspaceIdForAgent: () => "ws-1",
      getLlmClientForService: async () => null
    };
    toolExecutor = new ToolExecutor(runtime);
  });

  it("应按能力生成工具定义并包含模型描述", () => {
    const defs = toolExecutor.getToolDefinitions();
    const visionTool = defs.find((item) => item?.function?.name === "call_vision_model");
    assert.ok(visionTool);
    assert.ok(visionTool.function.description.includes("vision-a"));
    assert.ok(visionTool.function.description.includes("视觉模型B"));
    assert.deepStrictEqual(visionTool.function.parameters.properties.serviceId.enum, ["vision-a", "vision-b"]);
  });

  it("执行能力工具时应按 serviceId 选择模型", async () => {
    let selectedServiceId = null;
    runtime.getLlmClientForService = async (serviceId) => {
      selectedServiceId = serviceId;
      return {
        chat: async () => ({
          content: "ok",
          tool_calls: [],
          _usage: { totalTokens: 12 }
        })
      };
    };

    const result = await toolExecutor.executeToolCall(
      { agent: { id: "agent-1" } },
      "call_vision_model",
      { prompt: "请描述图像", serviceId: "vision-b" }
    );

    assert.strictEqual(selectedServiceId, "vision-b");
    assert.strictEqual(result.content, "ok");
    assert.strictEqual(result.totalTokens, 12);
  });

  it("应兼容 image_path 参数并注入图片内容", async () => {
    let capturedMessages = null;
    runtime.getLlmClientForService = async () => ({
      chat: async (input) => {
        capturedMessages = input.messages;
        return { content: "ok", tool_calls: [], _usage: null };
      }
    });

    await toolExecutor.executeToolCall(
      { agent: { id: "agent-1" } },
      "call_vision_model",
      { prompt: "描述图片", image_path: "1.jpg", serviceId: "vision-a" }
    );

    assert.strictEqual(Array.isArray(capturedMessages), true);
    assert.strictEqual(Array.isArray(capturedMessages[0].content), true);
    assert.strictEqual(capturedMessages[0].content[1].type, "image");
    assert.strictEqual(capturedMessages[0].content[1].mediaType, "image/jpeg");
    assert.ok(capturedMessages[0].content[1].image instanceof Uint8Array);
  });

  it("应兼容 question 字段作为提示词", async () => {
    let capturedMessages = null;
    runtime.getLlmClientForService = async () => ({
      chat: async (input) => {
        capturedMessages = input.messages;
        return { content: "ok", tool_calls: [], _usage: null };
      }
    });

    await toolExecutor.executeToolCall(
      { agent: { id: "agent-1" } },
      "call_vision_model",
      { question: "请描述图片", image_path: "1.jpg", serviceId: "vision-a" }
    );

    assert.strictEqual(capturedMessages[0].content[0].type, "text");
    assert.strictEqual(capturedMessages[0].content[0].text, "请描述图片");
  });

  it("应兼容 image 字段作为图片路径", async () => {
    let capturedMessages = null;
    runtime.getLlmClientForService = async () => ({
      chat: async (input) => {
        capturedMessages = input.messages;
        return { content: "ok", tool_calls: [], _usage: null };
      }
    });

    await toolExecutor.executeToolCall(
      { agent: { id: "agent-1" } },
      "call_vision_model",
      { prompt: "描述图片", image: "1.jpg", serviceId: "vision-a" }
    );

    assert.strictEqual(Array.isArray(capturedMessages[0].content), true);
    assert.strictEqual(capturedMessages[0].content[1].type, "image");
  });

  it("应将多种根路径写法规范化为工作区相对路径", async () => {
    const readPaths = [];
    _setTestWorkspaceManager({
      getWorkspace: async () => ({
        getFileInfo: async () => ({ size: 12, mimeType: "image/jpeg" }),
        readFile: async (filePath) => {
          readPaths.push(filePath);
          return { content: "ZmFrZV9pbWFnZQ==" };
        }
      })
    });
    runtime.getLlmClientForService = async () => ({
      chat: async () => ({ content: "ok", tool_calls: [], _usage: null })
    });

    await toolExecutor.executeToolCall(
      { agent: { id: "agent-1" } },
      "call_vision_model",
      { prompt: "描述图片", image: "/1.jpg", serviceId: "vision-a" }
    );

    assert.strictEqual(readPaths[0], "1.jpg");
    assert.strictEqual(readPaths[1], "1.jpg");
  });

  it("找不到指定路径时应在工作区根路径内按文件名搜索", async () => {
    const readPaths = [];
    _setTestWorkspaceManager({
      getWorkspace: async () => ({
        getFileInfo: async (filePath) => ({ size: 12, mimeType: "image/jpeg", path: filePath }),
        readFile: async (filePath, options) => {
          readPaths.push(filePath);
          if (filePath === "1.jpg" && options?.length === 1) {
            throw new Error("file_not_found");
          }
          if (filePath === "images/1.jpg") {
            return { content: "ZmFrZV9pbWFnZQ==" };
          }
          if (filePath === "1.jpg") {
            throw new Error("file_not_found");
          }
          return { content: "ZmFrZV9pbWFnZQ==" };
        },
        listFiles: async (subDir) => {
          if (subDir === ".") {
            return [{ name: "images", type: "directory" }];
          }
          if (subDir === "images") {
            return [{ name: "1.jpg" }];
          }
          return [];
        }
      })
    });
    runtime.getLlmClientForService = async () => ({
      chat: async () => ({ content: "ok", tool_calls: [], _usage: null })
    });

    await toolExecutor.executeToolCall(
      { agent: { id: "agent-1" } },
      "call_vision_model",
      { prompt: "描述图片", image: "./1.jpg", serviceId: "vision-a" }
    );

    assert.ok(readPaths.includes("1.jpg"));
    assert.ok(readPaths.includes("images/1.jpg"));
  });

  it("应基于 capabilityTags 的 image 生成绘图工具", () => {
    runtime._llmServicesSnapshot.push({
      id: "image-gen",
      name: "绘图模型",
      model: "glm-image",
      description: "文字生成图片",
      capabilityTags: ["image"],
      capabilities: {
        input: ["text"],
        output: ["text"]
      }
    });
    const defs = toolExecutor.getToolDefinitions();
    const imageTool = defs.find((item) => item?.function?.name === "call_image_model");
    assert.ok(imageTool);
    assert.ok(imageTool.function.parameters.properties.prompt);
    assert.ok(imageTool.function.parameters.properties.size);
    assert.ok(imageTool.function.parameters.properties.quality);
    assert.ok(imageTool.function.parameters.properties.watermark_enabled);
  });

  it("执行 call_image_model 时应返回标准文件格式与 totalTokens", async () => {
    runtime._llmServicesSnapshot.push({
      id: "image-gen",
      name: "绘图模型",
      model: "glm-image",
      baseURL: "https://example.com/v1",
      apiKey: "k",
      description: "文字生成图片",
      capabilityTags: ["image"],
      capabilities: {
        input: ["text"],
        output: ["text"]
      }
    });
    let capturedPayload = null;
    toolExecutor.modelTools._requestImageGeneration = async (_service, payload) => {
      capturedPayload = payload;
      return {
      data: [{ url: "https://img.example.com/1.png" }],
      usage: { total_tokens: 66 }
      };
    };
    toolExecutor.modelTools._extractImageBinaryFromGenerationResponse = async () => ({
      buffer: Buffer.from("fake"),
      mimeType: "image/png",
      extension: "png"
    });
    let writtenPath = null;
    workspace.writeFile = async (relativePath) => {
      writtenPath = relativePath;
      return { size: 4, mimeType: "image/png" };
    };

    const result = await toolExecutor.executeToolCall(
      { agent: { id: "agent-1" }, currentMessage: { id: "m1" } },
      "call_image_model",
      { prompt: "一只猫", serviceId: "image-gen", size: "1024x1024", path: "output/cat.png" }
    );

    assert.deepStrictEqual(result, {
      ok: true,
      files: [{ path: "output/cat.png", size: 4, mimeType: "image/png" }],
      totalTokens: 66
    });
    assert.strictEqual(writtenPath, "output/cat.png");
    assert.strictEqual(capturedPayload.size, "1024x1024");
    assert.strictEqual(capturedPayload.quality, "hd");
    assert.strictEqual(capturedPayload.watermark_enabled, true);
  });

  it("未传 path 时应使用默认目录与日期时间随机命名", async () => {
    runtime._llmServicesSnapshot.push({
      id: "image-gen",
      name: "绘图模型",
      model: "glm-image",
      baseURL: "https://example.com/v1",
      apiKey: "k",
      description: "文字生成图片",
      capabilityTags: ["image"],
      capabilities: {
        input: ["text"],
        output: ["text"]
      }
    });
    toolExecutor.modelTools._requestImageGeneration = async () => ({ data: [{ b64_json: "ZmFrZQ==" }] });
    toolExecutor.modelTools._extractImageBinaryFromGenerationResponse = async () => ({
      buffer: Buffer.from("fake"),
      mimeType: "image/png",
      extension: "png"
    });
    let writtenPath = null;
    workspace.writeFile = async (relativePath) => {
      writtenPath = relativePath;
      return { size: 4, mimeType: "image/png" };
    };

    const result = await toolExecutor.executeToolCall(
      { agent: { id: "agent-1" }, currentMessage: { id: "m1" } },
      "call_image_model",
      { prompt: "一只猫", serviceId: "image-gen" }
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(Array.isArray(result.files), true);
    assert.match(result.files[0].path, /^generated\/images\/\d{8}\/\d{6}-\d{4}\.png$/);
    assert.strictEqual(result.files[0].mimeType, "image/png");
    assert.strictEqual(writtenPath, result.files[0].path);
  });

  it("应支持 size 中的乘号并透传 watermark_enabled=false", async () => {
    runtime._llmServicesSnapshot.push({
      id: "image-gen",
      name: "绘图模型",
      model: "glm-image",
      baseURL: "https://example.com/v1",
      apiKey: "k",
      description: "文字生成图片",
      capabilityTags: ["image"],
      capabilities: {
        input: ["text"],
        output: ["text"]
      }
    });
    let capturedPayload = null;
    toolExecutor.modelTools._requestImageGeneration = async (_service, payload) => {
      capturedPayload = payload;
      return { data: [{ b64_json: "ZmFrZQ==" }] };
    };
    toolExecutor.modelTools._extractImageBinaryFromGenerationResponse = async () => ({
      buffer: Buffer.from("fake"),
      mimeType: "image/png",
      extension: "png"
    });
    workspace.writeFile = async () => ({ size: 4, mimeType: "image/png" });

    await toolExecutor.executeToolCall(
      { agent: { id: "agent-1" }, currentMessage: { id: "m1" } },
      "call_image_model",
      { prompt: "一只猫", serviceId: "image-gen", size: "1568×1056", watermark_enabled: false }
    );

    assert.strictEqual(capturedPayload.size, "1568x1056");
    assert.strictEqual(capturedPayload.watermark_enabled, false);
  });

  it("不合法 size 应返回参数错误", async () => {
    runtime._llmServicesSnapshot.push({
      id: "image-gen",
      name: "绘图模型",
      model: "glm-image",
      baseURL: "https://example.com/v1",
      apiKey: "k",
      description: "文字生成图片",
      capabilityTags: ["image"],
      capabilities: {
        input: ["text"],
        output: ["text"]
      }
    });

    const result = await toolExecutor.executeToolCall(
      { agent: { id: "agent-1" }, currentMessage: { id: "m1" } },
      "call_image_model",
      { prompt: "一只猫", serviceId: "image-gen", size: "1000x1000" }
    );

    assert.strictEqual(result.error, "invalid_arguments");
  });
});
