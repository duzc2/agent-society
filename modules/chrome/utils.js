

/**
 * 验证 URL 是否安全，禁止访问本地文件协议等
 * @param {string} url - 要验证的 URL
 * @returns {{valid: true, url: string} | {valid: false, error: string, message: string}}
 */
export function validateUrl(url) {
  const trimmed = String(url ?? "").trim();

  // 禁止 file:// 协议
  if (/^file:\/\//i.test(trimmed)) {
    return { valid: false, error: "forbidden_protocol", message: "禁止访问 file:// 协议" };
  }

  return { valid: true, url: trimmed };
}

/**
 * 清理选择器字符串，移除多余的引号和空白
 * @param {string} selector - 原始选择器
 * @returns {{original: string, cleaned: string, modified: boolean}}
 */
export function sanitizeSelector(selector) {
  // 处理 null/undefined 情况
  if (selector == null) {
    return { original: selector, cleaned: selector, modified: false };
  }
  
  const original = selector;
  let cleaned = String(selector).trim();
  
  // 移除首尾的双引号
  if (cleaned.startsWith('"') && cleaned.endsWith('"') && cleaned.length >= 2) {
    cleaned = cleaned.slice(1, -1);
  }
  // 移除首尾的单引号
  else if (cleaned.startsWith("'") && cleaned.endsWith("'") && cleaned.length >= 2) {
    cleaned = cleaned.slice(1, -1);
  }
  
  // 再次 trim 以处理引号内的空白
  cleaned = cleaned.trim();
  
  return {
    original,
    cleaned,
    modified: original !== cleaned
  };
}

/**
 * 获取页面对象，如果不存在返回错误
 * @param {import('./tab_manager.js').TabManager} tabManager
 * @param {string} tabId
 * @returns {{page: import('puppeteer-core').Page} | {error: string, tabId: string}}
 */
export function getPage(tabManager, tabId) {
  const page = tabManager.getPage(tabId);
  if (!page) {
    return { error: "tab_not_found", tabId };
  }
  return { page };
}
