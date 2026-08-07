/**
 * PDF 文本提取器
 * 使用 unpdf 库提取 PDF 文件中的文本内容。
 */

import { readFile } from "node:fs/promises";
import { extractText } from "unpdf";

/**
 * 从 PDF 文件提取文本。
 * @param {object} options
 * @param {string} options.filePath - 文件绝对路径
 * @param {any} log - 日志对象
 * @returns {Promise<{ ok: true, content: string, metadata: object } | { error: string, message: string }>}
 */
export async function parsePdf({ filePath, log }) {
  try {
    const pdfBuffer = await readFile(filePath);
    // unpdf 只接受 Uint8Array，拒绝 Node.js Buffer
    const { totalPages, text } = await extractText(new Uint8Array(pdfBuffer));
    const content = Array.isArray(text) ? text.join("\n") : text;

    if (!content || content.trim().length === 0) {
      return { error: "empty_content", message: "PDF 文件中无可提取的文本内容" };
    }

    const metadata = {
      type: "pdf",
      parser: "pdf",
      totalPages,
    };

    return { ok: true, content: content.trim(), metadata };
  } catch (err) {
    log.error("[PDFParser] 解析 PDF 失败", {
      filePath,
      message: err.message,
      stack: err.stack,
    });
    return {
      error: "pdf_parse_error",
      message: `PDF 解析失败: ${err.message}`,
    };
  }
}

/**
 * 获取 PDF 文件的元数据（页数等）。
 * @param {object} options
 * @param {string} options.filePath - 文件绝对路径
 * @param {any} log - 日志对象
 * @returns {Promise<{ ok: true, metadata: object } | { error: string, message: string }>}
 */
export async function getPdfMetadata({ filePath, log }) {
  try {
    const pdfBuffer = await readFile(filePath);
    // unpdf 只接受 Uint8Array，拒绝 Node.js Buffer
    const { totalPages, text } = await extractText(new Uint8Array(pdfBuffer));
    const joined = Array.isArray(text) ? text.join("") : text;

    const metadata = {
      type: "pdf",
      totalPages,
      hasText: joined.trim().length > 0,
      charCount: joined.length,
    };

    return { ok: true, metadata };
  } catch (err) {
    log.error("[PDFParser] 获取 PDF 元数据失败", {
      filePath,
      message: err.message,
      stack: err.stack,
    });
    return {
      error: "pdf_parse_error",
      message: `获取 PDF 元数据失败: ${err.message}`,
    };
  }
}
