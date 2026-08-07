/**
 * start.js 属性测试
 * Feature: server-start-command
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import fc from "fast-check";
import { parseArgs, getBrowserCommand } from "../start.js";

describe("start.js", () => {
  /**
   * Feature: server-start-command, Property 1: 参数解析正确性
   * For any valid command line arguments containing a data directory path,
   * the parseArgs function should correctly extract and return that path as the dataDir field.
   * Validates: Requirements 3.2
   */
  describe("Property 1: 参数解析正确性", () => {
    it("should use default dataDir when no arguments provided", () => {
      const result = parseArgs([]);
      assert.strictEqual(result.dataDir, "./agent-society-data");
    });

    it("should correctly parse positional argument as dataDir", () => {
      fc.assert(
        fc.property(
          // 生成不以 - 开头的路径字符串
          fc.string({ minLength: 1 }).filter(s => !s.startsWith("-") && s.trim().length > 0),
          (dataDir) => {
            const result = parseArgs([dataDir]);
            return result.dataDir === dataDir;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should handle dataDir with other arguments", () => {
      const result = parseArgs(["./custom-data", "--port", "3001"]);
      assert.strictEqual(result.dataDir, "./custom-data");
      assert.strictEqual(result.port, 3001);
    });

    it("should handle dataDir after other arguments", () => {
      const result = parseArgs(["--port", "3001", "./custom-data"]);
      assert.strictEqual(result.dataDir, "./custom-data");
      assert.strictEqual(result.port, 3001);
    });
  });

  /**
   * Feature: server-start-command, Property 2: 端口参数解析正确性
   * For any valid port number (1-65535) provided via --port or -p argument,
   * the parseArgs function should correctly extract and return that port number.
   * Validates: Requirements 4.2
   */
  describe("Property 2: 端口参数解析正确性", () => {
    it("should use null as default port when no port argument provided", () => {
      const result = parseArgs([]);
      assert.strictEqual(result.port, null);
    });

    it("should correctly parse --port argument with valid port numbers", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 65535 }),
          (port) => {
            const result = parseArgs(["--port", String(port)]);
            return result.port === port;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should correctly parse -p argument with valid port numbers", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 65535 }),
          (port) => {
            const result = parseArgs(["-p", String(port)]);
            return result.port === port;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should use null for invalid port numbers", () => {
      const result1 = parseArgs(["--port", "invalid"]);
      assert.strictEqual(result1.port, null);

      const result2 = parseArgs(["--port", "0"]);
      assert.strictEqual(result2.port, null);

      const result3 = parseArgs(["--port", "70000"]);
      assert.strictEqual(result3.port, null);
    });
  });

  /**
   * Feature: server-start-command, Property 3: 操作系统检测正确性
   * For any supported platform identifier (darwin, win32, linux),
   * the getBrowserCommand function should return the appropriate browser opening command.
   * Validates: Requirements 5.3
   */
  describe("Property 3: 操作系统检测正确性", () => {
    it("should return 'open' for darwin (macOS)", () => {
      assert.strictEqual(getBrowserCommand("darwin"), "open");
    });

    it("should return 'start' for win32 (Windows)", () => {
      assert.strictEqual(getBrowserCommand("win32"), "start");
    });

    it("should return 'xdg-open' for linux", () => {
      assert.strictEqual(getBrowserCommand("linux"), "xdg-open");
    });

    it("should return 'xdg-open' for unknown platforms", () => {
      fc.assert(
        fc.property(
          fc.string().filter(s => s !== "darwin" && s !== "win32"),
          (platform) => {
            return getBrowserCommand(platform) === "xdg-open";
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("--no-browser 参数", () => {
    it("should set openBrowser to true by default", () => {
      const result = parseArgs([]);
      assert.strictEqual(result.openBrowser, true);
    });

    it("should set openBrowser to false when --no-browser is provided", () => {
      const result = parseArgs(["--no-browser"]);
      assert.strictEqual(result.openBrowser, false);
    });

    it("should handle --no-browser with other arguments", () => {
      const result = parseArgs(["./data", "--port", "3001", "--no-browser"]);
      assert.strictEqual(result.dataDir, "./data");
      assert.strictEqual(result.port, 3001);
      assert.strictEqual(result.openBrowser, false);
    });
  });
});
