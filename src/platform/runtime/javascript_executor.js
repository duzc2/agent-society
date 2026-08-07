/**
 * JavaScript 执行器模块
 *
 * 本模块负责安全执行用户提供的 JavaScript 代码，是 Runtime 的子模块之一。
 *
 * 【设计初衷】
 * 智能体在处理任务时，经常需要进行精确计算、数据转换、日期处理等操作。
 * 由于 LLM 在数值计算方面不够可靠，因此提供一个安全的 JavaScript 执行环境，
 * 让智能体可以通过代码来完成这些需要精确结果的任务。
 *
 * 【主要功能】
 * 1. 执行用户提供的 JavaScript 代码
 * 2. 检测并阻止危险代码模式（如文件系统、网络访问等）
 * 3. 支持 Canvas 绘图功能
 * 4. 将执行结果转换为 JSON 安全格式
 *
 * 【安全机制】
 * - 纯计算代码在独立 Worker 线程中执行，提供进程级隔离（独立 V8 isolate）
 * - Worker 内使用 node:vm 创建沙箱化上下文，仅注入安全的 ECMAScript 全局对象
 * - Canvas / downloadToWorkspace 函数在主线程 vm 沙箱中执行（需要主线程资源）
 * - 危险代码模式检测作为防御性预过滤
 *
 * 【使用流程】
 * 1. Runtime 收到 run_javascript 工具调用
 * 2. 调用 JavaScriptExecutor.execute() 执行代码
 * 3. 返回执行结果或错误信息
 *
 * 【与其他模块的关系】
 * - 被 ToolExecutor 调用来处理 run_javascript 工具
 * - 使用 WorkspaceManager 存储 Canvas 生成的图像
 *
 * @module runtime/javascript_executor
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import vm from "node:vm";
import { getWorkspaceManager } from "../services/workspace/workspace_manager.js";
import { getErrorMessage } from "../utils/error_utils.js";
import { detectBlockedTokens as _detectBlockedFn } from "./blocked_tokens.js";

// ==================== 默认超时配置 ====================

/**
 * vm 沙箱内执行代码的默认超时（毫秒）
 * 这是 vm.Script.runInContext 的内置超时，用于防止无限循环。
 * 设为 300s，允许长时间运行的合法计算。
 */
const DEFAULT_VM_TIMEOUT_MS = 300_000;

// ==================== 工具函数 ====================

/**
 * 将输入内容转换为 Buffer
 * 支持 ArrayBuffer、TypedArray、Blob、字符串等多种类型
 *
 * @param {ArrayBuffer|Int8Array|Uint8Array|Uint8ClampedArray|Int16Array|Uint16Array|Int32Array|Uint32Array|Float32Array|Float64Array|BigInt64Array|BigUint64Array|Blob|string} content - 输入内容
 * @returns {Promise<Buffer>} Node.js Buffer 对象
 */
async function convertToBuffer(content) {
  // 处理 null/undefined
  if (content == null) {
    return Buffer.alloc(0);
  }

  // 处理 ArrayBuffer
  if (content instanceof ArrayBuffer) {
    return Buffer.from(content);
  }

  // 处理 TypedArray (Uint8Array, Int8Array, Uint16Array 等)
  if (ArrayBuffer.isView(content)) {
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  }

  // 处理 Blob (Node.js 18+ 支持 Blob)
  if (typeof Blob !== 'undefined' && content instanceof Blob) {
    const arrayBuffer = await content.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  // 处理字符串
  if (typeof content === 'string') {
    return Buffer.from(content, 'utf8');
  }

  // 处理数字等其他类型，转为字符串
  return Buffer.from(String(content), 'utf8');
}

/**
 * 验证文件路径是否安全
 * 路径必须是相对于工作区的子路径，不能使用 .. 向上遍历
 *
 * @param {string} filepath - 要验证的文件路径
 * @returns {{valid: boolean, error?: string}} 验证结果
 */
function validateFilePath(filepath) {
  if (!filepath || typeof filepath !== 'string') {
    return { valid: false, error: "filepath must be a non-empty string" };
  }

  // 检查是否为绝对路径
  if (path.isAbsolute(filepath)) {
    return { valid: false, error: "filepath must be relative, not absolute" };
  }

  // 规范化路径并检查是否包含 ..
  const normalized = path.normalize(filepath);
  const parts = normalized.split(path.sep);

  // 检查任何部分是否为 ..
  for (const part of parts) {
    if (part === '..') {
      return { valid: false, error: "filepath cannot contain '..' to traverse upward" };
    }
  }

  // 检查路径是否以 .. 开头
  if (normalized.startsWith('..')) {
    return { valid: false, error: "filepath cannot start with '..'" };
  }

  return { valid: true };
}

/**
 * 检测代码是否引用了需要主线程资源的函数（Canvas / downloadToWorkspace）
 *
 * @param {string} code - 用户代码
 * @returns {boolean} 是否需要主线程执行
 */
function needsMainThreadExecution(code) {
  return /\bgetCanvas\s*\(/.test(code) || /\bdownloadToWorkspace\s*\(/.test(code);
}

// ==================== Worker 路径 ====================

/** @type {string|null} Worker 脚本文件的绝对路径，延迟计算 */
let _workerPath = null;

/**
 * 获取 Worker 脚本的绝对路径（兼容 Bun 和 Node.js）
 * Node.js Worker 不接受 file:// 字符串 URL，但接受绝对路径。
 * @returns {string}
 */
function getWorkerPath() {
  if (!_workerPath) {
    _workerPath = fileURLToPath(new URL("./javascript_executor_worker.js", import.meta.url));
  }
  return _workerPath;
}

// ==================== JavaScriptExecutor 类 ====================

/**
 * JavaScript 执行器类
 *
 * 提供安全的 JavaScript 代码执行环境，支持 Canvas 绘图。
 *
 * 【执行策略】
 * - 纯计算代码 → Worker 线程 + vm 沙箱（进程级隔离）
 * - Canvas / downloadToWorkspace → 主线程 vm 沙箱（需主线程资源）
 */
export class JavaScriptExecutor {
  /**
   * 创建 JavaScript 执行器实例
   *
   * @param {object} runtime - Runtime 实例引用，用于访问工作区等共享资源
   */
  constructor(runtime) {
    this.log = runtime.loggerRoot.forModule("js_executor");

    /** vm.Script 超时时间（毫秒），防止无限循环 */
    this.vmTimeoutMs = DEFAULT_VM_TIMEOUT_MS;
  }

  /**
   * 执行 JavaScript 代码
   *
   * 【执行流程】
   * 1. 验证代码参数
   * 2. 检测危险代码模式（防御性预过滤）
   * 3. 判断代码类型:
   *    - 纯计算 → Worker 线程 + vm 沙箱执行
   *    - Canvas/download → 主线程 vm 沙箱执行
   * 4. 返回 JSON 安全的结果
   *
   * @param {object} args - 执行参数
   * @param {string} args.code - 要执行的 JavaScript 代码（函数体形式）
   * @param {any} [args.input] - 传入代码的输入参数
   * @param {string|null} [workspaceId] - 关联的工作区ID
   * @param {string|null} [messageId] - 关联的消息ID（用于 Canvas 图像元数据）
   * @param {string|null} [agentId] - 关联的智能体ID（用于 Canvas 图像元数据）
   * @returns {Promise<any>} 执行结果或错误对象
   *
   * @example
   * // 简单计算
   * const result = await executor.execute({ code: 'return 1 + 2;' });
   * // result: 3
   *
   * @example
   * // 使用输入参数
   * const result = await executor.execute({
   *   code: 'return input.a + input.b;',
   *   input: { a: 1, b: 2 }
   * });
   * // result: 3
   *
   * @example
   * // Canvas 绘图
   * const result = await executor.execute({
   *   code: `
   *     const canvas = getCanvas('charts/my-chart.png', 400, 300);
   *     const ctx = canvas.getContext('2d');
   *     ctx.fillStyle = 'red';
   *     ctx.fillRect(50, 50, 100, 100);
   *     return 'done';
   *   `
   * }, 'ws-123');
   * // result: { result: 'done', paths: ['charts/my-chart.png'] }
   */
  async execute(args, workspaceId = null, messageId = null, agentId = null) {
    const code = args?.code;
    const input = args?.input;

    // 1. 验证代码参数
    if (typeof code !== "string") {
      return { error: "invalid_args", message: "code must be a string" };
    }

    // 2. 防御性预过滤: 检测危险代码模式
    const blockResult = this.detectBlockedTokens(code);
    if (blockResult.blocked.length > 0) {
      return { error: "blocked_code", blocked: blockResult.blocked, message: blockResult.message };
    }

    // 3. 判断执行路径: 纯计算 → Worker, Canvas/download → 主线程 vm
    if (needsMainThreadExecution(code)) {
      return await this._executeWithCapabilities(
        code, input, workspaceId, messageId, agentId
      );
    }

    return await this._executeInWorker(code, input);
  }

  // ==================== Worker 线程执行路径 ====================

  /**
   * 在独立 Worker 线程中执行纯计算代码
   *
   * Worker 提供进程级隔离（独立 V8 isolate、独立堆内存），
   * 内部使用 node:vm 创建沙箱化上下文，仅允许安全的 ECMAScript 全局对象。
   * 超时由 vm.Script.runInContext({ timeout }) 提供，允许长时间运行的合法计算。
   *
   * @param {string} code - 用户代码
   * @param {any} input - 输入参数
   * @returns {Promise<any>} 执行结果
   * @private
   */
  async _executeInWorker(code, input) {
    const workerPath = getWorkerPath();
    /** @type {Worker|null} */
    let worker = null;

    try {
      // 创建 Worker 线程，通过 workerData 限制输入数据
      worker = new Worker(workerPath, {
        workerData: {
          code,
          input: input !== undefined ? input : null,
          timeoutMs: this.vmTimeoutMs,
        },
      });

      // 等待 Worker 结果
      const result = await new Promise((resolve, reject) => {
        // 接收 Worker 消息
        worker.on("message", (msg) => resolve(msg));

        // Worker 错误处理
        worker.on("error", (err) => reject(err));

        // Worker 异常退出（非零退出码）
        worker.on("exit", (exitCode) => {
          if (exitCode !== 0) {
            reject(new Error(
              `JavaScript 执行器异常退出 (exit code: ${exitCode})`
            ));
          }
        });
      });

      // 4. 处理 Worker 返回结果
      if (!result || result.error) {
        return {
          error: "js_execution_failed",
          message: result?.error || "Unknown worker error",
        };
      }

      if (!result.ok) {
        return { error: "js_execution_failed", message: result.error };
      }

      // Worker 返回的是已通过 JSON 序列化的纯数据，但仍需检查大小上限
      const jsonSafe = this.toJsonSafeValue(result.value);
      if (jsonSafe.error) return jsonSafe;

      return jsonSafe.value;
    } catch (err) {
      const message = getErrorMessage(err);

      this.log.error("Worker 执行 JavaScript 失败", {
        error: message,
      });

      return { error: "js_execution_failed", message };
    } finally {
      if (worker) {
        try { worker.terminate(); } catch {}
      }
    }
  }

  // ==================== 主线程 vm 执行路径 (Canvas / download) ====================

  /**
   * 在主线程中使用 vm 沙箱执行需要 Canvas 或 downloadToWorkspace 的代码
   *
   * Canvas 和 downloadToWorkspace 需要访问主线程资源（@napi-rs/canvas、WorkspaceManager），
   * 因此不能放入 Worker。但仍使用 node:vm 沙箱化上下文来防止 API 逃逸。
   *
   * @param {string} code - 用户代码
   * @param {any} input - 输入参数
   * @param {string|null} workspaceId - 工作区ID
   * @param {string|null} messageId - 消息ID
   * @param {string|null} agentId - Agent ID
   * @returns {Promise<any>} 执行结果
   * @private
   */
  async _executeWithCapabilities(code, input, workspaceId, messageId, agentId) {
    // --- Canvas 预加载 ---
    const canvasInstances = [];
    let createCanvasFn = null;
    let canvasError = null;

    try {
      const canvasModule = await import("@napi-rs/canvas");
      createCanvasFn = canvasModule.createCanvas;
    } catch (err) {
      canvasError = err;
    }

    // --- getCanvas 函数 ---
    const getCanvas = (name, width = 800, height = 600) => {
      if (typeof name !== "string" || name.trim() === "") {
        throw new Error("getCanvas: name 参数是必需的，且必须是非空字符串");
      }
      if (!createCanvasFn) {
        throw new Error("Canvas 功能不可用，请确保 @napi-rs/canvas 包已安装");
      }
      const newCanvas = createCanvasFn(width, height);
      /** @type {any} */ (newCanvas)._name = name.trim();
      canvasInstances.push(newCanvas);
      return newCanvas;
    };

    // --- downloadToWorkspace 函数 ---
    const downloadResults = [];
    const downloadToWorkspace = async (filepath, mimeType, content) => {
      if (!filepath || typeof filepath !== "string") {
        throw new Error("downloadToWorkspace: filepath must be a non-empty string");
      }
      if (!mimeType || typeof mimeType !== "string") {
        throw new Error("downloadToWorkspace: mimeType must be a non-empty string");
      }
      if (content === undefined) {
        throw new Error("downloadToWorkspace: content is required");
      }
      if (!workspaceId) {
        throw new Error("downloadToWorkspace: workspaceId is required");
      }

      const pathValidation = validateFilePath(filepath);
      if (!pathValidation.valid) {
        throw new Error(`downloadToWorkspace: invalid filepath - ${pathValidation.error}`);
      }

      const buffer = await convertToBuffer(content);

      try {
        const ws = await getWorkspaceManager().getWorkspace(workspaceId);
        await ws.writeFile(filepath, buffer, {
          mimeType,
          operator: agentId,
          messageId,
        });

        downloadResults.push(filepath);

        this.log.info("downloadToWorkspace 文件已保存", {
          workspaceId,
          filepath,
          mimeType,
          size: buffer.length,
          agentId,
          messageId,
        });

        return { success: true, path: filepath, size: buffer.length };
      } catch (err) {
        const msg = getErrorMessage(err);
        this.log.error("downloadToWorkspace 保存失败", {
          workspaceId,
          filepath,
          error: msg,
        });
        throw new Error(`downloadToWorkspace failed: ${msg}`);
      }
    };

    // --- vm 沙箱执行 ---
    try {
      // 构建沙箱 —— 注入安全全局对象 + Canvas/download 函数
      const sandbox = this._buildMainThreadSandbox(input, getCanvas, downloadToWorkspace);

      const wrappedCode = `"use strict";\n(function() {\n${code}\n})();`;
      const script = new vm.Script(wrappedCode);
      let value = script.runInContext(sandbox, {
        timeout: this.vmTimeoutMs,
        displayErrors: false,
      });

      // 处理 Promise 返回值
      if (
        value &&
        (typeof value === "object" || typeof value === "function") &&
        typeof value.then === "function"
      ) {
        value = await value;
      }

      // JSON 安全转换
      const jsonSafe = this.toJsonSafeValue(value);
      if (jsonSafe.error) return jsonSafe;

      // Canvas 导出
      if (canvasInstances.length > 0) {
        if (!workspaceId) {
          return {
            result: jsonSafe.value,
            error: "workspace_required",
            message: "使用 Canvas 功能需要提供 workspaceId",
          };
        }
        return await this._saveAllCanvasImages(
          workspaceId, canvasInstances, jsonSafe.value, messageId, agentId
        );
      }

      // downloadToWorkspace 结果
      if (downloadResults.length > 0) {
        return { result: jsonSafe.value, downloadPaths: downloadResults };
      }

      return jsonSafe.value;
    } catch (err) {
      const message = getErrorMessage(err);

      if (canvasError) {
        return {
          error: "canvas_not_available",
          message: "Canvas 功能不可用，请安装 @napi-rs/canvas 包",
        };
      }
      return { error: "js_execution_failed", message };
    }
  }

  /**
   * 构建主线程 vm 沙箱（用于 Canvas/download 代码执行）
   *
   * 与 Worker 沙箱不同，此沙箱额外提供 getCanvas 和 downloadToWorkspace 函数。
   *
   * @param {any} input - 输入参数
   * @param {Function} getCanvas - Canvas 创建函数
   * @param {Function} downloadToWorkspace - 文件下载函数
   * @returns {object} vm 上下文对象
   * @private
   */
  _buildMainThreadSandbox(input, getCanvas, downloadToWorkspace) {
    const sandbox = Object.create(null);

    sandbox.input = input;
    sandbox.getCanvas = getCanvas;
    sandbox.downloadToWorkspace = downloadToWorkspace;

    // 控制台（静默）
    sandbox.console = Object.freeze({
      log() {}, info() {}, warn() {}, error() {}, debug() {},
      trace() {}, table() {}, dir() {},
    });

    // 安全的标准全局对象
    Object.assign(sandbox, {
      Object, Array, String, Number, Boolean,
      Error, TypeError, RangeError, SyntaxError, ReferenceError,
      Map, Set, WeakMap, WeakSet,
      ArrayBuffer, DataView,
      Uint8Array, Int8Array, Uint16Array, Int16Array,
      Uint32Array, Int32Array, Float32Array, Float64Array,
      BigInt64Array, BigUint64Array, Uint8ClampedArray,
      JSON, Date, Math,
      parseInt, parseFloat, isNaN, isFinite,
      encodeURI, decodeURI, encodeURIComponent, decodeURIComponent,
      Symbol, RegExp, Promise,
      NaN, Infinity, undefined,
    });

    vm.createContext(sandbox);
    return sandbox;
  }

  // ==================== Canvas 图像保存 ====================

  /**
   * 保存所有 Canvas 生成的图像到工作区
   *
   * @param {string} workspaceId - 工作区ID
   * @param {object[]} canvasInstances - Canvas 实例数组
   * @param {any} result - 代码执行结果
   * @param {string|null} messageId - 关联的消息ID
   * @param {string|null} agentId - 关联的智能体ID
   * @returns {Promise<object>} 包含结果和图像文件路径数组的对象
   * @private
   */
  async _saveAllCanvasImages(workspaceId, canvasInstances, result, messageId, agentId) {
    const imagePaths = [];
    const errors = [];

    try {
      const ws = await getWorkspaceManager().getWorkspace(workspaceId);

      for (let i = 0; i < canvasInstances.length; i++) {
        const canvas = canvasInstances[i];

        // 验证 name 必须存在且以 .png 结尾
        if (!canvas._name || typeof canvas._name !== 'string' || canvas._name.trim() === '') {
          errors.push({ index: i, error: "Canvas 缺少必需的 name 属性" });
          continue;
        }
        const trimmedName = canvas._name.trim();
        if (!trimmedName.toLowerCase().endsWith('.png')) {
          errors.push({ index: i, error: "Canvas 路径必须以 .png 结尾" });
          continue;
        }

        try {
          const pngBuffer = await canvas.toBuffer("image/png");
          // 安全检查：只排除非法文件名字符：< > : " | ? *（保留 / 用于路径分隔，保留 \ 用于 Windows 路径）
          const fileName = trimmedName.replace(/[<>:"|?*]/g, '_');

          // 写入文件到工作区
          await ws.writeFile(fileName, pngBuffer, {
            mimeType: "image/png",
            operator: agentId,
            messageId,
            meta: {
              source: "canvas",
              width: canvas.width,
              height: canvas.height,
              canvasIndex: i
            }
          });

          imagePaths.push(fileName);

          this.log.info("保存 Canvas 图像到工作区", {
            workspaceId,
            fileName,
            userName: canvas._name.trim(),
            width: canvas.width,
            height: canvas.height,
            index: i,
            total: canvasInstances.length
          });
        } catch (exportErr) {
          const exportMessage = getErrorMessage(exportErr);
          errors.push({ index: i, error: exportMessage });
          this.log.error("保存 Canvas 图像失败", {
            workspaceId,
            index: i,
            error: exportMessage
          });
        }
      }
    } catch (wsErr) {
      const message = getErrorMessage(wsErr);
      this.log.error("获取工作区失败", { workspaceId, error: message });
      return { result, error: "workspace_error", message: `无法获取工作区 ${workspaceId}: ${message}` };
    }

    if (imagePaths.length === 0 && errors.length > 0) {
      const errorMessage = "所有 Canvas 导出均失败: " + JSON.stringify(errors);
      this.log.error("Canvas 导出完全失败", { workspaceId, errors });
      return { result, error: "canvas_export_failed", message: errorMessage, errors };
    }

    /** @type {{result: any, paths: string[], partialErrors?: Array<{index: number, error: string}>}} */
    const response = { result, paths: imagePaths };
    if (errors.length > 0) {
      response.partialErrors = errors;
      this.log.warn("部分 Canvas 导出失败", { workspaceId, errorCount: errors.length, errors });
    }
    return response;
  }

  // ==================== 危险代码检测 ====================

  /**
   * 检测代码中的危险模式（防御性预过滤）
   *
   * 注意：此检测是防御性的补充措施。主要安全由 Worker + vm 沙箱提供。
   * 即使此检测被绕过，沙箱隔离仍会阻止危险操作。
   *
   * @param {string} code - 要检测的代码
   * @returns {string[]} 检测到的危险模式名称数组
   */
  detectBlockedTokens(code) {
    return _detectBlockedFn(code);
  }

  // ==================== JSON 安全转换 ====================

  /**
   * 将值转换为 JSON 安全格式
   *
   * 【转换规则】
   * - undefined 转换为 null
   * - 检查结果是否可以 JSON 序列化
   * - 限制结果大小不超过 200KB
   *
   * @param {any} value - 要转换的值
   * @returns {{value?: any, error?: string, maxJsonLength?: number, jsonLength?: number, message?: string}} 转换结果或错误
   */
  toJsonSafeValue(value) {
    if (value === undefined) return { value: null };
    try {
      const json = JSON.stringify(value);
      if (json === undefined) return { value: null };
      if (json.length > 200000) {
        return { error: "result_too_large", maxJsonLength: 200000, jsonLength: json.length };
      }
      return { value: JSON.parse(json) };
    } catch (err) {
      const message = getErrorMessage(err);
      return { error: "non_json_serializable_return", message };
    }
  }
}
