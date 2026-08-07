/**
 * 可创建的文本文件类型定义。
 * 前端下拉列表与空文件创建逻辑统一依赖此结构，避免类型与后缀配置分散。
 */
export interface TextFileTypeOption {
  label: string;
  extension: string;
  mimeType: string;
  description: string;
}

/**
 * 工件管理器允许创建的文本文件类型列表。
 * 仅提供系统当前常见且可直接预览的文本类文件，避免把二进制类型混入创建入口。
 */
export const TEXT_FILE_TYPE_OPTIONS: TextFileTypeOption[] = [
  { label: '纯文本', extension: 'txt', mimeType: 'text/plain', description: '通用纯文本文件' },
  { label: 'Markdown', extension: 'md', mimeType: 'text/markdown', description: 'Markdown 文档' },
  { label: 'JavaScript', extension: 'js', mimeType: 'application/javascript', description: 'JavaScript 脚本' },
  { label: 'TypeScript', extension: 'ts', mimeType: 'application/typescript', description: 'TypeScript 脚本' },
  { label: 'JSON', extension: 'json', mimeType: 'application/json', description: 'JSON 数据文件' },
  { label: 'HTML', extension: 'html', mimeType: 'text/html', description: 'HTML 页面' },
  { label: 'CSS', extension: 'css', mimeType: 'text/css', description: 'CSS 样式表' },
  { label: 'YAML', extension: 'yml', mimeType: 'application/yaml', description: 'YAML 配置文件' },
  { label: 'XML', extension: 'xml', mimeType: 'application/xml', description: 'XML 数据文件' },
  { label: 'Python', extension: 'py', mimeType: 'text/x-python', description: 'Python 脚本' },
  { label: 'Shell', extension: 'sh', mimeType: 'text/x-shellscript', description: 'Shell 脚本' }
];

/**
 * 默认创建类型。
 * 当前默认值使用纯文本，保证首次打开弹窗即可直接创建最基础的文本文件。
 */
export const DEFAULT_TEXT_FILE_TYPE_OPTION = TEXT_FILE_TYPE_OPTIONS[0]!;

const INVALID_FILENAME_CHARACTERS = /[\\/:*?"<>|]/;

/**
 * 规范化名称比较值。
 * Windows 文件系统默认大小写不敏感，因此这里统一使用去首尾空格并转小写的方式比较。
 *
 * @param name 名称
 * @returns 规范化后的名称
 */
export function normalizeWorkspaceEntryName(name: string): string {
  return String(name || '').trim().toLocaleLowerCase();
}

/**
 * 判断当前目录中是否已存在同名文件或文件夹。
 *
 * @param existingNames 当前目录已有名称列表
 * @param targetName 待创建的名称
 * @returns 是否存在同名项
 */
export function hasWorkspaceEntryNameConflict(existingNames: string[], targetName: string): boolean {
  const normalizedTargetName = normalizeWorkspaceEntryName(targetName);
  if (!normalizedTargetName) {
    return false;
  }

  return existingNames.some((existingName) => normalizeWorkspaceEntryName(existingName) === normalizedTargetName);
}

/**
 * 校验用户输入的基础文件名。
 * 此处只校验名称本体，不处理后缀，避免把路径或非法字符写入上传接口。
 *
 * @param baseName 文件名主体，不含扩展名
 * @returns 校验错误信息；为空表示校验通过
 */
export function validateCreateFileBaseName(baseName: string): string {
  const normalizedName = String(baseName || '').trim();

  if (!normalizedName) {
    return '请输入文件名';
  }

  if (normalizedName === '.' || normalizedName === '..') {
    return '文件名不能为 . 或 ..';
  }

  if (INVALID_FILENAME_CHARACTERS.test(normalizedName)) {
    return '文件名不能包含 \\ / : * ? \" < > |';
  }

  if (/[. ]$/.test(normalizedName)) {
    return '文件名末尾不能是点或空格';
  }

  return '';
}

/**
 * 根据文件名主体和扩展名组合最终文件名。
 * 扩展名会自动去掉开头的点，保证表单展示与上传路径格式一致。
 *
 * @param baseName 文件名主体
 * @param extension 扩展名，可带或不带点号
 * @returns 组合后的最终文件名
 */
export function buildCreateFileName(baseName: string, extension: string): string {
  const normalizedName = String(baseName || '').trim();
  const normalizedExtension = String(extension || '').replace(/^\./, '').trim();

  if (!normalizedExtension) {
    return normalizedName;
  }

  return `${normalizedName}.${normalizedExtension}`;
}

/**
 * 生成用于上传接口的空文本文件对象。
 * 按用户要求，新建文件复用上传接口，仅把文件内容固定为一个空字符串。
 *
 * @param baseName 文件名主体
 * @param typeOption 文件类型配置
 * @returns 可直接加入 FormData 的空文件对象
 */
export function createEmptyTextFile(baseName: string, typeOption: TextFileTypeOption): File {
  const filename = buildCreateFileName(baseName, typeOption.extension);
  return new File([''], filename, { type: typeOption.mimeType });
}
