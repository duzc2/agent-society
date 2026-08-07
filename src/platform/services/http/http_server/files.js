import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { readJsonBody, sendJson } from "./utilities.js";

  /**
   * 处理静态文件请求。
   * @param {string} pathname - 请求路径
   * @param {import("node:http").ServerResponse} res
   */
  export async function _handleStaticFile(req, pathname, res) {
    // 移除 /web/ 前缀，获取相对路径
    let relativePath = pathname.replace(/^\/web\/?/, "");
    if (!relativePath || relativePath === "") {
      relativePath = "index.html";
    }

    // 构建文件路径（相对于项目根目录的 web 文件夹）
    const filePath = path.join(process.cwd(), "web", relativePath);

    // 安全检查：防止路径遍历攻击
    const webDir = path.join(process.cwd(), "web");
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(webDir)) {
      void this.log.warn("路径访问被拒绝", { resolvedPath, webDir });
      sendJson(res, 403, { error: "forbidden", message: "路径访问被拒绝" });
      return;
    }

    try {
      // 检查文件是否存在
      if (!existsSync(resolvedPath)) {
        void this.log.warn("静态文件不存在", { path: pathname, resolvedPath });
        sendJson(res, 404, { error: "not_found", path: pathname });
        return;
      }

      // 读取文件内容
      const content = await readFile(resolvedPath);

      // 根据文件扩展名设置 Content-Type
      const ext = path.extname(relativePath).toLowerCase();
      const contentTypes = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".wasm": "application/wasm",
        ".map": "application/json; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon"
      };
      const contentType = contentTypes[ext] ?? "application/octet-stream";

      res.setHeader("Content-Type", contentType);
      res.writeHead(200);
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(content);

      void this.log.debug("HTTP静态文件", { path: relativePath });
    } catch (err) {
      void this.log.error("读取静态文件失败", { 
        path: relativePath, 
        resolvedPath,
        error: err.message,
        stack: err.stack 
      });
      sendJson(res, 500, { error: "read_file_failed", message: err.message });
    }
  }

  /**
   * 处理模块静态文件请求。
   * 为模块的 web 面板提供静态资源服务，支持正确解析相对路径引用。
   * @param {import("node:http").IncomingMessage} req
   * @param {string} pathname - 请求路径，如 /modules/chrome/web/panel.html
   * @param {import("node:http").ServerResponse} res
   */
  export async function _handleModuleStaticFile(req, pathname, res) {
    // 移除 /modules/ 前缀，获取相对路径
    const relativePath = pathname.replace(/^\/modules\/?/, "");
    
    if (!relativePath) {
      sendJson(res, 404, { error: "not_found", path: pathname });
      return;
    }

    // 构建文件路径（相对于项目根目录的 modules 文件夹）
    const filePath = path.join(process.cwd(), "modules", relativePath);

    // 安全检查：防止路径遍历攻击
    const modulesDir = path.join(process.cwd(), "modules");
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(modulesDir)) {
      void this.log.warn("模块静态文件路径访问被拒绝", { resolvedPath, modulesDir });
      sendJson(res, 403, { error: "forbidden", message: "路径访问被拒绝" });
      return;
    }

    try {
      // 检查文件是否存在
      if (!existsSync(resolvedPath)) {
        void this.log.warn("模块静态文件不存在", { path: pathname, resolvedPath });
        sendJson(res, 404, { error: "not_found", path: pathname });
        return;
      }

      // 读取文件内容
      const content = await readFile(resolvedPath);

      // 根据文件扩展名设置 Content-Type
      const ext = path.extname(relativePath).toLowerCase();
      const contentTypes = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon"
      };
      const contentType = contentTypes[ext] ?? "application/octet-stream";

      res.setHeader("Content-Type", contentType);
      res.writeHead(200);
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(content);

      void this.log.debug("HTTP模块静态文件", { path: relativePath });
    } catch (err) {
      void this.log.error("读取模块静态文件失败", { 
        path: relativePath, 
        resolvedPath,
        error: err.message,
        stack: err.stack 
      });
      sendJson(res, 500, { error: "read_file_failed", message: err.message });
    }
  }

