/**
 * 统一测试日志工具 — test/helpers/test_logger.js
 *
 * 所有测试文件的日志必须从此处导入，禁止各自定义。
 * 日志直接输出到 console，测试运行时可看到完整日志输出。
 *
 * 用法：
 *   import { makeTestLogger, testLoggerRoot } from "../helpers/test_logger.js";
 *
 *   const log = makeTestLogger("MyModule");
 *   log.info("启动", { port: 3000 });
 *   log.error("失败", { error: err.message });
 */

/**
 * 创建一个输出到 console 的测试日志器。
 * @param {string} prefix - 模块名前缀，必填
 */
export function makeTestLogger(prefix) {
  return {
    debug: (msg, data) => {
      if (data !== undefined) console.log(`[${prefix}][DEBUG]`, msg, data);
      else console.log(`[${prefix}][DEBUG]`, msg);
    },
    info: (msg, data) => {
      if (data !== undefined) console.log(`[${prefix}][INFO]`, msg, data);
      else console.log(`[${prefix}][INFO]`, msg);
    },
    warn: (msg, data) => {
      if (data !== undefined) console.warn(`[${prefix}][WARN]`, msg, data);
      else console.warn(`[${prefix}][WARN]`, msg);
    },
    error: (msg, data) => {
      if (data !== undefined) console.error(`[${prefix}][ERROR]`, msg, data);
      else console.error(`[${prefix}][ERROR]`, msg);
    },
  };
}

/**
 * 模拟 Runtime 的 loggerRoot.forModule() 工厂。
 */
export const testLoggerRoot = {
  forModule(name) {
    return makeTestLogger(name);
  },
};
