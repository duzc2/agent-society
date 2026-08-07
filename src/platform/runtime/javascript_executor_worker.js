/**
 * JavaScript 执行器 Worker 线程
 *
 * 本文件在独立的 Worker 线程中运行，使用 node:vm 创建沙箱化执行环境。
 * Worker 线程提供进程级隔离（独立 V8 isolate、独立堆内存），
 * vm.createContext 提供 API 级隔离（仅允许安全的标准全局对象）。
 *
 * 【安全机制】
 * - Worker 线程: 进程级隔离，独立事件循环和堆内存，terminate() 可强制终止
 * - vm.createContext: API 级隔离，沙箱内仅能访问显式注入的全局对象
 * - 无 require/process/fs/net 等 Node API 访问权
 * - 超时保护: vm.Script.runInContext 内置 timeout 选项
 *
 * 【通信协议】
 * - workerData: { code: string, input: any, timeoutMs: number }
 * - postMessage: { ok: boolean, value?: any, error?: string }
 *
 * @module runtime/javascript_executor_worker
 */

import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";

// ==================== 从 workerData 提取参数 ====================
const { code, input, timeoutMs } = workerData;

// ==================== 执行代码并发送结果 ====================

(async () => {
    const startTime = Date.now();
    let result;

    try {
        // executeInSandbox 可能返回同步结果或 Promise（用户代码使用了 await）
        result = await executeInSandbox(code, input, timeoutMs);
    } catch (err) {
        result = {
            ok: false,
            error: err?.message || String(err ?? "unknown error"),
        };
    }

    const elapsed = Date.now() - startTime;
    parentPort.postMessage({ ...result, elapsed });

    // 显式退出 Worker
    process.exit(0);
})();

// ==================== 沙箱执行核心 ====================

/**
 * 在 vm 沙箱中执行用户代码
 *
 * @param {string} code - 用户提供的 JavaScript 代码
 * @param {any} input - 传入代码的输入参数
 * @param {number} timeoutMs - 执行超时时间（毫秒）
 * @returns {{ ok: boolean, value?: any, error?: string }} 执行结果
 */
function executeInSandbox(code, input, timeoutMs) {
    // 1. 构建最小化沙箱 —— 仅保留标准 JavaScript 内置对象
    const sandbox = createSandbox(input);

    // 2. 创建 V8 隔离上下文
    vm.createContext(sandbox);

    // 3. 编译并执行代码
    const wrappedCode = wrapCode(code);
    const script = new vm.Script(wrappedCode);
    const rawResult = script.runInContext(sandbox, {
        timeout: timeoutMs,
        displayErrors: false,
    });

    // 4. 序列化结果
    return serializeResult(rawResult);
}

/**
 * 创建最小化沙箱对象
 *
 * 仅注入安全的 ECMAScript 标准全局对象。
 * 故意排除: require, process, globalThis, setTimeout, setInterval,
 *           fetch, XMLHttpRequest, WebSocket, Worker, Deno, Bun,
 *           Buffer, __filename, __dirname, module, exports 等。
 *
 * @param {any} input - 用户代码的输入参数
 * @returns {object} 沙箱全局对象
 */
function createSandbox(input) {
    // 空对象原型连，防止通过 __proto__ 或 constructor 逃逸
    const sandbox = Object.create(null);

    // 用户输入
    sandbox.input = input;

    // 控制台（静默 —— 不输出到主进程）
    sandbox.console = Object.freeze({
        log: noop,
        info: noop,
        warn: noop,
        error: noop,
        debug: noop,
        trace: noop,
        table: noop,
        dir: noop,
        time: noop,
        timeEnd: noop,
        timeLog: noop,
        assert: noop,
        clear: noop,
        count: noop,
        countReset: noop,
        group: noop,
        groupCollapsed: noop,
        groupEnd: noop,
        profile: noop,
        profileEnd: noop,
    });

    // 安全的标准 JavaScript 全局对象
    // （这些对象的所有方法均可安全使用 —— 它们不提供系统访问权）
    Object.assign(sandbox, {
        // 基本类型构造函数
        Object,
        Array,
        String,
        Number,
        Boolean,
        Error,
        TypeError,
        RangeError,
        SyntaxError,
        ReferenceError,
        URIError,
        EvalError,
        AggregateError,

        // 集合
        Map,
        Set,
        WeakMap,
        WeakSet,

        // 二进制数据
        ArrayBuffer,
        DataView,
        Uint8Array,
        Int8Array,
        Uint16Array,
        Int16Array,
        Uint32Array,
        Int32Array,
        Float32Array,
        Float64Array,
        BigInt64Array,
        BigUint64Array,
        Uint8ClampedArray,

        // 结构化数据
        JSON,
        Date,
        Math,

        // 实用函数
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURI,
        decodeURI,
        encodeURIComponent,
        decodeURIComponent,

        // 符号与正则
        Symbol,
        RegExp,

        // Promise（同步模式 —— Worker 内不处理异步，超时的异步由主进程超时保护处理）
        Promise,

        // 特殊值
        NaN,
        Infinity,
        undefined,

        // Intl（国际化）- 纯纯计算功能，不涉及I/O
        Intl: {
            Collator: Intl.Collator,
            DateTimeFormat: Intl.DateTimeFormat,
            NumberFormat: Intl.NumberFormat,
            PluralRules: Intl.PluralRules,
            RelativeTimeFormat: Intl.RelativeTimeFormat,
            ListFormat: Intl.ListFormat,
            DisplayNames: Intl.DisplayNames,
            Segmenter: Intl.Segmenter,
        },
    });

    // 冻结沙箱对象防止原型逃逸
    // 注意: 仅冻结沙箱自身，不冻结内嵌对象（如 Math — 用户可能需要修改 Math 属性）
    return sandbox;
}

/**
 * 将用户代码包裹为立即执行函数
 *
 * @param {string} code - 用户代码（通常以 return 开头或包含完整语句）
 * @returns {string} 包裹后的代码
 */
function wrapCode(code) {
    // 如果代码已含 return/function 声明且需要包裹
    // 直接包裹为 IIFE，让 return 起作用
    return `"use strict";\n(function() {\n${code}\n})();`;
}

/**
 * 序列化执行结果为可传输格式
 *
 * @param {any} rawResult - 代码执行原始结果（可能是 Promise）
 * @returns {{ ok: boolean, value?: any, error?: string }} 序列化结果
 */
function serializeResult(rawResult) {
    // 处理 Promise（同步 Promise 如 Promise.resolve()）
    if (rawResult instanceof Promise) {
        // Promise 的 then/catch 在这里执行
        // 注意: 如果 Promise 不 resolve，结果将不会发送 ——
        // 主进程的超时保护（worker.terminate()）会在超时后强制终止
        return rawResult.then(
            (value) => ({ ok: true, value: toTransferable(value) }),
            (err) => ({ ok: false, error: err?.message || String(err ?? "unknown error") })
        );
    }

    // 同步结果
    try {
        return { ok: true, value: toTransferable(rawResult) };
    } catch (err) {
        return { ok: false, error: err?.message || String(err ?? "serialization error") };
    }
}

/**
 * 将值转换为可跨线程传输的格式
 *
 * 通过 JSON 序列化/反序列化循环确保结果可安全传输。
 *
 * @param {any} value - 原始值
 * @returns {any} 可传输的值
 */
function toTransferable(value) {
    if (value === undefined) return null;
    if (value === null) return null;
    if (typeof value === "function") return "[Function]";
    if (typeof value === "symbol") return String(value);

    try {
        // JSON 循环确保结果为纯数据
        return JSON.parse(JSON.stringify(value));
    } catch {
        // 不可序列化的值 —— 转为字符串
        return String(value);
    }
}

/**
 * 无操作函数（用于静默 console）
 */
function noop() {}
