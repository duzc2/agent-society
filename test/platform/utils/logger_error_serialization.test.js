/**
 * logger Error 序列化测试
 *
 * 覆盖 _formatData 的 JSON replacer 对嵌套 Error 的处理：
 * 诊断字段（responseBody/statusCode/url/cause 等）必须完整写入日志，
 * 而不是只剩 name/message/stack 三件套。
 *
 * 背景：AI SDK 的 APICallError("Invalid JSON response") 把原始响应体挂在
 * err.responseBody 上，TurnEngine 等调用方把整个错误对象传给日志，
 * 但旧版 replacer 只保留三件套，导致"非法 JSON 但不知道内容是什么"无法排查。
 */

import { describe, it, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fsp from "node:fs/promises";
import os from "node:os";
import { Logger } from "../../../src/platform/utils/logger/logger.js";

const tempDirs = [];

/**
 * 创建独立临时日志目录的 Logger，写入一条日志并返回 system.log 全文。
 * @param {string} message - 日志消息
 * @param {any} data - 日志数据
 * @returns {Promise<string>}
 */
async function writeAndReadLog(message, data) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "logger-err-fmt-"));
  tempDirs.push(dir);
  const logger = new Logger({ enabled: true, logsDir: dir, defaultLevel: "info", levels: {} });
  await logger.forModule("test").error(message, data);
  assert.ok(logger._systemFilePath, "写入后 _systemFilePath 应已就绪");
  return fsp.readFile(logger._systemFilePath, "utf8");
}

after(async () => {
  await Promise.all(tempDirs.map(dir => fsp.rm(dir, { recursive: true, force: true })));
});

/** 构造一个模拟 AI SDK APICallError 形态的错误（自有可枚举诊断属性 + cause 链）。 */
function makeApiCallError() {
  const cause = new Error('JSON parsing failed: Text: {"bad"…');
  cause.name = "AI_JSONParseError";
  cause.text = '{"bad"';
  const err = new Error("Invalid JSON response");
  err.name = "AI_APICallError";
  err.url = "http://127.0.0.1:15721/v1/messages";
  err.statusCode = 200;
  err.responseBody = '{"id":"x","type":"message","role":"assistant","content":';
  err.cause = cause;
  return err;
}

describe("logger Error 序列化（replacer）", () => {
  it("嵌套 Error 的 responseBody/statusCode/url 应完整写入日志（Invalid JSON 场景）", async () => {
    const content = await writeAndReadLog("LLM 调用失败", {
      errorType: "AI_APICallError",
      details: makeApiCallError()
    });

    assert.ok(content.includes("Invalid JSON response"));
    assert.ok(content.includes('"responseBody"'), "responseBody 字段必须出现");
    // 嵌套 JSON 字符串内的引号会被 JSON 转义为 \"，缩进模式下冒号后带空格
    assert.ok(content.includes('\\"type\\":\\"message\\"'), "响应体原文必须出现");
    assert.ok(content.includes('"statusCode": 200'));
    assert.ok(content.includes("http://127.0.0.1:15721/v1/messages"));
  });

  it("cause 链上的诊断字段（如 JSONParseError.text）应写入日志", async () => {
    const content = await writeAndReadLog("LLM 调用失败", { details: makeApiCallError() });

    assert.ok(content.includes('"cause"'), "cause 字段必须出现");
    assert.ok(content.includes("AI_JSONParseError"));
    assert.ok(content.includes('{\\"bad\\"'), "cause.text 原文必须出现");
  });

  it("requestBodyValues 应被排除，避免完整请求体撑爆日志", async () => {
    const err = makeApiCallError();
    err.requestBodyValues = { body: "x".repeat(20000) };
    const content = await writeAndReadLog("LLM 调用失败", { details: err });

    assert.ok(!content.includes("x".repeat(100)), "请求体内容不得出现在日志中");
    assert.ok(content.includes('"responseBody"'), "其他诊断字段不受影响");
  });

  it("超长字符串属性应截断并标注总长", async () => {
    const err = new Error("long body");
    err.name = "AI_APICallError";
    err.responseBody = "y".repeat(9000);
    const content = await writeAndReadLog("失败", { details: err });

    assert.ok(content.includes("y".repeat(8000)), "截断后应保留前 8000 字符");
    assert.ok(!content.includes("y".repeat(8001)), "超过 8000 的部分不得出现");
    assert.ok(content.includes("已截断，共 9000 字符"), "必须标注总长");
  });

  it("循环引用的 cause 链不应导致序列化失败", async () => {
    const err = new Error("cyclic");
    err.name = "AI_APICallError";
    err.responseBody = "ok";
    err.cause = err;
    const content = await writeAndReadLog("失败", { details: err });

    assert.ok(content.includes('"responseBody": "ok"'));
    assert.ok(content.includes("[Circular]"), "循环引用应标注为 [Circular]");
  });

  it("普通 Error（无诊断属性）仍应输出 name/message/stack，保持向后兼容", async () => {
    const content = await writeAndReadLog("失败", { details: new Error("simple failure") });

    assert.ok(content.includes("simple failure"));
    assert.ok(content.includes('"name": "Error"'));
    assert.ok(content.includes('"stack"'));
  });
});
