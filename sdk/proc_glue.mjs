/**
 * 进程消息协议接入胶水（零配置接入入口）。
 *
 * 进程代码只需一行：
 *   const { proc } = await import(process.env.SOCIETY_PROC_GLUE_URL);
 *
 * 平台在 localcmd_spawn（带 procName 参数）时自动注入：
 *   - SOCIETY_PROC_GLUE_URL：本文件的 file:// URL
 *   - SOCIETY_PROC_NAME：procName 参数值（进程名，须唯一）
 *   - 其余连接参数（HTTP 地址 / token / processId）同样由平台注入
 *
 * import 本模块即完成连接（顶层 await），导出的 proc 已就绪：
 *   proc.onMessage((payload) => {...})   // 收智能体指令
 *   proc.send({ text })                  // 发给智能体
 *   proc.notifyWeb(event, data)          // 推给网页进程控制台
 */

const { createProcClient } = await import(process.env.SOCIETY_PROC_SDK_URL);

export const proc = await createProcClient({ name: process.env.SOCIETY_PROC_NAME });
