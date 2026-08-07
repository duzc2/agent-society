import { registry } from "../../../core/module_registry.js";

/**
 * 注册知识树相关的 Hono 路由。
 * 由 registry 在依赖就绪时自动调用，与模块加载顺序无关。
 * @param {{ app: import('hono').Hono, log: any, knowledgeTreeSystem: any }} deps
 */
async function registerKnowledgeTreeRoutes({ app, log, knowledgeTreeSystem }) {
  const { mkdir, access } = await import("node:fs/promises");

  // GET /api/agents/:agentId/knowledge-tree
  app.get('/api/agents/:agentId/knowledge-tree', async (c) => {
    const agentId = decodeURIComponent(c.req.param('agentId'));
    try {
      const kt = knowledgeTreeSystem;
      if (!kt) {
        return c.json({ error: "knowledge_tree_not_initialized" }, 500);
      }
      const result = await kt.manager.listTree(agentId);
      return c.json(result);
    } catch (err) {
      void log.error("获取知识树结构失败", {
        agentId: c.req.param('agentId'),
        error: err?.message,
        stack: err?.stack,
        name: err?.name,
        code: err?.code,
      });
      return c.json({ error: "internal_error", message: "获取知识树结构失败" }, 500);
    }
  });

  // GET /api/agents/:agentId/knowledge-tree/search
  app.get('/api/agents/:agentId/knowledge-tree/search', async (c) => {
    const agentId = decodeURIComponent(c.req.param('agentId'));
    try {
      const kt = knowledgeTreeSystem;
      if (!kt) {
        return c.json({ error: "knowledge_tree_not_initialized" }, 500);
      }
      const query = c.req.query("q") || "";
      const type = c.req.query("type") || null;
      const importance = c.req.query("importance") || null;

      if (!query.trim()) {
        return c.json({ error: "invalid_params", message: "q 参数不能为空" }, 400);
      }

      const result = await kt.manager.search(agentId, {
        query: query.trim(),
        type,
        importance,
      });
      return c.json(result);
    } catch (err) {
      void log.error("搜索知识树条目失败", {
        agentId: c.req.param('agentId'),
        query: c.req.query('q'),
        error: err?.message,
        stack: err?.stack,
        name: err?.name,
        code: err?.code,
      });
      return c.json({ error: "internal_error", message: "搜索知识树条目失败" }, 500);
    }
  });

  // GET /api/agents/:agentId/knowledge-tree/entry
  app.get('/api/agents/:agentId/knowledge-tree/entry', async (c) => {
    const agentId = decodeURIComponent(c.req.param('agentId'));
    try {
      const kt = knowledgeTreeSystem;
      if (!kt) {
        return c.json({ error: "knowledge_tree_not_initialized" }, 500);
      }
      const entryPath = c.req.query("path") || "";

      if (!entryPath.trim()) {
        return c.json({ error: "invalid_params", message: "path 参数不能为空" }, 400);
      }

      const result = await kt.manager.getEntry(agentId, entryPath);
      if (!result.ok) {
        return c.json(result, 404);
      }
      return c.json(result);
    } catch (err) {
      void log.error("获取知识树条目失败", {
        agentId: c.req.param('agentId'),
        entryPath: c.req.query('path'),
        error: err?.message,
        stack: err?.stack,
        name: err?.name,
        code: err?.code,
      });
      return c.json({ error: "internal_error", message: "获取知识树条目失败" }, 500);
    }
  });

  // POST /api/agents/:agentId/knowledge-tree
  app.post('/api/agents/:agentId/knowledge-tree', async (c) => {
    const agentId = decodeURIComponent(c.req.param('agentId'));
    let body;
    try {
      body = await c.req.json();
    } catch (parseErr) {
      return c.json({ error: "invalid_json", message: parseErr.message }, 400);
    }

    try {
      const kt = knowledgeTreeSystem;
      if (!kt) {
        return c.json({ error: "knowledge_tree_not_initialized" }, 500);
      }

      const { path: p, title, content, type, importance, sourceMessageIds } = body ?? {};

      // 未提供 title → 仅创建文件夹
      if (!title) {
        const folderPath = p ?? "/";
        try {
          await kt.manager._ensureAgentDir(agentId);
          const diskPath = kt.manager._entryPathToDiskPath(agentId, folderPath);
          try { await access(diskPath); } catch {
            await mkdir(diskPath, { recursive: true });
          }
          return c.json({ ok: true, path: folderPath }, 201);
        } catch (e) {
          return c.json({ error: "internal_error", message: e.message }, 500);
        }
      }

      const result = await kt.manager.createEntry(agentId, {
        path: p ?? "/",
        title,
        content: content ?? "",
        type: type ?? null,
        importance: importance ?? null,
        sourceMessageIds: sourceMessageIds ?? [],
      });

      if (!result.ok) {
        return c.json(result, 409);
      }
      return c.json(result, 201);
    } catch (err2) {
      return c.json({ error: "internal_error", message: err2.message }, 500);
    }
  });

  // PUT /api/agents/:agentId/knowledge-tree/entry
  app.put('/api/agents/:agentId/knowledge-tree/entry', async (c) => {
    const agentId = decodeURIComponent(c.req.param('agentId'));
    let body;
    try {
      body = await c.req.json();
    } catch (parseErr) {
      return c.json({ error: "invalid_json", message: parseErr.message }, 400);
    }

    try {
      const kt = knowledgeTreeSystem;
      if (!kt) {
        return c.json({ error: "knowledge_tree_not_initialized" }, 500);
      }

      const entryPath = c.req.query("path") || "";

      if (!entryPath.trim()) {
        return c.json({ error: "invalid_params", message: "path 参数不能为空" }, 400);
      }

      const { title, content, type, importance } = body ?? {};
      const result = await kt.manager.updateEntry(agentId, entryPath, {
        title,
        content,
        type,
        importance,
      });

      if (!result.ok) {
        return c.json(result, 404);
      }
      return c.json(result);
    } catch (err2) {
      return c.json({ error: "internal_error", message: err2.message }, 500);
    }
  });

  // DELETE /api/agents/:agentId/knowledge-tree/entry
  app.delete('/api/agents/:agentId/knowledge-tree/entry', async (c) => {
    const agentId = decodeURIComponent(c.req.param('agentId'));
    try {
      const kt = knowledgeTreeSystem;
      if (!kt) {
        return c.json({ error: "knowledge_tree_not_initialized" }, 500);
      }

      const entryPath = c.req.query("path") || "";
      const recursive = c.req.query("recursive") === "true";

      if (!entryPath.trim()) {
        return c.json({ error: "invalid_params", message: "path 参数不能为空" }, 400);
      }

      const result = await kt.manager.deleteNode(agentId, entryPath, recursive);
      if (!result.ok) {
        return c.json(result, 404);
      }
      return c.json(result);
    } catch (err) {
      void log.error("删除知识树条目失败", {
        agentId: c.req.param('agentId'),
        entryPath: c.req.query('path'),
        error: err?.message,
        stack: err?.stack,
        name: err?.name,
        code: err?.code,
      });
      return c.json({ error: "internal_error", message: "删除知识树条目失败" }, 500);
    }
  });
}

// 声明式注册：依赖就绪时自动初始化，与加载顺序无关。
registry.declare({
  name: 'knowledge-tree-routes',
  requires: ['app', 'log', 'knowledgeTreeSystem'],
  provides: [],
  async init(deps) { await registerKnowledgeTreeRoutes(deps); return {}; }
});
