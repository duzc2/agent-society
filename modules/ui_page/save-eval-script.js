import { registry } from "../../src/platform/core/module_registry.js";
import { getMimeTypeFromExtension } from "../../src/platform/utils/content/content_type_utils.js";
import { getWorkspaceManager } from "../../src/platform/services/workspace/workspace_manager.js";
import { getAutoLoadRegistry, withPurposeHeader } from "./auto_load.js";

/**
 * 注册 save-eval-script 相关的 Hono 路由。
 * 由 registry 在依赖就绪时自动调用，与模块加载顺序无关。
 * @param {{ app: import('hono').Hono, log: any }} deps
 */
function registerSaveEvalScriptRoutes({ app, log }) {
  const workspaceManager = getWorkspaceManager();

  app.post('/api/save-eval-script', async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    const { workspaceId, script, filename, autoLoad, purpose } = body;

    if (!workspaceId || typeof workspaceId !== "string") {
      return c.json({ error: "missing_workspace_id" }, 400);
    }
    if (!script || typeof script !== "string") {
      return c.json({ error: "missing_script" }, 400);
    }
    if (!filename || typeof filename !== "string") {
      return c.json({ error: "missing_filename" }, 400);
    }

    try {
      const safeName = filename.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").substring(0, 100);
      if (!safeName) {
        return c.json({ error: "invalid_filename" }, 400);
      }

      const filePath = `ui_page_js/${safeName}.js`;

      const ws = await workspaceManager.getWorkspace(workspaceId);

      // 创建父目录（忽略已存在错误）
      try {
        await workspaceManager.createDirectory(workspaceId, "ui_page_js", {
          operator: "system",
          messageId: `save_eval_${Date.now()}`
        });
      } catch {
        // 目录可能已存在，忽略错误
      }

      // purpose 写入脚本文件头部注释（// purpose: xxx），作为描述的唯一数据源：
      // 管理面板（启动项/候选）从文件解析展示，不落注册表；缺失/非法时原样写（老客户端行为不变）
      const finalScript = withPurposeHeader(script, purpose);
      await ws.writeFile(filePath, finalScript, {
        mimeType: getMimeTypeFromExtension(".js") ?? "text/javascript",
        operator: "system",
        messageId: `save_eval_${Date.now()}`
      });

      // 勾选了「自动加载」：注册到自动加载表（只记录路径，不复制文件）。
      // 文件先写、注册后加：注册失败只 warn，不使整个保存失败（文件仍在，用户不丢数据）。
      let autoLoadRegistered = false;
      if (autoLoad === true) {
        try {
          const registry = getAutoLoadRegistry();
          const res = await registry.add({ workspaceId, path: filePath, name: safeName });
          autoLoadRegistered = res.ok === true;
        } catch (err) {
          void log.warn("自动加载注册失败，文件已保存", { filePath, error: err?.message ?? String(err) });
        }
      }

      return c.json({ ok: true, path: filePath, autoLoadRegistered });
    } catch (err) {
      void log.error("保存 eval 脚本失败", { error: err.message, stack: err.stack });
      return c.json({ error: "save_failed", message: err.message }, 500);
    }
  });
}

// 声明式注册：依赖就绪时自动初始化，与加载顺序无关。
registry.declare({
  name: 'save-eval-routes',
  requires: ['app', 'log'],
  provides: [],
  async init(deps) { registerSaveEvalScriptRoutes(deps); return {}; }
});
