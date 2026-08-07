/**
 * Office 文档文本提取器
 * 使用 officeparser 库提取 .docx/.xlsx/.pptx 文件中的文本内容。
 */

import { parseOffice as parseOfficeFile } from "officeparser";

/**
 * 从 Office 文件提取文本。
 * @param {object} options
 * @param {string} options.filePath - 文件绝对路径
 * @param {string} options.type - 文档类型 ("docx" | "xlsx" | "pptx")
 * @param {string} [options.format] - 输出格式 ("text" | "markdown")
 * @param {any} log - 日志对象
 * @returns {Promise<{ ok: true, content: string, metadata: object } | { error: string, message: string }>}
 */
export async function parseOffice({ filePath, type, format, log }) {
  try {
    const ast = await parseOfficeFile(filePath);
    const content = ast.toText();

    if (!content || content.trim().length === 0) {
      return { error: "empty_content", message: "Office 文档中无可提取的文本内容" };
    }

    const outputFormat = format === "markdown" ? "markdown" : "text";

    const metadata = {
      type,
      parser: "office",
      format: outputFormat,
    };

    return { ok: true, content: content.trim(), metadata };
  } catch (err) {
    log.error("[OfficeParser] 解析 Office 文档失败", {
      filePath,
      type,
      message: err.message,
      stack: err.stack,
    });
    return {
      error: "office_parse_error",
      message: `Office 文档解析失败: ${err.message}`,
    };
  }
}

/**
 * 获取 Office 文件的元数据。
 * @param {object} options
 * @param {string} options.filePath - 文件绝对路径
 * @param {string} options.type - 文档类型
 * @param {any} log - 日志对象
 * @returns {Promise<{ ok: true, metadata: object } | { error: string, message: string }>}
 */
export async function getOfficeMetadata({ filePath, type, log }) {
  try {
    const ast = await parseOfficeFile(filePath);
    const content = ast.toText();

    const metadata = {
      type,
      hasText: !!(content && content.trim().length > 0),
      charCount: content ? content.length : 0,
    };

    return { ok: true, metadata };
  } catch (err) {
    log.error("[OfficeParser] 获取 Office 元数据失败", {
      filePath,
      type,
      message: err.message,
      stack: err.stack,
    });
    return {
      error: "office_parse_error",
      message: `获取 Office 元数据失败: ${err.message}`,
    };
  }
}
