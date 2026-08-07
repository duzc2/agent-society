/**
 * Content Type Utilities
 * 
 * 通用的内容类型检测和映射工具。
 * 提供 MIME 类型、文件扩展名、二进制类型检测等功能。
 * 
 * 从 artifact_content_router 和 capability_router 中提取的通用部分。
 * 
 * Requirements: 5.2, 5.4, 5.5
 */

/**
 * @typedef {Object} BinaryTypeResult
 * @property {'image' | 'audio' | 'video' | 'document' | 'other'} type - Binary content type
 * @property {number} confidence - Detection confidence (0-1)
 */

/**
 * MIME type to binary type mappings
 */
export const MIME_TYPE_MAPPINGS = {
  // Images
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/bmp': 'image',
  'image/avif': 'image',
  'image/svg+xml': 'image',
  'image/tiff': 'image',
  
  // Audio
  'audio/mpeg': 'audio',
  'audio/mp3': 'audio',
  'audio/wav': 'audio',
  'audio/ogg': 'audio',
  'audio/aac': 'audio',
  'audio/flac': 'audio',
  
  // Video
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',
  'video/x-msvideo': 'video',
  'video/mpeg': 'video',
  
  // Documents
  'application/pdf': 'document',
  'application/msword': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.ms-excel': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
  'application/vnd.ms-powerpoint': 'document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'document'
};



/**
 * Extract file extension from filename
 * 
 * @param {string} filename - Filename
 * @returns {string|null} Extension (with dot) or null
 */
export function extractExtension(filename) {
  if (!filename || typeof filename !== 'string') {
    return null;
  }
  
  const lastDot = filename.lastIndexOf('.');
  if (lastDot > 0 && lastDot < filename.length - 1) {
    return filename.substring(lastDot).toLowerCase();
  }
  
  return null;
}

/**
 * 清理 MIME 类型字符串
 * 处理大模型调用时可能产生的格式错误：
 * - 去除两侧的空格、单引号、双引号
 * - 提取中间符合 MIME 格式的部分（type/subtype 格式）
 * 
 * @param {string} mimeType - 原始 MIME 类型
 * @returns {string} 清理后的 MIME 类型，如果无效则返回空字符串
 */
export function sanitizeMimeType(mimeType) {
  if (!mimeType || typeof mimeType !== 'string') {
    return '';
  }
  
  // 去除两侧的空格、单引号、双引号
  let cleaned = mimeType.trim().replace(/^['"]+|['"]+$/g, '');
  
  // 提取中间符合 MIME 格式的部分：type/subtype
  // MIME 类型格式：主类型/子类型，如 text/plain, application/json
  // 主类型和子类型只能包含字母、数字、连字符、加号、点号
  const mimePattern = /^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_+]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_+.]*$/;
  
  // 如果整个字符串符合 MIME 格式，直接返回
  if (mimePattern.test(cleaned)) {
    return cleaned.toLowerCase();
  }
  
  // 尝试从字符串中提取符合 MIME 格式的部分
  // 匹配 type/subtype 格式的子字符串
  const match = cleaned.match(/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_+]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_+.]+/);
  if (match) {
    return match[0].toLowerCase();
  }
  
  // 如果都不符合，返回空字符串表示清理失败
  return '';
}

/**
 * MIME type to file extension mappings
 * 用于根据 MIME 类型推断文件扩展名
 */
export const MIME_TO_EXTENSION = {
  // 文本类型
  'text/plain': 'txt',
  'text/html': 'html',
  'text/css': 'css',
  'text/javascript': 'js',
  'text/xml': 'xml',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'text/json': 'json',
  
  // 应用类型（文本）
  'application/json': 'json',
  'application/xml': 'xml',
  'application/javascript': 'js',
  'application/x-javascript': 'js',
  'application/xhtml+xml': 'xhtml',
  'application/svg+xml': 'svg',
  'application/rss+xml': 'rss',
  'application/atom+xml': 'atom',
  'application/x-www-form-urlencoded': 'txt',
  'application/yaml': 'yaml',
  'application/x-yaml': 'yaml',
  'application/typescript': 'ts',
  
  // 图片类型
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/x-icon': 'ico',
  
  // 音频类型
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  
  // 视频类型
  'video/mp4': 'mp4',
  'video/mpeg': 'mpeg',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/x-msvideo': 'avi',
  'video/quicktime': 'mov',
  'video/x-ms-wmv': 'wmv',
  'video/x-flv': 'flv',
  
  // 文档类型
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/rtf': 'rtf',
  'application/epub+zip': 'epub',
  
  // 压缩包类型
  'application/zip': 'zip',
  'application/x-rar-compressed': 'rar',
  'application/x-7z-compressed': '7z',
  'application/gzip': 'gz',
  'application/x-gzip': 'gz',
  'application/x-tar': 'tar',
  'application/x-bzip2': 'bz2',
  'application/x-xz': 'xz',
  
  // 其他二进制类型
  'application/octet-stream': 'bin',
  'application/x-msdownload': 'exe',
  'application/x-shockwave-flash': 'swf',
  'application/wasm': 'wasm'
};

/**
 * Friendly type names for user-facing descriptions
 */
export const FRIENDLY_TYPE_NAMES = {
  'image/jpeg': 'JPEG Image',
  'image/jpg': 'JPEG Image',
  'image/png': 'PNG Image',
  'image/gif': 'GIF Image',
  'image/webp': 'WebP Image',
  'image/bmp': 'BMP Image',
  'image/avif': 'AVIF Image',
  'image/svg+xml': 'SVG Image',
  'application/pdf': 'PDF Document',
  'application/msword': 'Word Document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word Document',
  'application/vnd.ms-excel': 'Excel Spreadsheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel Spreadsheet',
  'application/vnd.ms-powerpoint': 'PowerPoint Presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint Presentation',
  'audio/mpeg': 'MP3 Audio',
  'audio/mp3': 'MP3 Audio',
  'audio/wav': 'WAV Audio',
  'audio/ogg': 'OGG Audio',
  'video/mp4': 'MP4 Video',
  'video/webm': 'WebM Video',
  'video/quicktime': 'QuickTime Video',
  'application/octet-stream': 'Binary File'
};

/**
 * Attachment type to capability type mappings
 */
export const ATTACHMENT_TYPE_TO_CAPABILITY = {
  image: 'vision',
  audio: 'audio',
  file: 'file',
  video: 'video'
};

/**
 * Detect the specific type of binary content
 * 
 * @param {Object} fileInfo - File info object from Workspace
 * @returns {BinaryTypeResult} Binary type and confidence
 */
export function detectBinaryType(fileInfo) {
  const mimeType = fileInfo?.mimeType;
  const filename = fileInfo?.filename || fileInfo?.path;
  
  // Priority 1: MIME type detection
  if (mimeType && typeof mimeType === 'string') {
    const normalizedMime = mimeType.toLowerCase().trim();
    
    // Check exact match
    if (MIME_TYPE_MAPPINGS[normalizedMime]) {
      return {
        type: MIME_TYPE_MAPPINGS[normalizedMime],
        confidence: 0.95
      };
    }
    
    // Check prefix match
    if (normalizedMime.startsWith('image/')) {
      return { type: 'image', confidence: 0.9 };
    }
    if (normalizedMime.startsWith('audio/')) {
      return { type: 'audio', confidence: 0.9 };
    }
    if (normalizedMime.startsWith('video/')) {
      return { type: 'video', confidence: 0.9 };
    }
  }
  
  // Priority 2: Extension detection
  if (filename && typeof filename === 'string') {
    const ext = extractExtension(filename);
    if (ext && EXTENSION_MAPPINGS[ext]) {
      return {
        type: EXTENSION_MAPPINGS[ext],
        confidence: 0.85
      };
    }
  }
  
  // Default: unknown type
  return {
    type: 'other',
    confidence: 0.5
  };
}

/**
 * 扩展名到 MIME 类型的映射
 * 根据 MIME_TO_EXTENSION 反向生成，用于根据文件扩展名推断 MIME 类型
 */
export const EXTENSION_TO_MIME = Object.entries(MIME_TO_EXTENSION).reduce((acc, [mime, ext]) => {
  // 只保留第一个映射（优先级更高）
  if (!acc[ext]) {
    acc[ext] = mime;
  }
  return acc;
}, {});

/**
 * Extension to binary type mappings
 * 
 * 自动从 MIME_TO_EXTENSION 和 MIME_TYPE_MAPPINGS 生成映射
 */
export const EXTENSION_MAPPINGS = Object.entries(EXTENSION_TO_MIME).reduce((acc, [ext, mime]) => {
  const dotExt = `.${ext}`;
  
  // 1. 尝试从 MIME 类型映射中查找
  if (MIME_TYPE_MAPPINGS[mime]) {
    acc[dotExt] = MIME_TYPE_MAPPINGS[mime];
    return acc;
  }
  
  // 2. 尝试从 MIME 类型前缀查找
  const prefix = mime.split('/')[0];
  if (['image', 'audio', 'video'].includes(prefix)) {
    acc[dotExt] = prefix;
    return acc;
  }
  
  // 3. 特殊文档类型处理
  if (mime === 'application/pdf' || 
      mime.includes('msword') || 
      mime.includes('officedocument') || 
      mime.includes('ms-excel') || 
      mime.includes('ms-powerpoint')) {
    acc[dotExt] = 'document';
  }
  
  return acc;
}, {
  // 补充一些无法自动生成的映射
});

/**
 * 根据文件扩展名获取 MIME 类型
 * 
 * @param {string} filename - 文件名
 * @returns {string|null} MIME 类型，未找到返回 null
 */
export function getMimeTypeFromExtension(filename) {
  if (!filename || typeof filename !== 'string') {
    return null;
  }
  
  const ext = extractExtension(filename);
  if (!ext) {
    return null;
  }
  
  // 去除点号
  const extWithoutDot = ext.slice(1);
  return EXTENSION_TO_MIME[extWithoutDot] || null;
}

/**
 * 文本类型的 MIME 前缀和精确匹配列表
 * 用于判断内容是否为纯文本
 */
const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_TYPES = [
  'application/json',
  'application/xml',
  'application/javascript',
  'application/xhtml+xml',
  'application/svg+xml',
  'application/rss+xml',
  'application/atom+xml',
  'application/x-javascript',
  'application/x-www-form-urlencoded',
  'application/yaml',
  'application/x-yaml',
  'application/typescript'
];

/**
 * 文本文件的扩展名列表
 * 包含常见的代码、配置、文档等纯文本格式
 */
export const TEXT_EXTENSIONS = [
  // 文档
  '.txt', '.md', '.markdown', '.log', '.csv',
  // Web 前端
  '.js', '.ts', '.jsx', '.tsx', '.vue', '.html', '.htm', '.css', '.scss', '.sass', '.less',
  // 数据格式
  '.json', '.xml', '.yaml', '.yml',
  // 编程语言
  '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.go', '.rs', '.rb', '.php',
  // 脚本
  '.sh', '.bat', '.cmd', '.ps1',
  // 配置
  '.ini', '.conf', '.cfg', '.properties', '.env', '.gitignore', '.dockerignore',
  // 其他
  '.sql', '.gradle', '.editorconfig'
];

/**
 * 判断文件名是否表示文本文件
 * 基于扩展名判断
 * 
 * @param {string} filename - 文件名或路径
 * @returns {boolean} 是否为文本文件
 */
export function isTextFile(filename) {
  const ext = extractExtension(filename);
  if (!ext) return false;
  return TEXT_EXTENSIONS.includes(ext.toLowerCase());
}

/**
 * 判断 MIME 类型是否为文本类型
 * 
 * @param {string} mimeType - MIME 类型
 * @returns {boolean} 是否为文本类型
 */
export function isTextMimeType(mimeType) {
  if (!mimeType || typeof mimeType !== 'string') {
    return false;
  }
  
  const normalized = mimeType.toLowerCase().trim().split(';')[0];
  
  // 检查前缀匹配（如 text/plain, text/html）
  for (const prefix of TEXT_MIME_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return true;
    }
  }
  
  // 检查精确匹配
  return TEXT_MIME_TYPES.includes(normalized);
}

/**
 * 根据 MIME 类型获取文件扩展名
 * 
 * @param {string} mimeType - MIME 类型
 * @returns {string|null} 扩展名（不含点），未找到返回 null
 */
export function getExtensionFromMimeType(mimeType) {
  if (!mimeType || typeof mimeType !== 'string') {
    return null;
  }
  
  const normalized = mimeType.toLowerCase().trim().split(';')[0];
  return MIME_TO_EXTENSION[normalized] || null;
}

/**
 * Get friendly type name for MIME type
 * 
 * @param {string} mimeType - MIME type
 * @returns {string} Friendly type name
 */
export function getFriendlyTypeName(mimeType) {
  if (!mimeType || typeof mimeType !== 'string') {
    return 'Binary File';
  }
  
  const normalized = mimeType.toLowerCase().trim();
  
  // Check exact match
  if (FRIENDLY_TYPE_NAMES[normalized]) {
    return FRIENDLY_TYPE_NAMES[normalized];
  }
  
  // Check prefix match
  if (normalized.startsWith('image/')) {
    return 'Image File';
  }
  if (normalized.startsWith('audio/')) {
    return 'Audio File';
  }
  if (normalized.startsWith('video/')) {
    return 'Video File';
  }
  if (normalized.startsWith('text/')) {
    return 'Text File';
  }
  
  // Return MIME type as-is
  return mimeType;
}
