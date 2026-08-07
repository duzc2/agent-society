/**
 * 模型能力工具 — 从 tool_executor.js 提取
 * @module runtime/模型能力工具
 */

import path from "path";
import { getExtensionFromMimeType } from "../utils/content/content_type_utils.js";
import { getWorkspaceManager } from "../services/workspace/workspace_manager.js";

export class ModelTools {
  constructor(runtime) {
    this.runtime = runtime;
  }

  _buildCapabilityToolDefinitions() {
    const serviceGroups = this._collectCapabilityServiceGroups();
    const toolDefinitions = [];
    for (const [capability, services] of serviceGroups.entries()) {
      const toolName = this._toCapabilityToolName(capability);
      const serviceSummary = services
        .map((service, index) => `${index + 1}. id=${service.id || "未配置"}，name=${service.name}，model=${service.model}，description=${service.description || "无"}，tags=${Array.isArray(service.capabilityTags) ? service.capabilityTags.join("、") : "无"}`)
        .join("\n");
      const enumIds = services
        .map((service) => (typeof service?.id === "string" ? service.id.trim() : ""))
        .filter((id) => id !== "");
      toolDefinitions.push({
        type: "function",
        function: {
          name: toolName,
          description: `调用支持 ${capability} 能力的大模型并返回文本结果。支持多个模型可选，优先按任务目标选择 serviceId。\n可用模型：\n${serviceSummary}`,
          parameters: this._buildCapabilityToolParameters(capability, enumIds)
        }
      });
    }
    return toolDefinitions;
  }

  _buildCapabilityServiceIdProperty(enumIds) {
    const normalizedIds = Array.isArray(enumIds)
      ? enumIds.filter((id) => typeof id === "string" && id.trim() !== "")
      : [];
    if (normalizedIds.length > 0) {
      return {
        type: "string",
        enum: normalizedIds,
        description: `可选，指定模型服务ID。可选值：${normalizedIds.join("、")}。不传则自动选择第一个。`
      };
    }
    return {
      type: "string",
      description: "可选，指定模型服务ID。不传则自动选择第一个。"
    };
  }

  _buildCapabilityToolParameters(capability, enumIds) {
    const serviceIdProperty = this._buildCapabilityServiceIdProperty(enumIds);
    if (capability === "image") {
      return {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "绘图提示词，描述主体、风格、构图、光影等要素。"
          },
          question: {
            type: "string",
            description: "可选，prompt 的别名。"
          },
          query: {
            type: "string",
            description: "可选，prompt 的别名。"
          },
          text: {
            type: "string",
            description: "可选，prompt 的别名。"
          },
          serviceId: serviceIdProperty,
          path: {
            type: "string",
            description: "可选，生成图片保存到工作区的相对路径。"
          },
          outputPath: {
            type: "string",
            description: "可选，生成图片保存到工作区的相对路径（path 别名）。"
          },
          size: {
            type: "string",
            default: "1280x1280",
            description: "可选，图片尺寸。推荐：1280x1280、1568x1056、1056x1568、1472x1088、1088x1472、1728x960、960x1728；长宽需为32的整数倍，最大像素不超过 2^22。"
          },
          quality: {
            type: "string",
            enum: ["hd"],
            default: "hd",
            description: "可选，生成图像质量。hd 表示更精细、细节更丰富、整体一致性更高。"
          },
          watermark_enabled: {
            type: "boolean",
            description: "可选，控制是否添加水印。true 开启显式与隐式数字水印（默认）；false 关闭全部水印。"
          },
          n: {
            type: "number",
            description: "可选，生成图片数量。"
          }
        },
        required: ["prompt"]
      };
    }
    if (capability === "vision") {
      return {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "视觉分析任务描述。"
          },
          question: {
            type: "string",
            description: "可选，prompt 的别名。"
          },
          query: {
            type: "string",
            description: "可选，prompt 的别名。"
          },
          text: {
            type: "string",
            description: "可选，prompt 的别名。"
          },
          serviceId: serviceIdProperty,
          attachments: {
            type: "array",
            description: "可选，附件列表。每项至少包含 path。",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "工作区相对路径" },
                mimeType: { type: "string", description: "可选，附件 MIME 类型" }
              },
              required: ["path"]
            }
          },
          file_path: {
            type: "string",
            description: "可选，单张图片相对路径。等价于 attachments=[{path:file_path}]。"
          },
          filePath: {
            type: "string",
            description: "可选，单张图片相对路径。等价于 attachments=[{path:filePath}]。"
          },
          image_path: {
            type: "string",
            description: "可选，单张图片相对路径。等价于 attachments=[{path:image_path}]。"
          },
          imagePath: {
            type: "string",
            description: "可选，单张图片相对路径。等价于 attachments=[{path:imagePath}]。"
          },
          image: {
            type: "string",
            description: "可选，单张图片相对路径。等价于 attachments=[{path:image}]。"
          },
          images: {
            type: "array",
            items: { type: "string" },
            description: "可选，多张图片相对路径数组。等价于多个 attachments 项。"
          },
          temperature: {
            type: "number",
            description: "可选，采样温度"
          }
        },
        required: ["prompt"]
      };
    }
    return {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "给能力模型的任务描述"
        },
        serviceId: serviceIdProperty,
        attachments: {
          type: "array",
          description: "可选，附件列表。vision 能力建议传图片相对路径。",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "工作区相对路径" },
              mimeType: { type: "string", description: "可选，附件 MIME 类型" }
            },
            required: ["path"]
          }
        },
        image_path: {
          type: "string",
          description: "可选，单张图片相对路径。等价于 attachments=[{path:image_path}]。"
        },
        imagePath: {
          type: "string",
          description: "可选，单张图片相对路径。等价于 attachments=[{path:imagePath}]。"
        },
        image: {
          type: "string",
          description: "可选，单张图片相对路径。等价于 attachments=[{path:image}]。"
        },
        images: {
          type: "array",
          items: { type: "string" },
          description: "可选，多张图片相对路径数组。等价于多个 attachments 项。"
        },
        temperature: {
          type: "number",
          description: "可选，采样温度"
        }
      },
      required: ["prompt"]
    };
  }

  _collectCapabilityServiceGroups() {
    const runtime = this.runtime;
    const services = Array.isArray(runtime?._llmServicesSnapshot) ? runtime._llmServicesSnapshot : [];
    const groups = new Map();
    for (const service of services) {
      const inputs = Array.isArray(service?.capabilities?.input) ? service.capabilities.input : [];
      for (const capability of inputs) {
        if (!capability || capability === "text") continue;
        if (!groups.has(capability)) {
          groups.set(capability, []);
        }
        groups.get(capability).push(service);
      }
      const tags = Array.isArray(service?.capabilityTags) ? service.capabilityTags : [];
      const hasImageTag = tags.some((tag) => typeof tag === "string" && tag.trim().toLowerCase() === "image");
      if (hasImageTag) {
        if (!groups.has("image")) {
          groups.set("image", []);
        }
        const imageServices = groups.get("image");
        if (!imageServices.some((item) => item?.id === service?.id)) {
          imageServices.push(service);
        }
      }
    }
    return groups;
  }

  _toCapabilityToolName(capability) {
    const normalized = String(capability ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return `call_${normalized}_model`;
  }

  _parseCapabilityFromToolName(toolName) {
    if (typeof toolName !== "string") return null;
    const match = /^call_([a-z0-9_]+)_model$/i.exec(toolName);
    return match ? match[1].toLowerCase() : null;
  }

  async _executeCapabilityModelTool(ctx, capabilitySlug, args) {
    const runtime = this.runtime;
    const grouped = this._collectCapabilityServiceGroups();
    const entries = Array.from(grouped.entries());
    const resolved = entries.find(([capability]) => this._toCapabilityToolName(capability) === `call_${capabilitySlug}_model`);
    if (!resolved) {
      return { error: "capability_not_found", message: `未找到能力 ${capabilitySlug} 对应的模型服务` };
    }
    const [capability, services] = resolved;
    const requestedServiceId = typeof args?.serviceId === "string" ? args.serviceId.trim() : "";
    const selectedService = requestedServiceId
      ? services.find((service) => service.id === requestedServiceId) ?? null
      : services[0] ?? null;
    if (!selectedService) {
      return { error: "service_not_found", message: `能力 ${capability} 不支持指定服务 ${requestedServiceId}` };
    }
    const prompt = this._resolveCapabilityPrompt(args);
    if (!prompt) {
      return { error: "invalid_prompt", message: "prompt 不能为空（兼容字段：prompt/question/query/text）" };
    }
    if (capability === "image") {
      return await this._executeImageCapabilityTool(ctx, selectedService, prompt, args);
    }
    const llmClient = await runtime.getLlmClientForService(selectedService.id);
    if (!llmClient) {
      return { error: "llm_client_unavailable", message: `无法创建服务 ${selectedService.id} 的客户端` };
    }
    const normalizedAttachments = this._normalizeCapabilityAttachments(args);
    const userContent = await this._buildCapabilityToolUserContent(ctx, capability, prompt, normalizedAttachments);
    const response = await llmClient.chat({
      messages: [{ role: "user", content: userContent }],
      temperature: typeof args?.temperature === "number" ? args.temperature : undefined,
      meta: {
        agentId: ctx.agent?.id ?? null,
        toolName: this._toCapabilityToolName(capability),
        serviceId: selectedService.id
      }
    });
    const totalTokens = typeof response?._usage?.totalTokens === "number" ? response._usage.totalTokens : null;
    return {
      content: response?.content ?? "",
      totalTokens
    };
  }

  async _executeImageCapabilityTool(ctx, selectedService, prompt, args) {
    const payload = {
      model: selectedService.model,
      prompt
    };
    const imageOptions = this._resolveImageGenerationOptions(args);
    if (imageOptions.error) {
      return { error: "invalid_arguments", message: imageOptions.error };
    }
    payload.size = imageOptions.size;
    payload.quality = imageOptions.quality;
    payload.watermark_enabled = imageOptions.watermarkEnabled;
    if (typeof args?.n === "number" && Number.isFinite(args.n) && args.n > 0) {
      payload.n = args.n;
    }
    const data = await this._requestImageGeneration(selectedService, payload);
    const imageBinary = await this._extractImageBinaryFromGenerationResponse(data);
    if (!imageBinary?.buffer) {
      throw new Error("图片生成结果缺少可保存的图像数据");
    }
    const runtime = this.runtime;
    const workspaceId = runtime.findWorkspaceIdForAgent(ctx.agent?.id);
    if (!workspaceId) {
      return { error: "workspace_not_assigned", message: "当前智能体未分配工作空间" };
    }
    const ws = await getWorkspaceManager().getWorkspace(workspaceId);
    const outputPath = this._resolveImageOutputPath(args, imageBinary.extension);
    const writeResult = await ws.writeFile(outputPath, imageBinary.buffer, {
      operator: ctx.agent?.id,
      messageId: ctx.currentMessage?.id || `image-${Date.now()}`,
      mimeType: imageBinary.mimeType
    });
    const totalTokens = this._extractTotalTokensFromGenerationResponse(data);
    return {
      ok: true,
      files: [{
        path: outputPath,
        size: writeResult?.size ?? imageBinary.buffer.length,
        mimeType: writeResult?.mimeType ?? imageBinary.mimeType
      }],
      totalTokens
    };
  }

  async _requestImageGeneration(service, payload) {
    const baseURL = String(service?.baseURL ?? "").replace(/\/+$/, "");
    const url = `${baseURL}/images/generations`;
    const headers = { "Content-Type": "application/json" };
    if (service?.apiKey) {
      headers.Authorization = `Bearer ${service.apiKey}`;
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || data?.message || `图片生成失败，状态码 ${response.status}`;
      throw new Error(message);
    }
    return data;
  }

  async _extractImageBinaryFromGenerationResponse(data) {
    const outputs = [];
    const items = Array.isArray(data?.data) ? data.data : [];
    for (const item of items) {
      if (typeof item?.url === "string" && item.url.trim()) {
        outputs.push(item.url.trim());
      } else if (typeof item?.b64_json === "string" && item.b64_json.trim()) {
        outputs.push(`data:image/png;base64,${item.b64_json.trim()}`);
      }
    }
    const firstOutput = outputs[0] || (typeof data?.url === "string" && data.url.trim() ? data.url.trim() : "");
    if (!firstOutput) return null;
    if (firstOutput.startsWith("data:")) {
      const match = /^data:([^;]+);base64,(.+)$/i.exec(firstOutput);
      if (!match) return null;
      const mimeType = match[1] || "image/png";
      const base64Body = match[2] || "";
      return {
        buffer: Buffer.from(base64Body, "base64"),
        mimeType,
        extension: this._extensionFromMimeType(mimeType)
      };
    }
    const response = await fetch(firstOutput);
    if (!response.ok) {
      throw new Error(`下载生成图片失败，状态码 ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = response.headers.get("content-type") || "image/png";
    return {
      buffer,
      mimeType,
      extension: this._extensionFromMimeType(mimeType)
    };
  }

  _extractTotalTokensFromGenerationResponse(data) {
    if (typeof data?.usage?.totalTokens === "number") return data.usage.totalTokens;
    if (typeof data?.usage?.total_tokens === "number") return data.usage.total_tokens;
    return null;
  }

  _extensionFromMimeType(mimeType) {
    const ext = getExtensionFromMimeType(mimeType);
    return ext || "png";
  }

  _resolveImageOutputPath(args, extension) {
    const candidates = [args?.path, args?.outputPath, args?.output_path, args?.filePath, args?.filepath];
    for (const value of candidates) {
      if (typeof value !== "string" || !value.trim()) continue;
      const normalized = this._normalizeWorkspaceRelativePath(value);
      if (normalized) {
        if (path.extname(normalized)) return normalized;
        return `${normalized}.${extension}`;
      }
    }
    return this._buildDefaultImageOutputPath(extension);
  }

  _buildDefaultImageOutputPath(extension) {
    const now = new Date();
    const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    const time = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    const random4 = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    return `generated/images/${date}/${time}-${random4}.${extension}`;
  }

  _resolveImageGenerationOptions(args) {
    const qualityRaw = typeof args?.quality === "string" && args.quality.trim() ? args.quality.trim().toLowerCase() : "hd";
    if (qualityRaw !== "hd") {
      return { error: "quality 仅支持 hd" };
    }
    const normalizedSize = this._normalizeImageSizeString(args?.size);
    if (!normalizedSize) {
      return { error: "size 格式无效，应为 WIDTHxHEIGHT，例如 1280x1280" };
    }
    const sizeValidationError = this._validateImageSize(normalizedSize);
    if (sizeValidationError) {
      return { error: sizeValidationError };
    }
    const watermarkEnabled = typeof args?.watermark_enabled === "boolean" ? args.watermark_enabled : true;
    return {
      quality: qualityRaw,
      size: normalizedSize,
      watermarkEnabled
    };
  }

  _normalizeImageSizeString(value) {
    const raw = typeof value === "string" && value.trim() ? value.trim() : "1280x1280";
    const normalized = raw.toLowerCase().replace(/×/g, "x").replace(/\s+/g, "");
    return /^\d+x\d+$/.test(normalized) ? normalized : "";
  }

  _validateImageSize(size) {
    const [widthText, heightText] = size.split("x");
    const width = Number(widthText);
    const height = Number(heightText);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      return "size 必须是正整数宽高";
    }
    if (width % 32 !== 0 || height % 32 !== 0) {
      return "size 的长宽都必须是 32 的整数倍";
    }
    if (width * height > 2 ** 22) {
      return "size 的总像素不能超过 2^22";
    }
    return "";
  }

  async _buildCapabilityToolUserContent(ctx, capability, prompt, attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) {
      return prompt;
    }
    const runtime = this.runtime;
    const workspaceId = runtime.findWorkspaceIdForAgent(ctx.agent?.id);
    if (!workspaceId) {
      return `${prompt}\n\n[附件未处理：当前智能体未分配工作空间]`;
    }
    const ws = await getWorkspaceManager().getWorkspace(workspaceId);
    const parts = [{ type: "text", text: prompt }];
    for (const item of attachments) {
      const rawAttachmentPath = typeof item?.path === "string" ? item.path.trim() : "";
      if (!rawAttachmentPath) continue;
      try {
        const attachmentPath = await this._resolveAttachmentPathInWorkspace(ws, rawAttachmentPath);
        if (!attachmentPath) {
          parts.push({
            type: "text",
            text: `附件 ${rawAttachmentPath} 读取失败：文件不存在或路径非法`
          });
          continue;
        }
        const fileInfo = await ws.getFileInfo(attachmentPath);
        const readLength = Math.min(Math.max(Number(fileInfo?.size) || 0, 1), 10 * 1024 * 1024);
        const fileData = await ws.readFile(attachmentPath, { encoding: "base64", length: readLength });
        const mimeType = typeof item?.mimeType === "string" && item.mimeType.trim()
          ? item.mimeType.trim()
          : (typeof fileInfo?.mimeType === "string" && fileInfo.mimeType.trim() ? fileInfo.mimeType : "image/jpeg");
        if (capability === "vision" && typeof fileData?.total === "number" && typeof fileData?.readLength === "number" && fileData.readLength < fileData.total) {
          parts.push({
            type: "text",
            text: `附件 ${attachmentPath} 读取失败：图片文件过大或读取不完整`
          });
          continue;
        }
        if (capability === "vision") {
          parts.push({
            type: "image",
            image: Buffer.from(fileData.content, "base64"),
            mediaType: mimeType
          });
        } else {
          parts.push({
            type: "text",
            text: `附件 ${attachmentPath} 已加载，mimeType=${mimeType}，base64长度=${fileData?.content?.length ?? 0}`
          });
        }
      } catch (error) {
        parts.push({
          type: "text",
          text: `附件 ${rawAttachmentPath} 读取失败：${error?.message ?? String(error)}`
        });
      }
    }
    return parts;
  }

  _normalizeCapabilityAttachments(args) {
    const attachments = [];
    if (Array.isArray(args?.attachments)) {
      for (const item of args.attachments) {
        if (item && typeof item === "object") {
          attachments.push(item);
        }
      }
    }
    const imagePath = typeof args?.image_path === "string" && args.image_path.trim()
      ? args.image_path.trim()
      : (typeof args?.imagePath === "string" && args.imagePath.trim() ? args.imagePath.trim() : "");
    if (imagePath) {
      attachments.push({ path: imagePath });
    }
    const image = typeof args?.image === "string" && args.image.trim() ? args.image.trim() : "";
    if (image) {
      attachments.push({ path: image });
    }
    if (Array.isArray(args?.images)) {
      for (const imageItem of args.images) {
        if (typeof imageItem === "string" && imageItem.trim()) {
          attachments.push({ path: imageItem.trim() });
        }
      }
    }
    return attachments;
  }

  _resolveCapabilityPrompt(args) {
    const candidates = [args?.prompt, args?.question, args?.query, args?.text];
    for (const value of candidates) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return "";
  }

  _normalizeWorkspaceRelativePath(inputPath) {
    if (typeof inputPath !== "string") return "";
    let normalized = inputPath.trim().replace(/\\/g, "/");
    if (!normalized) return "";
    normalized = normalized.replace(/^\.\//, "");
    normalized = normalized.replace(/^\/+/, "");
    while (normalized.startsWith("./")) {
      normalized = normalized.slice(2);
    }
    normalized = normalized.replace(/\/+/g, "/");
    if (!normalized || normalized === "." || normalized.includes("..")) {
      return "";
    }
    return normalized;
  }

  async _resolveAttachmentPathInWorkspace(ws, rawPath) {
    const normalizedPath = this._normalizeWorkspaceRelativePath(rawPath);
    if (!normalizedPath) {
      return null;
    }
    try {
      await ws.readFile(normalizedPath, { length: 1 });
      return normalizedPath;
    } catch (error) {
      const message = error?.message ?? String(error ?? "");
      const isNotFound = message.includes("file_not_found")
        || message.includes("ENOENT")
        || message.toLowerCase().includes("no such file");
      if (!isNotFound) {
        return null;
      }
    }
    const targetName = normalizedPath.split("/").filter(Boolean).pop();
    if (!targetName) return null;
    return await this._findPathByFilename(ws, targetName, ".");
  }

  async _findPathByFilename(ws, filename, currentDir) {
    const entries = await ws.listFiles(currentDir);
    for (const entry of entries) {
      if (entry?.type === "directory") continue;
      if (entry?.name === filename) {
        return currentDir === "." ? entry.name : `${currentDir}/${entry.name}`;
      }
    }
    for (const entry of entries) {
      if (entry?.type !== "directory") continue;
      const childDir = currentDir === "." ? entry.name : `${currentDir}/${entry.name}`;
      const matched = await this._findPathByFilename(ws, filename, childDir);
      if (matched) return matched;
    }
    return null;
  }
}
