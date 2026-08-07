/**
 * Mood routes — 组织心情懒加载 API
 *
 * POST /api/org/:agentId/moods — 触发某个组织下所有活跃智能体的心情加载，
 * 心情颜色通过心跳 mood_colors 消息异步推送，API 本身立即返回 200。
 */

import { registry } from "../../../core/module_registry.js";
import path from "node:path";
import { readFile } from "node:fs/promises";

/**
 * 加载组织下所有活跃智能体的心情颜色并通过心跳广播。
 * @param {string} orgAgentId - 组织根智能体 ID
 * @param {any} society
 * @param {string} dataDir
 * @param {any} heartbeatBroker
 * @param {any} log
 */
async function _loadOrgMoods(orgAgentId, society, dataDir, heartbeatBroker, log) {
  try {
    const agents = society.runtime.org.listAgents();

    // 过滤已删除的智能体
    const activeAgents = agents.filter(a => a.status !== "deleted");

    // 构建 parentAgentId → children[] 映射
    const childrenMap = new Map();
    for (const agent of activeAgents) {
      const parent = agent.parentAgentId;
      if (!childrenMap.has(parent)) childrenMap.set(parent, []);
      childrenMap.get(parent).push(agent.id);
    }

    // BFS 从 orgAgentId 出发，递归收集所有后代
    const descendants = [];
    const queue = [orgAgentId];
    while (queue.length > 0) {
      const current = queue.shift();
      const children = childrenMap.get(current) || [];
      for (const childId of children) {
        descendants.push(childId);
        queue.push(childId);
      }
    }

    // 包含组织根智能体本身（如果未删除）
    const isOrgActive = activeAgents.some(a => a.id === orgAgentId);
    const agentIds = isOrgActive ? [orgAgentId, ...descendants] : descendants;

    // 逐个读取 mood.json 并通过心跳广播
    for (const agentId of agentIds) {
      try {
        const moodPath = path.join(dataDir, "agents", agentId, "mood.json");
        const raw = await readFile(moodPath, "utf8");
        const data = JSON.parse(raw);
        let colors;
        if (Array.isArray(data)) {
          // 旧格式：5×N 滑动网格，取每行最后一列
          colors = [];
          for (const row of data) {
            if (Array.isArray(row) && row.length > 0) {
              colors.push(row[row.length - 1]);
            }
          }
        } else {
          // 新格式：{colors, roundCount}
          colors = Array.isArray(data?.colors) ? data.colors : [];
        }
        if (colors.length > 0) {
          heartbeatBroker.broadcast("mood_colors", { agentId, colors });
        }
      } catch {
        // mood.json 不存在或解析失败，跳过
      }
    }

    void log.info("[MoodRoutes] 组织心情加载完成", { orgAgentId, count: agentIds.length });
  } catch (err) {
    void log.error("[MoodRoutes] 加载组织心情失败", {
      orgAgentId,
      message: err?.message ?? String(err),
      stack: err?.stack ?? "(no stack)"
    });
  }
}

function registerMoodRoutes({ app, log, society, heartbeatBroker, dataDir }) {
  app.post("/api/org/:agentId/moods", (c) => {
    const orgAgentId = c.req.param("agentId");
    void _loadOrgMoods(orgAgentId, society, dataDir, heartbeatBroker, log);
    return c.json({ ok: true });
  });
}

registry.declare({
  name: "mood-routes",
  requires: ["app", "log", "society", "heartbeatBroker", "dataDir"],
  provides: [],
  async init(deps) {
    registerMoodRoutes(deps);
    return {};
  }
});
