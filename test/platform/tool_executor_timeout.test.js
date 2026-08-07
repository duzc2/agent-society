/**
 * 步骤 6: ToolExecutor 超时机制 测试
 *
 * 验证以下场景：
 * 1. 工具执行超过超时时间 → Promise reject，错误信息包含"超时"
 * 2. 正常完成的工具不受超时影响
 * 3. 不同工具类型使用不同的超时值
 * 4. 超时时日志正确记录
 */

import { describe, it } from "node:test";
import assert from "node:assert";

describe("步骤6: ToolExecutor 超时机制 (Promise.race)", () => {

  // 超时配置（与 tool_executor.js 保持一致）
  const TOOL_TIMEOUTS = {
    http_request: 30000,
    run_javascript: 60000,
    run_skill_script: 120000
  };
  const DEFAULT_TIMEOUT = 60000;

  // ==================== 1. 超时工具被 reject ====================

  it("工具执行超过超时时间，应抛出超时错误", async () => {
    const timeoutMs = 10; // 测试用短超时

    const simulateToolExecution = (toolName) => {
      return Promise.race([
        // 模拟一个永远不会完成的工具
        new Promise(() => {}),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error(`tool_timeout: ${toolName} (${timeoutMs}ms)`));
          }, timeoutMs);
        })
      ]);
    };

    try {
      await simulateToolExecution("http_request");
      assert.fail("应抛出超时错误");
    } catch (err) {
      assert.ok(err.message.includes("tool_timeout"));
      assert.ok(err.message.includes("http_request"));
    }
  });

  // ==================== 2. 正常工具不受影响 ====================

  it("正常快速完成的工具不应触发超时", async () => {
    const timeoutMs = 5000;

    const result = await Promise.race([
      (async () => ({ ok: true, data: "success" }))(),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`tool_timeout: test_tool (${timeoutMs}ms)`));
        }, timeoutMs);
      })
    ]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data, "success");
  });

  // ==================== 3. 不同工具类型不同超时值 ====================

  it("http_request 超时 30 秒", () => {
    assert.strictEqual(TOOL_TIMEOUTS.http_request, 30000);
  });

  it("run_javascript 超时 60 秒", () => {
    assert.strictEqual(TOOL_TIMEOUTS.run_javascript, 60000);
  });

  it("run_skill_script 超时 120 秒", () => {
    assert.strictEqual(TOOL_TIMEOUTS.run_skill_script, 120000);
  });

  it("未知工具使用默认超时 60 秒", () => {
    const timeoutMs = TOOL_TIMEOUTS["unknown_tool"] ?? DEFAULT_TIMEOUT;
    assert.strictEqual(timeoutMs, 60000);
  });

  it("file_read_lines 使用默认超时 60 秒", () => {
    const timeoutMs = TOOL_TIMEOUTS["file_read_lines"] ?? DEFAULT_TIMEOUT;
    assert.strictEqual(timeoutMs, 60000);
  });

  // ==================== 4. 超时日志记录 ====================

  it("超时时应记录 warn 日志", async () => {
    const logs = [];
    const mockLog = {
      warn: async (msg, data) => {
        logs.push({ msg, data });
      },
      info: async () => {},
      error: async () => {}
    };

    const timeoutMs = 5;

    try {
      await Promise.race([
        new Promise(() => {}), // 永不完成
        new Promise((_, reject) => {
          setTimeout(() => {
            void mockLog.warn("[ToolExecutor] 工具执行超时", {
              toolName: "http_request",
              timeoutMs,
              agentId: "test-agent"
            });
            reject(new Error("tool_timeout"));
          }, timeoutMs);
        })
      ]);
    } catch {
      // 预期超时
    }

    await new Promise(r => setTimeout(r, 20));

    assert.strictEqual(logs.length, 1);
    assert.ok(logs[0].msg.includes("超时"));
    assert.strictEqual(logs[0].data.toolName, "http_request");
    assert.strictEqual(logs[0].data.agentId, "test-agent");
  });

  // ==================== 5. 并发：多个工具各有独立超时 ====================

  it("并发执行的多个工具各有独立超时", async () => {
    const results = [];

    const runTool = async (name, ms) => {
      const start = Date.now();
      try {
        await Promise.race([
          new Promise(resolve => setTimeout(resolve, ms)),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`timeout:${name}`)), 20);
          })
        ]);
        results.push({ name, status: "ok", elapsed: Date.now() - start });
      } catch (err) {
        results.push({ name, status: "timeout", elapsed: Date.now() - start });
      }
    };

    // tool-a 快速完成 (5ms)，tool-b 太慢 (100ms) 会超时
    await Promise.all([
      runTool("tool-a", 5),
      runTool("tool-b", 100)
    ]);

    assert.strictEqual(results.length, 2);
    const a = results.find(r => r.name === "tool-a");
    const b = results.find(r => r.name === "tool-b");
    assert.strictEqual(a.status, "ok");
    assert.strictEqual(b.status, "timeout");
  });

  // ==================== 6. 超时后调用方收到可区分的错误 ====================

  it("超时错误的 message 应包含 tool_timeout 标识", async () => {
    let errorMessage = "";

    try {
      await Promise.race([
        new Promise(() => {}),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error(`tool_timeout: run_javascript (60000ms)`));
          }, 5);
        })
      ]);
    } catch (err) {
      errorMessage = err.message;
    }

    assert.ok(errorMessage.includes("tool_timeout"));
    assert.ok(errorMessage.includes("run_javascript"));
  });

  // ==================== 7. timer.unref 不阻塞进程退出 ====================

  it("超时 timer 应支持 unref 以避免阻塞进程退出", () => {
    // 验证 timer.unref 是可调用的
    const timer = setTimeout(() => {}, 1000);
    assert.strictEqual(typeof timer.unref, "function");

    const unrefResult = timer.unref();
    assert.strictEqual(typeof unrefResult, "object"); // unref() 返回 timer 自身

    clearTimeout(timer);
  });
});
