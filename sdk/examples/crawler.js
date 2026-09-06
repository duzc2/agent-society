/**
 * 服务器进程接入示例 — 模拟爬虫（胶水接入版）
 *
 * 展示三方异步通知机制的完整用法（与 docs/proc-messaging-protocol.md 对应）：
 * - 一行接入：import SOCIETY_PROC_GLUE_URL 即得到已连接的 proc（进程名经 localcmd_spawn 的 procName 参数注入）
 * - 订阅智能体消息（proc_send 下发）并回执
 * - 定时向网页推送进度事件（localcmd 面板 → 进程控制台消息流）
 * - 主动向归属智能体上报结果（智能体会话出现【服务器进程消息·爬虫】）
 *
 * 经 localcmd_spawn 启动（procName: "爬虫"）：
 *   localcmd_spawn { command: "node", args: ["sdk/examples/crawler.js"], intent: "演示进程", procName: "爬虫" }
 *
 * 直接 node 运行（无平台环境变量）会在 import 阶段报错——SDK 的约定行为。
 */

// 接入：一行，proc 已连接就绪（进程名/地址/token 均由平台注入的环境变量提供）
const { proc } = await import(process.env.SOCIETY_PROC_GLUE_URL);

console.log(`[crawler] 已接入消息中枢 addr=${proc.addr}`);

// ---- 智能体 → 进程：订阅消息并回执（回调参数即消息 payload） ----
proc.onMessage(async (payload) => {
  console.log(`[crawler] 收到消息: ${JSON.stringify(payload)}`);

  const text = typeof payload?.text === "string" ? payload.text : "";
  if (/^抓取[:：]/.test(text)) {
    // 简单回执演示：把收到的指令回显给智能体
    proc.send({ text: `已收到指令「${text}」，开始处理` });
  } else if (text === "停止") {
    proc.send({ text: "爬虫已停止，进程即将退出" });
    await proc.close(); // 等待上行请求落地后再退出（HTTP 上行是异步的）
    process.exit(0);
  } else {
    proc.send({ text: `未知指令「${text}」，可用：抓取:<url> / 停止` });
  }
});

// ---- 进程 → 网页：定时推送进度事件（面板消息流可见） ----
let progress = 0;
const timer = setInterval(() => {
  progress += 10;
  proc.notifyWeb("progress", { percent: progress, note: `已处理 ${progress}%` });
  if (progress >= 100) {
    clearInterval(timer);
    proc.notifyWeb("progress", { percent: 100, note: "完成" });
    // ---- 进程 → 智能体：主动上报结果（进会话） ----
    proc.send({ text: "抓取完成：共 42 条数据（演示数据）" });
  }
}, 5_000);
proc.notifyWeb("progress", { percent: 0, note: "启动" });

// ---- 进程 → 网页：错误事件示例（注释保留，需要时取消） ----
// proc.reportError("示例错误", { code: 42 });

process.on("SIGINT", () => {
  clearInterval(timer);
  proc.close();
  process.exit(0);
});
