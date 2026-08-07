import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * 技能运行时解析器。
 *
 * 责任：
 * 1. 记录系统启动时实际使用的 JavaScript 运行时及其可执行文件路径。
 * 2. 解析 Python 运行时优先级。
 * 3. 为技能安装与脚本执行提供统一的运行时入口。
 */
export class SkillsRuntimeResolver {
  /**
   * @param {{
   *   rootDir:string,
   *   config?:any,
   *   logger?:any,
   *   startupExecPath?:string,
   *   startupRuntimeKind?:'bun'|'node'|'unknown',
   *   startupRuntimeVersion?:string|null
   * }} options
   */
  constructor(options) {
    this.rootDir = options.rootDir;
    this.config = options.config ?? {};
    this.log = options.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    this.runtimeDir = path.join(this.rootDir, "runtime");
    this.startupExecPath = this._normalizeFilePath(options.startupExecPath) ?? this._normalizeFilePath(process.execPath);
    this.startupRuntimeKind = options.startupRuntimeKind ?? null;
    this.startupRuntimeVersion = typeof options.startupRuntimeVersion === "string"
      ? options.startupRuntimeVersion
      : null;
    this.javascriptRuntimeCache = null;
    this.bunInfoCache = null;
    this.pythonPolicyCache = null;
    this.nodeStripTypesSupportCache = null;
  }

  /**
   * 初始化运行时记录。
   * @returns {Promise<void>}
   */
  async initialize() {
    await mkdir(this.runtimeDir, { recursive: true });
    await this.detectStartupJavaScriptRuntime();
    await this.resolvePythonRuntime();
  }

  /**
   * 检测并保存启动时的 JavaScript 运行时信息。
   * 设计约束：
   * 1. JS/TS 技能脚本必须复用当前系统启动时的同一运行时。
   * 2. 记录应优先反映真实启动进程，而不是额外配置的其他可执行文件。
   * @returns {Promise<any>}
   */
  async detectStartupJavaScriptRuntime() {
    const execPath = this.startupExecPath;
    const runtimeKind = this._resolveStartupJavaScriptRuntimeKind(execPath);

    /** @type {any} */
    const record = {
      kind: runtimeKind,
      path: execPath || null,
      version: this._resolveStartupJavaScriptRuntimeVersion(runtimeKind),
      sourceType: this._inferExecutableSourceType(execPath),
      detectedAt: new Date().toISOString()
    };

    if (runtimeKind === "unknown") {
      record.detectedProcessPath = execPath || null;
    }

    this.javascriptRuntimeCache = record;
    this.bunInfoCache = runtimeKind === "bun"
      ? {
          path: record.path,
          version: record.version,
          sourceType: record.sourceType,
          detectedAt: record.detectedAt
        }
      : {
          path: null,
          version: null,
          sourceType: "unavailable",
          detectedAt: record.detectedAt,
          detectedProcessPath: record.path || null
        };
    return record;
  }

  /**
   * 读取启动时 JavaScript 运行时记录。
   * @returns {Promise<any>}
   */
  async getJavaScriptRuntimeInfo() {
    if (this.javascriptRuntimeCache) {
      return this.javascriptRuntimeCache;
    }
    return this.detectStartupJavaScriptRuntime();
  }

  /**
   * 读取启动时 JavaScript 运行时对应的可执行文件路径。
   * @returns {Promise<string|null>}
   */
  async getJavaScriptCommand() {
    const info = await this.getJavaScriptRuntimeInfo();
    if (info?.kind === "bun" || info?.kind === "node") {
      return typeof info.path === "string" && info.path.trim() ? info.path.trim() : null;
    }
    return null;
  }

  /**
   * 兼容旧接口：检测并保存启动 bun 信息。
   * @returns {Promise<any>}
   */
  async detectStartupBun() {
    await this.detectStartupJavaScriptRuntime();
    return this.getBunInfo();
  }

  /**
   * 兼容旧接口：读取 bun 记录。
   * @returns {Promise<any>}
   */
  async getBunInfo() {
    if (this.bunInfoCache) {
      return this.bunInfoCache;
    }
    await this.detectStartupJavaScriptRuntime();
    return this.bunInfoCache;
  }

  /**
   * 兼容旧接口：获取可用于执行 bun 命令的路径。
   * @returns {Promise<string|null>}
   */
  async getBunPath() {
    const info = await this.getBunInfo();
    return typeof info?.path === "string" && info.path.trim() ? info.path.trim() : null;
  }

  /**
   * 解析 Python 运行时策略。
   * 优先级：配置路径 > 工程内 venv > 系统 Python。
   * @returns {Promise<any>}
   */
  async resolvePythonRuntime() {
    const runtimeConfig = this.config ?? {};
    const configuredPythonPath = this._normalizeFilePath(runtimeConfig.pythonPath);
    const projectVenvDir = runtimeConfig.projectPythonVenvDir || "Python";
    const projectVenvPath = path.resolve(process.cwd(), projectVenvDir);
    const allowSystemPythonFallback = runtimeConfig.allowSystemPythonFallback !== false;
    const resolvedPath = this._resolvePythonExecutable(configuredPythonPath, projectVenvPath, allowSystemPythonFallback);

    const policy = {
      configuredPythonPath: configuredPythonPath || "",
      projectVenvPath,
      systemPythonFallback: allowSystemPythonFallback,
      selectionOrder: ["configured", "projectVenv", "system"],
      resolvedPath,
      detectedAt: new Date().toISOString()
    };

    this.pythonPolicyCache = policy;
    return policy;
  }

  /**
   * 读取 Python 策略。
   * @returns {Promise<any>}
   */
  async getPythonPolicy() {
    if (this.pythonPolicyCache) {
      return this.pythonPolicyCache;
    }
    return this.resolvePythonRuntime();
  }

  /**
   * 读取 Python 可执行文件路径。
   * @returns {Promise<string|null>}
   */
  async getPythonPath() {
    const policy = await this.getPythonPolicy();
    return typeof policy?.resolvedPath === "string" && policy.resolvedPath.trim()
      ? policy.resolvedPath.trim()
      : null;
  }

  /**
   * 根据脚本后缀返回执行器信息。
   * 设计约束：
   * 1. JS/TS 必须复用当前启动时的同一 JavaScript 运行时。
   * 2. 运行时不支持的脚本格式要尽早返回友好错误，不把底层细节直接暴露给上层。
   * @param {string} scriptPath
   * @returns {Promise<{
   *   runtime:'javascript'|'python'|null,
   *   command:string|null,
   *   argsPrefix:string[],
   *   engine:'bun'|'node'|'python'|null,
   *   scriptFormat:'javascript'|'typescript'|'python'|null,
   *   message:string|null
   * }>}
   */
  async resolveScriptCommand(scriptPath) {
    const ext = path.extname(String(scriptPath ?? "")).toLowerCase();
    if ([".js", ".mjs", ".cjs"].includes(ext)) {
      return this._resolveJavaScriptScriptCommand("javascript");
    }
    if ([".ts", ".mts", ".cts"].includes(ext)) {
      return this._resolveTypeScriptScriptCommand();
    }
    if (ext === ".py") {
      const pythonPath = await this.getPythonPath();
      return {
        runtime: pythonPath ? "python" : null,
        command: pythonPath,
        argsPrefix: [],
        engine: pythonPath ? "python" : null,
        scriptFormat: "python",
        message: pythonPath ? null : "当前环境未找到可用的 Python 运行时"
      };
    }
    return {
      runtime: null,
      command: null,
      argsPrefix: [],
      engine: null,
      scriptFormat: null,
      message: "当前技能脚本格式不受支持"
    };
  }

  /**
   * 解析用于执行 JS 包命令的运行时入口。
   * 设计约束：
   * 1. 命令执行必须复用系统启动时的同一 JavaScript 运行时。
   * 2. Node 启动时优先通过同一份 Node 驱动 npm CLI，而不是切换到其他执行器。
   * @param {{packageName:string, binaryName?:string}} options
   * @returns {Promise<{
   *   runtime:'javascript'|null,
   *   command:string|null,
   *   argsPrefix:string[],
   *   engine:'bun'|'node'|null,
   *   message:string|null
   * }>}
   */
  async resolvePackageCommand(options) {
    const runtimeInfo = await this.getJavaScriptRuntimeInfo();
    const packageName = typeof options?.packageName === "string" ? options.packageName.trim() : "";
    const binaryName = typeof options?.binaryName === "string" && options.binaryName.trim()
      ? options.binaryName.trim()
      : this._inferPackageBinaryName(packageName);

    if (!packageName || !binaryName) {
      return {
        runtime: null,
        command: null,
        argsPrefix: [],
        engine: null,
        message: "技能安装命令配置无效"
      };
    }

    if (runtimeInfo?.kind === "bun" && runtimeInfo.path) {
      return {
        runtime: "javascript",
        command: runtimeInfo.path,
        argsPrefix: ["x", packageName],
        engine: "bun",
        message: null
      };
    }

    if (runtimeInfo?.kind === "node" && runtimeInfo.path) {
      const npmCliPath = this._resolveNpmCliPath(runtimeInfo.path);
      if (!npmCliPath) {
        return {
          runtime: null,
          command: null,
          argsPrefix: [],
          engine: "node",
          message: "当前启动环境缺少可用于安装技能的 JS 包执行入口"
        };
      }
      return {
        runtime: "javascript",
        command: runtimeInfo.path,
        argsPrefix: [npmCliPath, "exec", "--yes", `--package=${packageName}`, "--", binaryName],
        engine: "node",
        message: null
      };
    }

    return {
      runtime: null,
      command: null,
      argsPrefix: [],
      engine: null,
      message: "当前环境未提供可用的 JavaScript 运行时"
    };
  }

  /**
   * 为普通 JavaScript 脚本构造执行命令。
   * @param {'javascript'} scriptFormat
   * @returns {Promise<{
   *   runtime:'javascript'|null,
   *   command:string|null,
   *   argsPrefix:string[],
   *   engine:'bun'|'node'|null,
   *   scriptFormat:'javascript',
   *   message:string|null
   * }>}
   */
  async _resolveJavaScriptScriptCommand(scriptFormat) {
    const runtimeInfo = await this.getJavaScriptRuntimeInfo();
    const command = await this.getJavaScriptCommand();
    return {
      runtime: command ? "javascript" : null,
      command,
      argsPrefix: [],
      engine: runtimeInfo?.kind === "bun" || runtimeInfo?.kind === "node" ? runtimeInfo.kind : null,
      scriptFormat,
      message: command ? null : "当前环境未提供可用的 JavaScript 运行时"
    };
  }

  /**
   * 为 TypeScript 脚本构造执行命令。
   * @returns {Promise<{
   *   runtime:'javascript'|null,
   *   command:string|null,
   *   argsPrefix:string[],
   *   engine:'bun'|'node'|null,
   *   scriptFormat:'typescript',
   *   message:string|null
   * }>}
   */
  async _resolveTypeScriptScriptCommand() {
    const runtimeInfo = await this.getJavaScriptRuntimeInfo();
    const command = await this.getJavaScriptCommand();
    if (!command) {
      return {
        runtime: null,
        command: null,
        argsPrefix: [],
        engine: null,
        scriptFormat: "typescript",
        message: "当前环境未提供可用的 JavaScript 运行时"
      };
    }

    if (runtimeInfo?.kind === "bun") {
      return {
        runtime: "javascript",
        command,
        argsPrefix: [],
        engine: "bun",
        scriptFormat: "typescript",
        message: null
      };
    }

    if (runtimeInfo?.kind === "node") {
      const supportsStripTypes = await this._supportsNodeStripTypes(command);
      if (supportsStripTypes) {
        return {
          runtime: "javascript",
          command,
          argsPrefix: ["--experimental-strip-types"],
          engine: "node",
          scriptFormat: "typescript",
          message: null
        };
      }
      return {
        runtime: null,
        command: null,
        argsPrefix: [],
        engine: "node",
        scriptFormat: "typescript",
        message: "当前启动环境不支持直接执行 TypeScript 技能脚本"
      };
    }

    return {
      runtime: null,
      command: null,
      argsPrefix: [],
      engine: null,
      scriptFormat: "typescript",
      message: "当前环境未提供可用的 JavaScript 运行时"
    };
  }

  /**
   * 判断指定 Node 可执行文件是否支持内置 TypeScript 类型剥离。
   * @param {string} nodeExecPath
   * @returns {Promise<boolean>}
   */
  async _supportsNodeStripTypes(nodeExecPath) {
    if (typeof this.nodeStripTypesSupportCache === "boolean") {
      return this.nodeStripTypesSupportCache;
    }

    try {
      const result = spawnSync(nodeExecPath, ["--help"], {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      this.nodeStripTypesSupportCache = output.includes("--experimental-strip-types");
    } catch {
      this.nodeStripTypesSupportCache = false;
    }

    return this.nodeStripTypesSupportCache;
  }

  /**
   * 根据启动进程推断 JavaScript 运行时类型。
   * @param {string|null} execPath
   * @returns {'bun'|'node'|'unknown'}
   */
  _resolveStartupJavaScriptRuntimeKind(execPath) {
    if (this.startupRuntimeKind === "bun" || this.startupRuntimeKind === "node" || this.startupRuntimeKind === "unknown") {
      return this.startupRuntimeKind;
    }

    if (typeof process.versions?.bun === "string" && process.versions.bun.trim()) {
      return "bun";
    }

    const execName = path.basename(execPath || "").toLowerCase();
    if (execName === "bun" || execName === "bun.exe") {
      return "bun";
    }
    if (execName === "node" || execName === "node.exe") {
      return "node";
    }
    return "unknown";
  }

  /**
   * 根据运行时类型解析版本号。
   * @param {'bun'|'node'|'unknown'} runtimeKind
   * @returns {string|null}
   */
  _resolveStartupJavaScriptRuntimeVersion(runtimeKind) {
    if (typeof this.startupRuntimeVersion === "string" && this.startupRuntimeVersion.trim()) {
      return this.startupRuntimeVersion.trim();
    }
    if (runtimeKind === "bun") {
      return typeof process.versions?.bun === "string" ? process.versions.bun : null;
    }
    if (runtimeKind === "node") {
      return typeof process.version === "string" ? process.version : null;
    }
    return null;
  }

  /**
   * 推断可执行文件来源类型。
   * @param {string|null} execPath
   * @returns {'embedded'|'system'|'configured'|'unknown'}
   */
  _inferExecutableSourceType(execPath) {
    const normalized = this._normalizeFilePath(execPath);
    if (!normalized) {
      return "unknown";
    }
    const lower = normalized.toLowerCase();
    const cwdLower = process.cwd().toLowerCase();
    if (lower.startsWith(cwdLower)) {
      return "embedded";
    }
    if (lower.includes("\\program files\\") || lower.includes("\\windows\\") || lower.includes("/usr/")) {
      return "system";
    }
    return "unknown";
  }

  /**
   * 解析 Node 对应的 npm CLI 路径。
   * @param {string} nodeExecPath
   * @returns {string|null}
   */
  _resolveNpmCliPath(nodeExecPath) {
    const configuredNpmCliPath = this._normalizeFilePath(this.config?.npmCliPath);
    if (configuredNpmCliPath && existsSync(configuredNpmCliPath)) {
      return configuredNpmCliPath;
    }

    const envNpmExecPath = this._normalizeFilePath(process.env.npm_execpath);
    if (envNpmExecPath && existsSync(envNpmExecPath)) {
      return envNpmExecPath;
    }

    const execDir = path.dirname(nodeExecPath);
    const execParentDir = path.dirname(execDir);
    const candidates = [
      path.join(execDir, "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(execParentDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(execParentDir, "lib64", "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(execParentDir, "node_modules", "npm", "bin", "npm-cli.js")
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * 从包名推断默认可执行二进制名。
   * @param {string} packageName
   * @returns {string}
   */
  _inferPackageBinaryName(packageName) {
    const normalized = String(packageName ?? "").trim();
    if (!normalized) {
      return "";
    }

    const bareName = normalized.startsWith("@")
      ? normalized.replace(/^(@[^/]+\/[^@]+)(?:@.+)?$/, "$1")
      : normalized.replace(/@[^@/]+$/, "");
    const segments = bareName.split("/");
    return segments[segments.length - 1] || bareName;
  }

  /**
   * 解析 Python 实际路径。
   * @param {string|null} configuredPythonPath
   * @param {string} projectVenvPath
   * @param {boolean} allowSystemPythonFallback
   * @returns {string|null}
   */
  _resolvePythonExecutable(configuredPythonPath, projectVenvPath, allowSystemPythonFallback) {
    if (configuredPythonPath && existsSync(configuredPythonPath)) {
      return configuredPythonPath;
    }

    const projectCandidates = process.platform === "win32"
      ? [
          path.join(projectVenvPath, "Scripts", "python.exe"),
          path.join(projectVenvPath, "python.exe")
        ]
      : [
          path.join(projectVenvPath, "bin", "python3"),
          path.join(projectVenvPath, "bin", "python")
        ];

    for (const candidate of projectCandidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    if (allowSystemPythonFallback) {
      return process.platform === "win32" ? "python" : "python3";
    }
    return null;
  }

  /**
   * 归一化文件路径。
   * @param {string|null|undefined} value
   * @returns {string|null}
   */
  _normalizeFilePath(value) {
    if (typeof value !== "string" || !value.trim()) {
      return null;
    }
    const trimmed = value.trim();
    return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
  }
}
