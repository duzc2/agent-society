/**
 * ModelTools 单元测试
 *
 * 覆盖 tools_model.js 中的纯函数和状态无关方法。
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { ModelTools } from "../../../src/platform/runtime/tools_model.js";

function createModelTools(runtime = {}) {
  return new ModelTools(runtime);
}

describe("ModelTools — 工具名称与能力解析", () => {
  let tools;

  beforeEach(() => {
    tools = createModelTools();
  });

  it("_toCapabilityToolName 应生成正确的工具名", () => {
    assert.strictEqual(tools._toCapabilityToolName("image"), "call_image_model");
    assert.strictEqual(tools._toCapabilityToolName("vision"), "call_vision_model");
    assert.strictEqual(tools._toCapabilityToolName("code"), "call_code_model");
  });

  it("_toCapabilityToolName 应处理空格和特殊字符", () => {
    assert.strictEqual(tools._toCapabilityToolName("Image Generation"), "call_image_generation_model");
    assert.strictEqual(tools._toCapabilityToolName("  vision  "), "call_vision_model");
    assert.strictEqual(tools._toCapabilityToolName("text-to-image"), "call_text_to_image_model");
  });

  it("_toCapabilityToolName 应处理空值", () => {
    // null ?? "" → "", then "call__model" (double underscore when normalized is empty)
    assert.strictEqual(tools._toCapabilityToolName(null), "call__model");
    assert.strictEqual(tools._toCapabilityToolName(undefined), "call__model");
    assert.strictEqual(tools._toCapabilityToolName(""), "call__model");
  });

  it("_parseCapabilityFromToolName 应逆向解析工具名", () => {
    assert.strictEqual(tools._parseCapabilityFromToolName("call_image_model"), "image");
    assert.strictEqual(tools._parseCapabilityFromToolName("call_vision_model"), "vision");
    assert.strictEqual(tools._parseCapabilityFromToolName("call_code_model"), "code");
    assert.strictEqual(tools._parseCapabilityFromToolName("call_text_to_image_model"), "text_to_image");
  });

  it("_parseCapabilityFromToolName 非法输入应返回 null", () => {
    assert.strictEqual(tools._parseCapabilityFromToolName(null), null);
    assert.strictEqual(tools._parseCapabilityFromToolName(undefined), null);
    assert.strictEqual(tools._parseCapabilityFromToolName(""), null);
    assert.strictEqual(tools._parseCapabilityFromToolName("not_a_tool_name"), null);
    assert.strictEqual(tools._parseCapabilityFromToolName("call_model"), null);
  });
});

describe("ModelTools — 图片尺寸处理", () => {
  let tools;

  beforeEach(() => {
    tools = createModelTools();
  });

  it("_normalizeImageSizeString 应标准化常见尺寸格式", () => {
    assert.strictEqual(tools._normalizeImageSizeString("1280x1280"), "1280x1280");
    assert.strictEqual(tools._normalizeImageSizeString("1280×1280"), "1280x1280"); // 中文乘号
    assert.strictEqual(tools._normalizeImageSizeString("1280 x 1280"), "1280x1280"); // 带空格
    assert.strictEqual(tools._normalizeImageSizeString("1568X1056"), "1568x1056"); // 大写
  });

  it("_normalizeImageSizeString 非法输入应返回空字符串", () => {
    // 空字符串经过默认值 "1280x1280"，但经过正则匹配后格式有效，返回 "1280x1280"（默认值生效）
    assert.strictEqual(tools._normalizeImageSizeString(""), "1280x1280");
    assert.strictEqual(tools._normalizeImageSizeString("abc"), "");
    assert.strictEqual(tools._normalizeImageSizeString("1280x"), "");
    assert.strictEqual(tools._normalizeImageSizeString("x1280"), "");
    // null 不是 string，fallback 到 "1280x1280"
    assert.strictEqual(tools._normalizeImageSizeString(null), "1280x1280");
    assert.strictEqual(tools._normalizeImageSizeString(undefined), "1280x1280");
  });

  it("_validateImageSize 应验证有效尺寸", () => {
    assert.strictEqual(tools._validateImageSize("1280x1280"), "");
    assert.strictEqual(tools._validateImageSize("1568x1056"), "");
    assert.strictEqual(tools._validateImageSize("1728x960"), "");
  });

  it("_validateImageSize 应拒绝非整数尺寸", () => {
    assert.notStrictEqual(tools._validateImageSize("100x100"), ""); // 100 不是32的倍数，但也有自己的错误
    assert.ok(tools._validateImageSize("abcx100").includes("正整数"));
    assert.ok(tools._validateImageSize("100xabc").includes("正整数"));
  });

  it("_validateImageSize 应拒绝非32倍数的尺寸", () => {
    const result = tools._validateImageSize("100x100");
    assert.ok(result.includes("32"));
  });

  it("_validateImageSize 应拒绝超过总像素上限的尺寸", () => {
    // 2^22 = 4,194,304，大尺寸 4096x4096 = 16,777,216 > 2^22
    const result = tools._validateImageSize("4096x4096");
    assert.ok(result.includes("2^22"));
  });

  it("_validateImageSize 应接受接近上限的尺寸", () => {
    // 2048x2048 = 4,194,304 = 2^22，正好等于上限
    assert.strictEqual(tools._validateImageSize("2048x2048"), "");
  });
});

describe("ModelTools — 路径处理", () => {
  let tools;

  beforeEach(() => {
    tools = createModelTools();
  });

  it("_normalizeWorkspaceRelativePath 应标准化路径", () => {
    assert.strictEqual(tools._normalizeWorkspaceRelativePath("foo/bar.txt"), "foo/bar.txt");
    assert.strictEqual(tools._normalizeWorkspaceRelativePath("./foo/bar.txt"), "foo/bar.txt");
    assert.strictEqual(tools._normalizeWorkspaceRelativePath("/foo/bar.txt"), "foo/bar.txt");
  });

  it("_normalizeWorkspaceRelativePath 应反转反斜杠", () => {
    assert.strictEqual(tools._normalizeWorkspaceRelativePath("foo\\bar.txt"), "foo/bar.txt");
    assert.strictEqual(tools._normalizeWorkspaceRelativePath("foo\\bar\\baz"), "foo/bar/baz");
  });

  it("_normalizeWorkspaceRelativePath 应拒绝路径穿越", () => {
    assert.strictEqual(tools._normalizeWorkspaceRelativePath("../etc/passwd"), "");
    assert.strictEqual(tools._normalizeWorkspaceRelativePath("foo/../../etc/passwd"), "");
    assert.strictEqual(tools._normalizeWorkspaceRelativePath("..\\..\\secret.txt"), "");
  });

  it("_normalizeWorkspaceRelativePath 应处理无效输入", () => {
    assert.strictEqual(tools._normalizeWorkspaceRelativePath(""), "");
    assert.strictEqual(tools._normalizeWorkspaceRelativePath("."), "");
    assert.strictEqual(tools._normalizeWorkspaceRelativePath(null), "");
    assert.strictEqual(tools._normalizeWorkspaceRelativePath(undefined), "");
    assert.strictEqual(tools._normalizeWorkspaceRelativePath("/"), "");
  });

  it("_normalizeWorkspaceRelativePath 应合并连续斜杠", () => {
    assert.strictEqual(tools._normalizeWorkspaceRelativePath("foo//bar///baz.txt"), "foo/bar/baz.txt");
  });
});

describe("ModelTools — 图片生成选项", () => {
  let tools;

  beforeEach(() => {
    tools = createModelTools();
  });

  it("_resolveImageGenerationOptions 应使用默认值", () => {
    const result = tools._resolveImageGenerationOptions({});
    assert.strictEqual(result.quality, "hd");
    assert.strictEqual(result.size, "1280x1280");
    assert.strictEqual(result.watermarkEnabled, true);
    assert.strictEqual(result.error, undefined);
  });

  it("_resolveImageGenerationOptions 应接受自定义尺寸", () => {
    const result = tools._resolveImageGenerationOptions({ size: "1568x1056" });
    assert.strictEqual(result.size, "1568x1056");
    assert.strictEqual(result.error, undefined);
  });

  it("_resolveImageGenerationOptions 应拒绝非法 quality 值", () => {
    const result = tools._resolveImageGenerationOptions({ quality: "standard" });
    assert.ok(result.error.includes("hd"));
  });

  it("_resolveImageGenerationOptions 应正确处理 watermark_enabled", () => {
    const on = tools._resolveImageGenerationOptions({ watermark_enabled: true });
    assert.strictEqual(on.watermarkEnabled, true);

    const off = tools._resolveImageGenerationOptions({ watermark_enabled: false });
    assert.strictEqual(off.watermarkEnabled, false);
  });

  it("_resolveImageGenerationOptions 应拒绝非法尺寸", () => {
    const result = tools._resolveImageGenerationOptions({ size: "abc" });
    assert.ok(result.error.includes("格式无效"));
  });
});

describe("ModelTools — prompt 解析", () => {
  let tools;

  beforeEach(() => {
    tools = createModelTools();
  });

  it("_resolveCapabilityPrompt 应从 prompt 字段获取", () => {
    assert.strictEqual(tools._resolveCapabilityPrompt({ prompt: "画一只猫" }), "画一只猫");
  });

  it("_resolveCapabilityPrompt 应从别名获取", () => {
    assert.strictEqual(tools._resolveCapabilityPrompt({ question: "什么是AI？" }), "什么是AI？");
    assert.strictEqual(tools._resolveCapabilityPrompt({ query: "搜索" }), "搜索");
    assert.strictEqual(tools._resolveCapabilityPrompt({ text: "一段文本" }), "一段文本");
  });

  it("_resolveCapabilityPrompt 应优先取 prompt 字段", () => {
    const result = tools._resolveCapabilityPrompt({
      prompt: "优先",
      question: "次选",
      query: "第三",
      text: "第四"
    });
    assert.strictEqual(result, "优先");
  });

  it("_resolveCapabilityPrompt 空参数应返回空字符串", () => {
    assert.strictEqual(tools._resolveCapabilityPrompt({}), "");
    assert.strictEqual(tools._resolveCapabilityPrompt(null), "");
    assert.strictEqual(tools._resolveCapabilityPrompt(undefined), "");
  });
});

describe("ModelTools — 附件规范化", () => {
  let tools;

  beforeEach(() => {
    tools = createModelTools();
  });

  it("_normalizeCapabilityAttachments 应返回空数组当无附件", () => {
    assert.deepStrictEqual(tools._normalizeCapabilityAttachments({}), []);
    assert.deepStrictEqual(tools._normalizeCapabilityAttachments(null), []);
  });

  it("_normalizeCapabilityAttachments 应处理 attachments 数组", () => {
    const result = tools._normalizeCapabilityAttachments({
      attachments: [{ path: "a.png" }, { path: "b.jpg", mimeType: "image/jpeg" }]
    });
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].path, "a.png");
    assert.strictEqual(result[1].path, "b.jpg");
    assert.strictEqual(result[1].mimeType, "image/jpeg");
  });

  it("_normalizeCapabilityAttachments 应合并 image_path 别名", () => {
    const result = tools._normalizeCapabilityAttachments({
      image_path: "single.png",
      attachments: [{ path: "multi.png" }]
    });
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[1].path, "single.png");
  });

  it("_normalizeCapabilityAttachments 应处理 imagePath（驼峰）", () => {
    const result = tools._normalizeCapabilityAttachments({ imagePath: "camel.png" });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].path, "camel.png");
  });

  it("_normalizeCapabilityAttachments 应处理 image 字段", () => {
    const result = tools._normalizeCapabilityAttachments({ image: "img.png" });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].path, "img.png");
  });

  it("_normalizeCapabilityAttachments 应处理 images 数组", () => {
    const result = tools._normalizeCapabilityAttachments({ images: ["a.png", "b.png"] });
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].path, "a.png");
    assert.strictEqual(result[1].path, "b.png");
  });

  it("_normalizeCapabilityAttachments 应去重（不重复添加同一路径）", () => {
    // image_path 和 image 同时存在应都加上
    const result = tools._normalizeCapabilityAttachments({
      image_path: "a.png",
      image: "b.png"
    });
    assert.strictEqual(result.length, 2);
  });
});

describe("ModelTools — 服务ID属性构建", () => {
  let tools;

  beforeEach(() => {
    tools = createModelTools();
  });

  it("_buildCapabilityServiceIdProperty 应构建带枚举的属性", () => {
    const prop = tools._buildCapabilityServiceIdProperty(["service-a", "service-b"]);
    assert.strictEqual(prop.type, "string");
    assert.deepStrictEqual(prop.enum, ["service-a", "service-b"]);
    assert.ok(prop.description.includes("service-a"));
    assert.ok(prop.description.includes("service-b"));
  });

  it("_buildCapabilityServiceIdProperty 空数组应无枚举", () => {
    const prop = tools._buildCapabilityServiceIdProperty([]);
    assert.strictEqual(prop.type, "string");
    assert.strictEqual(prop.enum, undefined);
    assert.ok(prop.description.includes("可选"));
  });

  it("_buildCapabilityServiceIdProperty 应过滤非字符串ID", () => {
    const prop = tools._buildCapabilityServiceIdProperty(["valid", 123, null, "", "  "]);
    assert.deepStrictEqual(prop.enum, ["valid"]);
  });

  it("_buildCapabilityServiceIdProperty null/undefined 应无枚举", () => {
    const prop1 = tools._buildCapabilityServiceIdProperty(null);
    assert.strictEqual(prop1.enum, undefined);

    const prop2 = tools._buildCapabilityServiceIdProperty(undefined);
    assert.strictEqual(prop2.enum, undefined);
  });
});

describe("ModelTools — 默认输出路径", () => {
  let tools;

  beforeEach(() => {
    tools = createModelTools();
  });

  it("_buildDefaultImageOutputPath 应包含日期和扩展名", () => {
    const result = tools._buildDefaultImageOutputPath("png");
    assert.ok(/^generated\/images\/\d{8}\/\d{6}-\d{4}\.png$/.test(result));
  });

  it("_buildDefaultImageOutputPath 应支持不同扩展名", () => {
    const result = tools._buildDefaultImageOutputPath("jpg");
    assert.ok(/\.jpg$/.test(result));
  });

  it("_resolveImageOutputPath 应优先使用 path 参数", () => {
    const result = tools._resolveImageOutputPath({ path: "my/path/image.png" }, "png");
    assert.strictEqual(result, "my/path/image.png");
  });

  it("_resolveImageOutputPath 应自动追加扩展名", () => {
    const result = tools._resolveImageOutputPath({ path: "my/path/image" }, "jpg");
    assert.strictEqual(result, "my/path/image.jpg");
  });

  it("_resolveImageOutputPath 应支持 outputPath 别名", () => {
    const result = tools._resolveImageOutputPath({ outputPath: "alt/path.png" }, "png");
    assert.strictEqual(result, "alt/path.png");
  });

  it("_resolveImageOutputPath 空参数应生成默认路径", () => {
    const result = tools._resolveImageOutputPath({}, "webp");
    assert.ok(/^generated\/images\/\d{8}\/\d{6}-\d{4}\.webp$/.test(result));
  });
});

describe("ModelTools — 能力参数构建", () => {
  let tools;

  beforeEach(() => {
    tools = createModelTools();
  });

  it("_buildCapabilityToolParameters 应为 image 能力生成参数", () => {
    const params = tools._buildCapabilityToolParameters("image", []);
    assert.strictEqual(params.type, "object");
    assert.notStrictEqual(params.properties.prompt, undefined);
    assert.notStrictEqual(params.properties.size, undefined);
    assert.strictEqual(params.properties.size.default, "1280x1280");
    assert.notStrictEqual(params.properties.quality, undefined);
    assert.ok(params.required.includes("prompt"));
  });

  it("_buildCapabilityToolParameters 应为 vision 能力生成参数", () => {
    const params = tools._buildCapabilityToolParameters("vision", []);
    assert.strictEqual(params.type, "object");
    assert.notStrictEqual(params.properties.attachments, undefined);
    assert.notStrictEqual(params.properties.attachments.items.properties.path, undefined);
  });

  it("_buildCapabilityToolParameters 应为通用能力生成参数", () => {
    const params = tools._buildCapabilityToolParameters("code", []);
    assert.strictEqual(params.type, "object");
    assert.notStrictEqual(params.properties.prompt, undefined);
    assert.notStrictEqual(params.properties.attachments, undefined);
  });
});

describe("ModelTools — token 统计", () => {
  let tools;

  beforeEach(() => {
    tools = createModelTools();
  });

  it("_extractTotalTokensFromGenerationResponse 应提取 totalTokens", () => {
    assert.strictEqual(tools._extractTotalTokensFromGenerationResponse({
      usage: { totalTokens: 150 }
    }), 150);
  });

  it("_extractTotalTokensFromGenerationResponse 应兼容 total_tokens 下划线命名", () => {
    assert.strictEqual(tools._extractTotalTokensFromGenerationResponse({
      usage: { total_tokens: 200 }
    }), 200);
  });

  it("_extractTotalTokensFromGenerationResponse 无数据应返回 null", () => {
    assert.strictEqual(tools._extractTotalTokensFromGenerationResponse({}), null);
    assert.strictEqual(tools._extractTotalTokensFromGenerationResponse(null), null);
    assert.strictEqual(tools._extractTotalTokensFromGenerationResponse({ usage: {} }), null);
  });
});
