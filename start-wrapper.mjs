#!/usr/bin/env node
/**
 * Agent Society 启动包装器
 * 
 * 【职责】只在模块加载阶段提供最早的错误捕获和日志记录
 * 【注意】内存限制通过环境变量在启动脚本中设置，不在此设置
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 启动日志文件路径
const LOG_DIR = path.join(__dirname, 'agent-society-data', 'logs');
const BOOT_LOG_PATH = path.join(LOG_DIR, 'boot.log');

function bootLog(level, message, details) {
  const timestamp = new Date().toISOString();
  const line = JSON.stringify({ time: timestamp, level, message, details, pid: process.pid }) + '\n';
  process.stderr.write(`[BOOT ${level}] ${message}\n`);
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(BOOT_LOG_PATH, line);
  } catch {}
}

// 最早期的错误捕获
process.on('uncaughtException', (error) => {
  bootLog('FATAL', '未捕获异常', { message: error?.message, stack: error?.stack?.substring(0, 2000) });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : null;
  bootLog('ERROR', '未处理Promise拒绝', { reason: err?.message ?? String(reason) });
});

// 启动
bootLog('INFO', '========================================');
bootLog('INFO', 'Agent Society 启动包装器');
bootLog('INFO', `版本: ${process.version}, 平台: ${process.platform}, PID: ${process.pid}`);

// 记录内存设置
bootLog('INFO', `NODE_OPTIONS: ${process.env.NODE_OPTIONS || '未设置'}`);
bootLog('INFO', `BUN_JSC_forceRAMSize: ${process.env.BUN_JSC_forceRAMSize || '未设置'}`);
bootLog('INFO', `AGENT_SOCIETY_GC_INTERVAL_MS: ${process.env.AGENT_SOCIETY_GC_INTERVAL_MS || '未设置'}`);
bootLog('INFO', `global.gc 可用: ${!!global.gc}`);
bootLog('INFO', `初始内存使用: ${JSON.stringify(process.memoryUsage())}`);

bootLog('INFO', '========================================');
bootLog('INFO', '========================================');

try {
  bootLog('INFO', '加载 start.js...');
  
  const startModule = await import('./start.js');
  
  bootLog('INFO', 'start.js 加载完成，执行 main()...');
  
  if (startModule.main) {
    await startModule.main();
  } else {
    await startModule.default?.();
  }
  
} catch (error) {
  bootLog('FATAL', '启动失败', {
    message: error?.message,
    stack: error?.stack?.substring(0, 3000)
  });
  process.exit(1);
}
