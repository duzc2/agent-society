/**
 * 文档类型检测器
 * 根据文件扩展名识别文档类型。
 */

/** 支持的文档类型 */
const SUPPORTED_TYPES = {
  pdf:  { extensions: [".pdf"],  parser: "pdf" },
  docx: { extensions: [".docx"], parser: "office" },
  xlsx: { extensions: [".xlsx"], parser: "office" },
  pptx: { extensions: [".pptx"], parser: "office" },
};

/** 所有支持的扩展名（扁平化） */
const ALL_EXTENSIONS = Object.values(SUPPORTED_TYPES).flatMap(t => t.extensions);

/**
 * 根据文件路径识别文档类型。
 * @param {string} filePath - 文件路径或文件名
 * @returns {{ type: string, parser: string } | null} 文档类型信息，不支持则返回 null
 */
export function detectType(filePath) {
  const lower = filePath.toLowerCase();
  for (const [type, info] of Object.entries(SUPPORTED_TYPES)) {
    if (info.extensions.some(ext => lower.endsWith(ext))) {
      return { type, parser: info.parser };
    }
  }
  return null;
}

/**
 * 检查扩展名是否受支持。
 * @param {string} filePath - 文件路径
 * @returns {boolean}
 */
export function isSupported(filePath) {
  return detectType(filePath) !== null;
}

/**
 * 获取所有支持的扩展名列表（用于错误提示）。
 * @returns {string[]}
 */
export function getSupportedExtensions() {
  return [...ALL_EXTENSIONS];
}

/**
 * 获取可读的类型标签。
 * @param {string} type - 类型键（如 "pdf", "docx"）
 * @returns {string}
 */
export function getTypeLabel(type) {
  const labels = { pdf: "PDF", docx: "Word", xlsx: "Excel", pptx: "PowerPoint" };
  return labels[type] || type;
}
