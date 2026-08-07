/**
 * 共享的 JavaScript 危险 token 检测模块（防御性预过滤）
 *
 * 注意：此检测是防御性的补充措施。主要安全由 Worker + vm 沙箱提供。
 *
 * @module runtime/blocked_tokens
 */

export const BLOCKED_PATTERNS = [
  { name: "require", regex: /\brequire\s*\(/ },
  { name: "process", regex: /\bprocess\./ },
  { name: "child_process", regex: /\bchild_process\b/ },
  { name: "fs", regex: /\bfs\./ },
  { name: "os", regex: /\bos\./ },
  { name: "net", regex: /\bnet\./ },
  { name: "http", regex: /\bhttp\./ },
  { name: "https", regex: /\bhttps\./ },
  { name: "dgram", regex: /\bdgram\./ },
  { name: "worker_threads", regex: /\bworker_threads\b/ },
  { name: "vm", regex: /\bvm\./ },
  { name: "import()", regex: /\bimport\s*\(/ },
  { name: "Deno", regex: /\bDeno\./ },
  { name: "Bun", regex: /\bBun\./ },
];

/**
 * 从代码中去除字符串字面量、单行注释和多行注释，
 * 返回可用于 token 检测的"干净"代码。
 */
function stripCommentsAndStrings(code) {
  // 1. 替换字符串字面量（必须在注释之前，字符串内容可能混淆注释检测）
  let result = code.replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, '""');
  result = result.replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""');
  result = result.replace(/`[^`\\]*(?:\\.[^`\\]*)*`/gs, '""');

  // 2. 去除单行注释
  result = result.replace(/\/\/.*$/gm, '');

  // 3. 去除多行注释
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');

  return result;
}

function buildBlockedMessage(blockedTokens) {
  const tokens = blockedTokens.join(", ");
  return (
    `代码包含被禁止的模式: ${tokens}。` +
    `这些模式在沙箱中不可用。` +
    `如需写文件请用 downloadToWorkspace，` +
    `如需网络请求请用 fetch，` +
    `如需执行系统命令请用 localcmd。`
  );
}

/**
 * 检测代码中的被阻止 token。先剥离注释和字符串再检测。
 * @param {string} code
 * @returns {{blocked: string[], message: string}}
 */
export function detectBlockedTokens(code) {
  const stripped = stripCommentsAndStrings(code);

  const found = [];
  for (const p of BLOCKED_PATTERNS) {
    if (p.regex.test(stripped)) found.push(p.name);
  }

  return {
    blocked: found,
    message: found.length > 0 ? buildBlockedMessage(found) : "",
  };
}
