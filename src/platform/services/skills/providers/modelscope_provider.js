import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

/**
 * ModelScope 技能来源适配器。
 *
 * 设计约束：
 * 1. 当前只支持公开技能的浏览与安装，不支持登录和发布。
 * 2. 安装命令统一通过系统启动时记录的 JavaScript 运行时执行。
 * 3. ModelScope 页面若未直接暴露技能详情，则从技能 git 地址直接加载 SKILL.md。
 */
export class ModelScopeSkillsProvider {
  /**
   * @param {{config?:any, runtimeResolver:any, logger?:any}} options
   */
  constructor(options) {
    this.providerId = "modelscope";
    this.config = options.config ?? {};
    this.runtimeResolver = options.runtimeResolver;
    this.log = options.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    this.baseUrl = this.config.baseUrl || "https://modelscope.cn";
  }

  /**
   * 列出来源目录。
   * 设计约束：
   * 1. 技能列表必须来自 Provider 真实数据。
   * 2. 不允许为了界面展示写死虚假技能。
   * 3. 无搜索词时也走 Provider 默认列表接口。
   * @param {{query?:string}} [options]
   * @returns {Promise<any[]>}
   */
  async listCatalog(options = {}) {
    const query = typeof options.query === "string" ? options.query.trim() : "";
    return this._searchCatalog(query);
  }

  /**
   * 规范化安装请求。
   * @param {{externalId?:string, installUrl?:string, sourceUrl?:string}} input
   * @returns {any}
   */
  normalizeInstallRequest(input) {
    const installUrl = typeof input?.installUrl === "string" && input.installUrl.trim()
      ? input.installUrl.trim()
      : null;
    let externalId = typeof input?.externalId === "string" && input.externalId.trim()
      ? input.externalId.trim()
      : null;

    if (installUrl && !externalId) {
      const parsed = this._parseExternalIdFromUrl(installUrl);
      externalId = parsed?.externalId ?? null;
    }

    if (!externalId && !installUrl) {
      throw new Error("missing_skill_reference");
    }

    const normalizedExternalId = externalId && externalId.startsWith("@") ? externalId : (externalId ? `@${externalId}` : null);
    const finalInstallUrl = installUrl || `${this.baseUrl}/skills/${normalizedExternalId}`;
    const sourceUrl = typeof input?.sourceUrl === "string" && input.sourceUrl.trim()
      ? input.sourceUrl.trim()
      : null;

    return {
      providerId: this.providerId,
      kind: "skill",
      externalId: normalizedExternalId,
      installUrl: finalInstallUrl,
      homepageUrl: finalInstallUrl,
      installSourcePackage: this._buildInstallSourcePackageFromSourceUrl(sourceUrl),
      selectedSkillName: null,
      sourceUrl
    };
  }

  /**
   * 安装技能到临时目录。
   * 对于已知公共样例，优先走 git 仓库 + --skill 的标准安装方式，避免依赖无效的 ModelScope 页面 URL。
   * @param {{request:any, tempDir:string}} options
   * @returns {Promise<{catalogItem:any, packageDir:string}>}
   */
  async installToDirectory(options) {
    const request = this.normalizeInstallRequest(options.request);
    const packageCommand = await this.runtimeResolver.resolvePackageCommand({
      packageName: "skills@latest",
      binaryName: "skills"
    });
    if (!packageCommand.command) {
      throw new Error(packageCommand.message || "javascript_package_runtime_not_found");
    }

    const installArgs = [...(packageCommand.argsPrefix ?? []), "add"];
    if (request.installSourcePackage) {
      installArgs.push(request.installSourcePackage);
      if (request.selectedSkillName) {
        installArgs.push("--skill", request.selectedSkillName);
      }
    } else {
      installArgs.push(request.installUrl);
    }
    installArgs.push("-y");

    let packageDir = null;
    try {
      await this._runProcess(packageCommand.command, installArgs, options.tempDir);
    } catch (err) {
      /**
       * 兼容保护：
       * 1. 某些 JS 包执行组合在 Windows 上可能已经把技能包落到目录里，但进程最终返回非 0。
       * 2. 对当前系统来说，真正的安装完成标志是技能目录里已经存在可读取的 SKILL.md。
       * 3. 如果包已经存在，则记录警告并继续，避免把已成功安装误报成失败。
       */
      packageDir = await this._findInstalledSkillDirectory(options.tempDir, request.externalId);
      if (!packageDir) {
        throw err;
      }
      void this.log.warn("技能安装进程返回非零，但已检测到技能包目录，按安装成功继续处理", {
        externalId: request.externalId,
        installUrl: request.installUrl,
        packageDir,
        error: err?.message,
        stack: err?.stack
      });
    }

    packageDir = packageDir || await this._findInstalledSkillDirectory(options.tempDir, request.externalId);
    if (!packageDir) {
      throw new Error("installed_skill_package_not_found");
    }

    const skillDoc = await readFile(path.join(packageDir, "SKILL.md"), "utf8");
    const description = this._extractDescription(skillDoc) || "ModelScope Skill";

    return {
      catalogItem: {
        providerId: this.providerId,
        kind: "skill",
        externalId: request.externalId,
        installUrl: request.installUrl,
        homepageUrl: request.homepageUrl,
        displayName: request.externalId,
        description,
        sourceLabel: "ModelScope",
        tags: ["modelscope", "public"],
        sourceUrl: request.sourceUrl || null
      },
      packageDir
    };
  }

  /**
   * 获取远端技能详情。
   * 优先读取 ModelScope 页面内嵌的详情数据；若该页面没有公开详情，则从 git 地址直接加载 SKILL.md。
   * @param {{externalId?:string, installUrl?:string, homepageUrl?:string, sourceUrl?:string}} input
   * @returns {Promise<{
   *   providerId:string,
   *   kind:string,
   *   externalId:string|null,
   *   displayName:string,
   *   description:string,
   *   homepageUrl:string|null,
   *   installUrl:string|null,
   *   skillMd:string,
   *   sourceUrl:string|null
   * }>}
   */
  async getRemoteSkillContent(input) {
    const request = this.normalizeInstallRequest(input);
    const detailUrl = request.homepageUrl || request.installUrl;
    const html = await this._fetchPage(detailUrl);
    const detailData = this._extractDetailDataFromHtml(html);
    const pageContent = this._buildRemoteContentFromDetailData(request, detailUrl, detailData);
    if (pageContent) {
      return pageContent;
    }

    if (request.sourceUrl) {
      return await this._loadPreviewFromGitSource(request, detailUrl, request.sourceUrl);
    }

    return {
      providerId: request.providerId,
      kind: request.kind,
      externalId: request.externalId,
      displayName: request.externalId || "ModelScope Skill",
      description: "",
      homepageUrl: detailUrl,
      installUrl: request.installUrl || detailUrl,
      skillMd: "",
      sourceUrl: null
    };
  }

  /**
   * 调用 ModelScope 技能搜索接口。
   * 这里直接复用技能中心前端正在使用的公开接口，保证搜索结果与官网一致。
   * @param {string} query
   * @returns {Promise<any[]>}
   */
  async _searchCatalog(query) {
    const payload = {
      PageSize: 24,
      PageNumber: 1,
      Query: query,
      Sort: "Default",
      Criterion: [],
      WithTopCollection: false
    };

    const data = await this._fetchJson(`${this.baseUrl}/api/v1/dolphin/skills`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "agent-society/skills"
      },
      body: JSON.stringify(payload)
    });

    const remoteList = Array.isArray(data?.Data?.SkillList) ? data.Data.SkillList : [];
    return remoteList
      .map((remoteItem) => this._normalizeSearchResultItem(remoteItem))
      .filter(Boolean);
  }

  /**
   * 规范化搜索结果项。
   * @param {any} remoteItem
   * @returns {any|null}
   */
  _normalizeSearchResultItem(remoteItem) {
    const scopePath = typeof remoteItem?.Path === "string" ? remoteItem.Path.trim() : "";
    const skillName = typeof remoteItem?.Name === "string" ? remoteItem.Name.trim() : "";
    if (!scopePath || !skillName) {
      return null;
    }

    const externalId = `${scopePath}/${skillName}`;
    const description = remoteItem?.Description || remoteItem?.DescriptionEn || "";
    return {
      providerId: this.providerId,
      kind: "skill",
      externalId,
      installUrl: `${this.baseUrl}/skills/${externalId}`,
      homepageUrl: `${this.baseUrl}/skills/${externalId}`,
      displayName: remoteItem?.DisplayName || remoteItem?.Name || externalId,
      description,
      sourceLabel: "ModelScope",
      tags: this._buildSearchResultTags(remoteItem),
      installSourcePackage: this._buildInstallSourcePackageFromSourceUrl(remoteItem?.SourceURL || null),
      selectedSkillName: null,
      sourceUrl: remoteItem?.SourceURL || null
    };
  }

  /**
   * 构造搜索结果标签。
   * 标签同时服务于界面展示与二次过滤，因此保留分类、来源与协议信息。
   * @param {any} remoteItem
   * @returns {string[]}
   */
  _buildSearchResultTags(remoteItem) {
    const tags = new Set(["modelscope"]);
    const l1 = remoteItem?.L1;
    const l2List = Array.isArray(remoteItem?.L2) ? remoteItem.L2 : [];
    if (typeof remoteItem?.Source === "string" && remoteItem.Source.trim()) {
      tags.add(remoteItem.Source.trim());
    }
    if (typeof remoteItem?.License === "string" && remoteItem.License.trim()) {
      tags.add(remoteItem.License.trim());
    }
    if (typeof l1?.ChineseName === "string" && l1.ChineseName.trim()) {
      tags.add(l1.ChineseName.trim());
    }
    if (typeof l1?.CatalogID === "string" && l1.CatalogID.trim()) {
      tags.add(l1.CatalogID.trim());
    }
    for (const item of l2List) {
      if (typeof item?.ChineseName === "string" && item.ChineseName.trim()) {
        tags.add(item.ChineseName.trim());
      }
      if (typeof item?.CatalogID === "string" && item.CatalogID.trim()) {
        tags.add(item.CatalogID.trim());
      }
    }
    return Array.from(tags);
  }

  /**
   * 拉取页面 HTML。
   * @param {string} pageUrl
   * @returns {Promise<string>}
   */
  async _fetchPage(pageUrl) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 15000);

    try {
      const response = await fetch(pageUrl, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": "agent-society/skills",
          Accept: "text/html,application/xhtml+xml"
        }
      });
      if (!response.ok) {
        throw new Error(`modelscope_detail_http_${response.status}`);
      }
      return await response.text();
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 拉取纯文本资源。
   * @param {string} url
   * @returns {Promise<string>}
   */
  async _fetchText(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 15000);

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": "agent-society/skills",
          Accept: "text/plain,text/markdown,*/*"
        }
      });
      if (!response.ok) {
        throw new Error(`skill_source_http_${response.status}`);
      }
      return await response.text();
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 拉取 JSON 资源。
   * @param {string} url
   * @param {RequestInit} options
   * @returns {Promise<any>}
   */
  async _fetchJson(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 15000);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`modelscope_search_http_${response.status}`);
      }

      const data = await response.json();
      if (data?.Success === false) {
        throw new Error(data?.Message || "modelscope_search_failed");
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 从详情页 HTML 中提取内嵌的详情数据。
   * @param {string} html
   * @returns {any}
   */
  _extractDetailDataFromHtml(html) {
    const source = String(html ?? "");
    const match = source.match(/window\.__detail_data__\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*;/s);
    if (!match?.[1]) {
      throw new Error("modelscope_detail_data_not_found");
    }
    return this._normalizeDetailDataPayload(match[1]);
  }

  /**
   * 规范化页面内嵌的详情数据。
   * @param {string} rawPayload
   * @returns {any}
   */
  _normalizeDetailDataPayload(rawPayload) {
    let current = this._normalizeJsonLiteral(String(rawPayload ?? ""));

    for (let index = 0; index < 5; index += 1) {
      if (current === null) {
        return null;
      }
      if (current && typeof current === "object" && !Array.isArray(current)) {
        return current;
      }
      if (typeof current !== "string") {
        break;
      }

      const text = current.trim();
      if (!text) {
        break;
      }

      try {
        current = JSON.parse(this._normalizeJsonLiteral(text));
      } catch {
        break;
      }
    }

    throw new Error("modelscope_detail_data_invalid");
  }

  /**
   * 把可能是单引号包裹的字符串字面量转成 JSON 可解析格式。
   * @param {string} literal
   * @returns {string}
   */
  _normalizeJsonLiteral(literal) {
    const text = String(literal ?? "").trim();
    if (text.startsWith("'") && text.endsWith("'")) {
      const inner = text.slice(1, -1)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, "\\\"")
        .replace(/\\\\'/g, "'")
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n");
      return `"${inner}"`;
    }
    return text;
  }

  /**
   * 把 ModelScope 详情对象转成统一内容结构。
   * @param {any} request
   * @param {string} detailUrl
   * @param {any} detailData
   * @returns {any|null}
   */
  _buildRemoteContentFromDetailData(request, detailUrl, detailData) {
    if (!detailData || typeof detailData !== "object") {
      return null;
    }

    return {
      providerId: request.providerId,
      kind: request.kind,
      externalId: request.externalId,
      displayName: detailData.DisplayName || detailData.Name || request.externalId || "ModelScope Skill",
      description: detailData.Description || detailData.DescriptionEn || "",
      homepageUrl: detailUrl,
      installUrl: request.installUrl || detailUrl,
      skillMd: detailData.ReadMeContent || "",
      sourceUrl: detailData.SourceURL || request.sourceUrl || null
    };
  }

  /**
   * 从 git 地址直接加载 SKILL.md。
   * @param {any} request
   * @param {string} detailUrl
   * @param {string} sourceUrl
   * @returns {Promise<any>}
   */
  async _loadPreviewFromGitSource(request, detailUrl, sourceUrl) {
    const rawSkillMdUrl = this._buildRawSkillMdUrlFromSourceUrl(sourceUrl);
    const skillMd = await this._fetchText(rawSkillMdUrl);
    return {
      providerId: request.providerId,
      kind: request.kind,
      externalId: request.externalId,
      displayName: request.externalId || "ModelScope Skill",
      description: this._extractDescription(skillMd) || "ModelScope Skill",
      homepageUrl: detailUrl,
      installUrl: request.installUrl || detailUrl,
      skillMd,
      sourceUrl
    };
  }

  /**
   * 根据 git 地址构造 raw SKILL.md 地址。
   * 当前先支持 GitHub 仓库树路径。
   * @param {string} sourceUrl
   * @returns {string}
   */
  _buildRawSkillMdUrlFromSourceUrl(sourceUrl) {
    const url = new URL(sourceUrl);
    if (!["github.com", "www.github.com"].includes(url.hostname)) {
      throw new Error("unsupported_skill_git_host");
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 4 || parts[2] !== "tree") {
      throw new Error("unsupported_skill_git_path");
    }

    const owner = parts[0];
    const repo = parts[1];
    const branch = parts[3];
    const directory = parts.slice(4).join("/");
    const suffix = directory ? `/${directory}/SKILL.md` : "/SKILL.md";
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}${suffix}`;
  }

  /**
   * 根据 sourceUrl 推导 skills CLI 的仓库安装路径。
   * 设计约束：
   * 1. 只能根据 Provider 返回的真实 sourceUrl 推导。
   * 2. 不允许写死某个 skill 的安装映射。
   * 3. 当前仅支持 GitHub tree 路径。
   * @param {string|null} sourceUrl
   * @returns {string|null}
   */
  _buildInstallSourcePackageFromSourceUrl(sourceUrl) {
    if (typeof sourceUrl !== "string" || !sourceUrl.trim()) {
      return null;
    }

    try {
      const url = new URL(sourceUrl);
      if (!["github.com", "www.github.com"].includes(url.hostname)) {
        return null;
      }

      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length < 4 || parts[2] !== "tree") {
        return null;
      }

      const owner = parts[0];
      const repo = parts[1];
      const directory = parts.slice(4).join("/");
      return directory ? `${owner}/${repo}/${directory}` : `${owner}/${repo}`;
    } catch {
      return null;
    }
  }

  /**
   * 从安装目录中查找 Skill 包目录。
   * @param {string} rootDir
   * @param {string|null} externalId
   * @returns {Promise<string|null>}
   */
  async _findInstalledSkillDirectory(rootDir, externalId) {
    const candidates = [];
    await this._collectSkillDirs(rootDir, candidates);
    if (candidates.length === 0) {
      return null;
    }
    if (candidates.length === 1) {
      return candidates[0];
    }

    const expectedName = externalId ? externalId.split("/").pop()?.replace(/^@/, "") : null;
    if (expectedName) {
      const matched = candidates.find((candidate) => path.basename(candidate).toLowerCase() === expectedName.toLowerCase());
      if (matched) {
        return matched;
      }
    }
    return candidates[0];
  }

  /**
   * 递归收集包含 SKILL.md 的目录。
   * @param {string} currentDir
   * @param {string[]} output
   * @returns {Promise<void>}
   */
  async _collectSkillDirs(currentDir, output) {
    if (!existsSync(currentDir)) {
      return;
    }
    const entries = await readdir(currentDir, { withFileTypes: true });
    const fileNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    if (fileNames.has("SKILL.md")) {
      output.push(currentDir);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (["node_modules", ".git", ".cache"].includes(entry.name)) {
        continue;
      }
      await this._collectSkillDirs(path.join(currentDir, entry.name), output);
    }
  }

  /**
   * 运行技能安装命令。
   * @param {string} command
   * @param {string[]} args
   * @param {string} cwd
   * @returns {Promise<void>}
   */
  async _runProcess(command, args, cwd) {
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          NO_UPDATE_NOTIFIER: "1"
        },
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk ?? "");
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk ?? "");
      });

      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(this._buildProcessError({
          command,
          args,
          cwd,
          code,
          signal,
          stdout,
          stderr
        }));
      });
    });
  }

  /**
   * 构造子进程失败异常。
   * 设计约束：
   * 1. stderr 里可能只有包执行器的进度信息，真正错误可能在 stdout。
   * 2. 日志中必须保留退出码、signal 与命令参数，便于定位安装问题。
   * @param {{command:string, args:string[], cwd:string, code:number|null, signal:NodeJS.Signals|null, stdout:string, stderr:string}} options
   * @returns {Error}
   */
  _buildProcessError(options) {
    const stdout = String(options.stdout ?? "").trim();
    const stderr = String(options.stderr ?? "").trim();
    const combined = [stderr, stdout].filter(Boolean).join("\n");
    const summary = combined || `skills_install_exit_${options.code ?? "unknown"}`;
    const error = new Error(summary);
    error.name = "SkillInstallProcessError";
    error.exitCode = options.code ?? null;
    error.signal = options.signal ?? null;
    error.command = options.command;
    error.args = Array.isArray(options.args) ? [...options.args] : [];
    error.cwd = options.cwd;
    error.stdout = stdout;
    error.stderr = stderr;
    return error;
  }

  /**
   * 从 URL 中解析 externalId。
   * @param {string} inputUrl
   * @returns {{externalId:string}|null}
   */
  _parseExternalIdFromUrl(inputUrl) {
    try {
      const url = new URL(inputUrl);
      const match = url.pathname.match(/\/skills\/(.+)$/);
      if (!match) {
        return null;
      }
      const externalId = decodeURIComponent(match[1]);
      return { externalId: externalId.startsWith("@") ? externalId : `@${externalId}` };
    } catch {
      return null;
    }
  }

  /**
   * 从 SKILL.md 中提取描述。
   * @param {string} content
   * @returns {string}
   */
  _extractDescription(content) {
    const match = String(content ?? "").match(/description\s*:\s*(.+)/i);
    if (match?.[1]) {
      return match[1].trim().replace(/^['"]|['"]$/g, "");
    }
    const lines = String(content ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.find((line) => !line.startsWith("---") && !line.startsWith("#")) || "";
  }
}
