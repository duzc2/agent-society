import { describe, it } from "node:test";
import assert from "node:assert";
import { ToolExecutor } from "../../../src/platform/runtime/tool_executor.js";
import { makeTestLogger, testLoggerRoot } from "../../helpers/test_logger.js";

/**
 * 创建最小运行时桩对象。
 *
 * 设计约束：
 * - 这里只验证 send_message 的参数归一化和消息发送行为；
 * - 不引入无关依赖，避免测试因为其他模块变化而脆弱。
 *
 * @returns {{runtime: any, sentMessages: any[]}}
 */
function createRuntimeStub() {
  const sentMessages = [];
  const runtime = {
    _agents: new Map([["receiver", { id: "receiver" }]]),
    org: {
      getAgent: () => ({ status: "active" })
    },
    log: makeTestLogger("ToolExecutor"),
    _agentManager: {
      logLifecycleEvent: () => {}
    },
    loggerRoot: testLoggerRoot
  };

  return { runtime, sentMessages };
}

describe("ToolExecutor send_message 参数兼容", () => {
  /**
   * 验证旧写法 message 能被自动包装为 payload.text。
   */
  it("应兼容 message 字段并保留正文", () => {
    const { runtime, sentMessages } = createRuntimeStub();
    const toolExecutor = new ToolExecutor(runtime);

    const ctx = {
      agent: { id: "sender" },
      currentMessage: { taskId: "task-1" },
      tools: {
        sendMessage: (message) => {
          sentMessages.push(message);
          return { messageId: "msg-1" };
        }
      }
    };

    const result = toolExecutor._executeSendMessage(ctx, {
      to: "receiver",
      message: "这是一条正文"
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(sentMessages.length, 1);
    assert.deepStrictEqual(sentMessages[0].payload, { text: "这是一条正文" });
  });

  /**
   * 验证 quickReplies 会和兼容写法一起写入 payload。
   */
  it("应在 message 写法下继续附加 quickReplies", () => {
    const { runtime, sentMessages } = createRuntimeStub();
    const toolExecutor = new ToolExecutor(runtime);

    const ctx = {
      agent: { id: "sender" },
      currentMessage: { taskId: "task-2" },
      tools: {
        sendMessage: (message) => {
          sentMessages.push(message);
          return { messageId: "msg-2" };
        }
      }
    };

    const result = toolExecutor._executeSendMessage(ctx, {
      to: "receiver",
      message: "请查收",
      quickReplies: ["收到", "继续"]
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(sentMessages[0].payload, {
      text: "请查收",
      quickReplies: ["收到", "继续"]
    });
  });

  /**
   * 验证完全缺失消息体时返回明确错误，避免静默发送空消息。
   */
  it("缺失 payload/message/text 时应返回错误", () => {
    const { runtime } = createRuntimeStub();
    const toolExecutor = new ToolExecutor(runtime);

    const ctx = {
      agent: { id: "sender" },
      currentMessage: { taskId: "task-3" },
      tools: {
        sendMessage: () => ({ messageId: "msg-3" })
      }
    };

    const result = toolExecutor._executeSendMessage(ctx, {
      to: "receiver"
    });

    assert.strictEqual(result.error, "missing_payload");
  });
});
