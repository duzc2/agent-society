/**
 * HTTP 网络请求工具 — 从 tool_executor.js 提取
 *
 * 包含：http_request、_generateDownloadFileName
 *
 * @module runtime/tools_network
 */

import path from "path";
import { isTextMimeType, getExtensionFromMimeType } from "../utils/content/content_type_utils.js";
import { getWorkspaceManager } from "../services/workspace/workspace_manager.js";

/** HTTP 响应体大小限制：超过此值的文本内容也会保存到工作区（50KB） */
const HTTP_RESPONSE_SIZE_LIMIT = 50 * 1024;

export class NetworkTools {
  /**
   * @param {object} runtime - Runtime 实例引用
   */
  constructor(runtime) {
    /** @type {object} Runtime 实例引用 */
    this.runtime = runtime;
  }

  async _executeHttpRequest(ctx, args) {
    const runtime = this.runtime;
    const agentId = ctx.agent?.id ?? null;
    if (!agentId) return { error: "missing_agent_id" };

    const { response, error, requestLog } = await runtime.httpClient.request(agentId, {
      url: args.url,
      method: args.method,
      headers: args.headers,
      body: args.body,
      timeoutMs: args.timeoutMs,
      signal: runtime._cancelManager?.getSignal(agentId) ?? null
    });

    if (error) {
      return { error, requestId: requestLog.requestId, latencyMs: requestLog.latencyMs ?? null };
    }

    // 获取 Content-Type 头并判断是否为纯文本
    const contentType = response.headers["content-type"] || "";
    const mimeType = contentType.split(";")[0].trim().toLowerCase();

    // 判断是否为文本内容
    const isTextContent = isTextMimeType(mimeType);

    // 获取响应体长度
    const bodyLength = Buffer.byteLength(response.body, "utf8");

    // 如果是纯文本且大小不超过限制，直接返回 body
    if (isTextContent && bodyLength <= HTTP_RESPONSE_SIZE_LIMIT) {
      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: response.body,
        latencyMs: response.latencyMs,
        requestId: requestLog.requestId
      };
    }

    // 非文本内容，保存到工作区的 download 文件夹
    const workspaceId = runtime.findWorkspaceIdForAgent(agentId);
    if (!workspaceId) {
      return {
        error: "workspace_not_assigned",
        message: "当前智能体未分配工作空间，无法保存下载文件",
        status: response.status,
        headers: response.headers,
        mimeType
      };
    }

    // 生成文件名
    const fileName = this._generateDownloadFileName(args.url, mimeType);
    const filePath = `download/${fileName}`;

    // 获取工作区并保存文件
    try {
      const ws = await getWorkspaceManager().getWorkspace(workspaceId);

      // 将响应体转为 Buffer
      const buffer = Buffer.from(response.body, "utf8");

      const result = await ws.writeFile(filePath, buffer, {
        mimeType,
        operator: agentId,
        messageId: ctx.currentMessage?.id || `http-${requestLog.requestId}`
      });

      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        mimeType,
        savedTo: filePath,
        size: result.size,
        latencyMs: response.latencyMs,
        requestId: requestLog.requestId
      };
    } catch (saveError) {
      return {
        error: "save_file_failed",
        message: saveError?.message || String(saveError),
        status: response.status,
        headers: response.headers,
        mimeType
      };
    }
  }

  /**
   * 生成下载文件名
   * 优先从 URL 中提取，如果没有则根据日期时间生成
   * 后缀根据 MIME 类型推断
   *
   * @param {string} url - 请求 URL
   * @param {string} mimeType - MIME 类型
   * @returns {string} 文件名
   * @private
   */
  _generateDownloadFileName(url, mimeType) {

    // 尝试从 URL 中提取文件名
    let fileName = null;
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      if (pathname && pathname !== "/") {
        const baseName = path.basename(pathname);
        if (baseName && baseName.includes(".")) {
          fileName = baseName;
        }
      }
    } catch {
      // URL 解析失败，忽略
    }

    // 如果 URL 中没有文件名，使用日期时间生成
    if (!fileName) {
      const now = new Date();
      const timestamp = now.toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .slice(0, 19);
      fileName = `download_${timestamp}`;
    }

    // 确保文件名有正确的扩展名
    const hasExtension = /\.[^./\\]+$/.test(fileName);
    if (!hasExtension) {
      const ext = getExtensionFromMimeType(mimeType);
      if (ext) {
        fileName = `${fileName}.${ext}`;
      }
    }

    return fileName;
  }
}
