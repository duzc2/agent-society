/**
 * schema_validator.js — 共享的 ai-sdk schema 验证工具
 *
 * 使用真实的 modelMessageSchema 校验消息格式，确保格式化器输出
 * 符合 ai-sdk 的要求，而非仅仅符合"代码当前产出的格式"。
 *
 * 所有测试文件应从此处导入，避免重复定义。
 *
 * 用法：
 *   import { assertValidMessages, assertValidSystem, assertValidPrompt } from "../../helpers/schema_validator.js";
 *
 *   await assertValidMessages(messages, "my test case");
 */

import assert from "node:assert";
import { modelMessageSchema } from "ai";

/**
 * 验证消息数组通过 ai-sdk modelMessageSchema 校验。
 * 不通过时抛出带详细诊断的 AssertionError。
 *
 * @param {any[]} messages - 待验证的消息数组
 * @param {string} [label="messages"] - 测试标签
 */
export async function assertValidMessages(messages, label = "messages") {
  try {
    await modelMessageSchema.array().parse(messages);
  } catch (err) {
    const issues = err?.issues ?? [];
    const details = issues.map(i => {
      const msgContent = i.path?.length
        ? JSON.stringify(messages[i.path[0]]).substring(0, 300)
        : "(unknown)";
      return `  at path [${(i.path ?? []).join(".")}]: ${i.message}\n    message: ${msgContent}`;
    }).join("\n") || err?.message || String(err);
    assert.fail(`${label}: 消息格式不符合 ai-sdk ModelMessage[] schema\n${details}`);
  }
}

/**
 * 验证 system 提示词格式。
 * ai-sdk 接受 string 或 SystemModelMessage[]。
 *
 * @param {string|any[]|undefined} system - system 提示词
 * @param {string} [label="system"] - 测试标签
 */
export function assertValidSystem(system, label = "system") {
  if (system === undefined || system === null) return; // system 可选

  if (typeof system === "string") {
    // string 格式有效（ai-sdk 内部会处理）
    return;
  }
  if (Array.isArray(system)) {
    for (const [i, msg] of system.entries()) {
      assert.strictEqual(msg.role, "system",
        `${label}[${i}]: SystemModelMessage.role must be "system", got "${msg.role}"`);
      assert.strictEqual(typeof msg.content, "string",
        `${label}[${i}]: SystemModelMessage.content must be string, got ${typeof msg.content}`);
    }
    return;
  }
  assert.fail(`${label}: system must be string or SystemModelMessage[], got ${typeof system}`);
}

/**
 * 同时验证 system 和 messages 格式。
 *
 * @param {{system?: string|any[], messages: any[]}} prompt
 * @param {string} [label="prompt"] - 测试标签
 */
export async function assertValidPrompt(prompt, label = "prompt") {
  if (prompt.system !== undefined) {
    assertValidSystem(prompt.system, `${label}.system`);
  }
  await assertValidMessages(prompt.messages, `${label}.messages`);
}
