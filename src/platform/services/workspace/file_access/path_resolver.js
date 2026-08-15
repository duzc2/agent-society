/**
 * 工作区文件访问 — 统一路径解析器
 *
 * 职责：
 * - 判定路径属于当前智能体工作区还是外部授权路径
 * - 对工作区路径复用 Workspace.resolveAbsolutePath 的安全约束
 * - 对外部路径拒绝 .io / .versions 路径段
 * - 返回统一路径对象供文件工具和 document 模块使用
 */

import path from "node:path";
import { getWorkspaceManager } from "../workspace_manager.js";

const FORBIDDEN_SEGMENTS = new Set([".io", ".versions"]);

/**
 * 统一路径解析器类
 */
export class PathResolver {
  /**
   * @param {{runtime: any, log: any}} options
   */
  constructor(options) {
    this.runtime = options.runtime;
    this.log = options.log;
  }

  /**
   * 解析路径，返回统一路径对象。
   *
   * @param {object} ctx - 智能体上下文
   * @param {string} rawPath - 原始路径
   * @param {{operation?: string}} [options] - 操作类型（供后续服务层使用）
   * @returns {Promise<{
   *   scope: "workspace" | "external",
   *   workspaceId: string,
   *   workspace: object,
   *   absolutePath: string,
   *   relativePath: string|null,
   *   orgId: string|null,
   *   operation?: string
   * }>}
   */
  async resolvePath(ctx, rawPath, options = {}) {
    const agentId = ctx?.agent?.id;
    if (!agentId) {
      throw new Error("agent_id_required");
    }

    const workspaceId = this.runtime.findWorkspaceIdForAgent(agentId);
    const workspace = await getWorkspaceManager().getWorkspace(workspaceId);
    const rootPath = workspace.rootPath;
    const rawTarget = this._resolveRawTarget(rootPath, rawPath);
    const scope = this._classifyScope(rootPath, rawTarget);
    const orgId = this.runtime.findWorkspaceIdForAgent(agentId);

    if (scope === "workspace") {
      const relativePath = path.relative(rootPath, rawTarget).replace(/\\/g, "/");
      const absolutePath = workspace.resolveAbsolutePath(relativePath);

      return {
        scope,
        workspaceId,
        workspace,
        absolutePath,
        relativePath,
        orgId,
        operation: options.operation
      };
    }

    this._assertNoForbiddenSegments(rawTarget);

    return {
      scope: "external",
      workspaceId,
      workspace,
      absolutePath: rawTarget,
      relativePath: null,
      orgId,
      operation: options.operation
    };
  }

  /**
   * 计算原始目标绝对路径。
   * 相对路径以工作区根目录为基准；绝对路径/UNC 路径直接解析。
   * @private
   * @param {string} rootPath
   * @param {string} rawPath
   * @returns {string}
   */
  _resolveRawTarget(rootPath, rawPath) {
    const value = typeof rawPath === "string" ? rawPath : "";

    if (!value || value === "." || value === "./" || value === ".\\") {
      return rootPath;
    }

    if (path.isAbsolute(value)) {
      return path.resolve(value);
    }

    return path.resolve(rootPath, value);
  }

  /**
   * 判定规范化后的目标路径属于工作区还是外部。
   * 使用 path.relative 避免简单前缀匹配在 Windows 盘符和路径分隔符上的歧义。
   * @private
   * @param {string} rootPath
   * @param {string} rawTarget
   * @returns {"workspace" | "external"}
   */
  _classifyScope(rootPath, rawTarget) {
    const relative = path.relative(rootPath, rawTarget);

    if (
      relative === "" ||
      (
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      )
    ) {
      return "workspace";
    }

    return "external";
  }

  /**
   * 外部路径统一拒绝 .io / .versions 路径段。
   * @private
   * @param {string} absolutePath
   */
  _assertNoForbiddenSegments(absolutePath) {
    const segments = absolutePath.split(/[\\/]+/).filter(Boolean);
    for (const segment of segments) {
      if (FORBIDDEN_SEGMENTS.has(segment)) {
        throw new Error("forbidden_path_segment");
      }
    }
  }
}

export default PathResolver;
