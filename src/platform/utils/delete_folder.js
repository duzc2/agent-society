/**
 * deleteAgentDataFolder - 删除智能体数据文件夹
 *
 * 从 Runtime 中提取为独立工具函数。
 * 最多尝试5次，间隔2秒，失败打印警告日志不中断程序。
 *
 * @module utils/delete_folder
 */

import path from "node:path";
import { access, rm } from "node:fs/promises";

/**
 * 删除智能体数据文件夹
 *
 * @param {string} dataDir - 数据目录路径
 * @param {string} agentId - 智能体ID
 * @param {import("../logger/logger.js").ModuleLogger} [log] - 日志记录器实例
 * @returns {Promise<void>}
 */
export async function deleteAgentDataFolder(dataDir, agentId, log = console) {
  void log.info(`[deleteAgentDataFolder] 开始执行，agentId=${agentId}`);

  const maxRetries = 5;
  const retryDelayMs = 2000;

  // 构造数据文件夹路径
  const agentDir = path.join(dataDir, "agents", agentId);

  void log.info(`[deleteAgentDataFolder] agentDir=${agentDir}`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 检查文件夹是否存在
      await access(agentDir);

      // 尝试删除文件夹
      await rm(agentDir, { recursive: true, force: true });

      void log.info(`[deleteAgentDataFolder] 删除成功，agentId=${agentId}, attempt=${attempt}`);
      return;
    } catch (err) {
      if (err.code === "ENOENT") {
        // 文件夹不存在，不需要删除
        void log.info(`[deleteAgentDataFolder] 文件夹不存在，无需删除，agentId=${agentId}`);
        return;
      }

      // 其他错误（可能是文件被占用）
      if (attempt < maxRetries) {
        void log.warn(`[deleteAgentDataFolder] 删除失败，准备重试，agentId=${agentId}, attempt=${attempt}, error=${err.message}`, { stack: err.stack, name: err?.name, code: err?.code });

        // 等待后重试
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      } else {
        // 最后一次尝试失败，打印警告但不中断程序
        void log.warn(`[deleteAgentDataFolder] 最终失败，已放弃，agentId=${agentId}, error=${err.message}`, { stack: err.stack, name: err?.name, code: err?.code });
      }
    }
  }
}
