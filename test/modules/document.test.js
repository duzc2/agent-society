/**
 * Document 模块测试
 *
 * 覆盖：Type Detector / 模块接口 / 工具定义 / DocumentReader / 集成 / 错误结构
 *
 * Mock 策略：
 *   - 解析器模块 (pdf_parser.js / office_parser.js) → mock.module(fileURL, namedExports)
 *     直接 mock 解析器层，绕过 unpdf/officeparser 等 npm 包的 CJS/ESM 兼容问题
 *   - pathResolver / permissionManager → 用 mock.fn 直接提供，覆盖 workspace/external 分支
 *   - 文件系统 → 真实临时文件（不 mock）
 */

import { describe, it, mock, before, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, rm, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

// 解析器文件的绝对 file:// URL（用于 mock.module）
const PDF_PARSER_URL = pathToFileURL(
  join(__filename, "../../../modules/document/parser/pdf_parser.js"),
).href;
const OFFICE_PARSER_URL = pathToFileURL(
  join(__filename, "../../../modules/document/parser/office_parser.js"),
).href;

// 无需 mock 的模块 —— 顶层静态导入
import {
  detectType,
  isSupported,
  getSupportedExtensions,
  getTypeLabel,
} from "../../modules/document/parser/type_detector.js";
import { makeTestLogger, testLoggerRoot } from "../helpers/test_logger.js";
import { registry } from "../../src/platform/core/module_registry.js";

// =============================================================================
// 辅助函数：mock DocumentReader 依赖
// =============================================================================

/**
 * 创建一个 mock PathResolver。
 * 默认返回 workspace scope，将相对路径拼到 tempDir；
 * 需要 external 分支时可在测试中覆盖 resolvePath.mockImplementation。
 */
function makeMockPathResolver(tempDir, { scope = "workspace", orgId = "org-1" } = {}) {
  return {
    resolvePath: mock.fn(async (_ctx, rawPath) => ({
      scope,
      absolutePath: scope === "workspace" ? join(tempDir, rawPath) : rawPath,
      relativePath: scope === "workspace" ? rawPath : null,
      orgId,
    })),
  };
}

/**
 * 创建一个 mock ExternalPermissionManager。
 * 默认允许读取；需要拒绝分支时传入 allowed=false。
 */
function makeMockPermissionManager(allowed = true) {
  return {
    checkReadPermission: mock.fn(async (_absPath, _orgId) => ({ allowed })),
  };
}

// =============================================================================
// 辅助函数：生成最小有效文件
// =============================================================================

/**
 * 生成一个最小有效 PDF（含 "Hello PDF World" 文本，1 页）。
 * 通过程序化计算 xref 偏移量保证格式正确，不依赖任何第三方库。
 */
function makeMinimalPdf() {
  const streamContent = "BT /F1 24 Tf 100 700 Td (Hello PDF World) Tj ET";
  const header = "%PDF-1.4\n%\xFF\xFF\xFF\xFF\n";
  const bodyParts = [
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n",
    "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n",
    "4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n",
    `5 0 obj<</Length ${Buffer.byteLength(streamContent)}>>stream\n${streamContent}\nendstream\nendobj\n`,
  ];
  let pos = header.length;
  const offsets = [];
  for (const part of bodyParts) {
    offsets.push(pos);
    pos += Buffer.byteLength(part);
  }
  const xref = `xref\n0 6\n0000000000 65535 f \n` +
    offsets.map((o, i) => `${String(o).padStart(10, "0")} 00000 n `).join("\n") + "\n";
  const body = bodyParts.join("");
  const trailer = `trailer<</Size 6/Root 1 0 R>>\nstartxref\n${header.length + body.length}\n%%EOF\n`;
  return Buffer.from(header + body + xref + trailer);
}

/**
 * 生成一个最小有效 DOCX（内容为 "Hello DOCX World"）。
 * DOCX 是 ZIP 格式，包含至少 [Content_Types].xml 和 word/document.xml。
 */
/**
 * 生成一个最小有效 DOCX（内容为 "Hello DOCX World"）。
 * DOCX 是 ZIP 格式，手动构造 Stored（无压缩）条目。
 */
function makeMinimalDocx() {
  // 使用 Node.js 内置 zlib 无法直接创建 ZIP。用 zip 命令行或手动构造 ZIP 结构。
  // 这里构造一个最简 valid DOCX（gzip 方式不可行，需真实 ZIP）。
  // 直接用字节构造一个带 Stored（无压缩）条目的 ZIP 文件。
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello DOCX World</w:t></w:r></w:p></w:body></w:document>';

  const files = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes) },
    { name: "_rels/.rels", data: Buffer.from(rels) },
    { name: "word/document.xml", data: Buffer.from(documentXml) },
  ];

  // 构造 ZIP（Stored 方式，无压缩）
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = Buffer.from(f.name);
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);     // local signature
    localHeader.writeUInt16LE(20, 4);              // version needed
    localHeader.writeUInt16LE(0, 6);               // flags
    localHeader.writeUInt16LE(0, 8);               // compression: stored
    localHeader.writeUInt16LE(0, 10);              // mod time
    localHeader.writeUInt16LE(0, 12);              // mod date
    // CRC32: 0 (for simplicity)
    localHeader.writeUInt32LE(crc32(f.data), 14);  // crc32
    localHeader.writeUInt32LE(f.data.length, 18);  // compressed size
    localHeader.writeUInt32LE(f.data.length, 22);  // uncompressed size
    localHeader.writeUInt16LE(nameBytes.length, 26); // filename length
    localHeader.writeUInt16LE(0, 28);              // extra field length
    nameBytes.copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);    // central signature
    centralHeader.writeUInt16LE(20, 4);             // version made by
    centralHeader.writeUInt16LE(20, 6);             // version needed
    centralHeader.writeUInt16LE(0, 8);              // flags
    centralHeader.writeUInt16LE(0, 10);             // compression: stored
    centralHeader.writeUInt16LE(0, 12);             // mod time
    centralHeader.writeUInt16LE(0, 14);             // mod date
    centralHeader.writeUInt32LE(crc32(f.data), 16); // crc32
    centralHeader.writeUInt32LE(f.data.length, 20); // compressed size
    centralHeader.writeUInt32LE(f.data.length, 24); // uncompressed size
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);             // extra field
    centralHeader.writeUInt16LE(0, 32);             // comment
    centralHeader.writeUInt16LE(0, 34);             // disk number
    centralHeader.writeUInt16LE(0, 36);             // internal attrs
    centralHeader.writeUInt32LE(0, 38);             // external attrs
    centralHeader.writeUInt32LE(offset, 42);         // local header offset
    nameBytes.copy(centralHeader, 46);

    localHeaders.push(localHeader);
    centralHeaders.push(centralHeader);
    offset += localHeader.length + f.data.length;
  }

  const centralDir = Buffer.concat(centralHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const parts = [];
  for (let i = 0; i < files.length; i++) {
    parts.push(localHeaders[i], files[i].data);
  }
  parts.push(centralDir, eocd);
  return Buffer.concat(parts);
}

/**
 * 简易 CRC32 计算（用于 ZIP）。
 */
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// =============================================================================
// 测试组 7: PDF Parser — 真实临时文件 + 真实 unpdf
// =============================================================================

describe("PDF Parser", () => {
  /** @type {typeof import("../../modules/document/parser/pdf_parser.js").parsePdf} */
  let parsePdf;
  /** @type {typeof import("../../modules/document/parser/pdf_parser.js").getPdfMetadata} */
  let getPdfMetadata;
  /** @type {string} */
  let tempDir;
  /** @type {string} */
  let pdfPath;
  /** @type {string} */
  let missingPath;

  before(async () => {
    const mod = await import("../../modules/document/parser/pdf_parser.js");
    parsePdf = mod.parsePdf;
    getPdfMetadata = mod.getPdfMetadata;
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pdf-parser-"));
    pdfPath = join(tempDir, "test.pdf");
    missingPath = join(tempDir, "nonexistent.pdf");
    await writeFile(pdfPath, makeMinimalPdf());
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("parsePdf()", () => {
    it("有效 PDF → ok: true + 提取文本 + metadata", async () => {
      const result = await parsePdf({
        filePath: pdfPath,
        log: makeTestLogger("PdfParser"),
      });

      assert.strictEqual(result.ok, true);
      assert.ok(result.content.includes("Hello PDF World"),
        `内容应含 'Hello PDF World'，实际: ${result.content}`);
      assert.strictEqual(typeof result.content, "string");
      assert.strictEqual(result.metadata.type, "pdf");
      assert.strictEqual(result.metadata.parser, "pdf");
      assert.strictEqual(result.metadata.totalPages, 1);
    });

    it("文件不存在 → error: 'pdf_parse_error'", async () => {
      const result = await parsePdf({
        filePath: missingPath,
        log: makeTestLogger("PdfParser"),
      });

      assert.strictEqual(result.error, "pdf_parse_error");
    });

    it("非法 PDF 文件 → error: 'pdf_parse_error'", async () => {
      const badPath = join(tempDir, "bad.pdf");
      await writeFile(badPath, "not a pdf file");

      const result = await parsePdf({
        filePath: badPath,
        log: makeTestLogger("PdfParser"),
      });

      assert.strictEqual(result.error, "pdf_parse_error");
    });
  });

  describe("getPdfMetadata()", () => {
    it("有效 PDF → ok + metadata 含 totalPages/hasText/charCount", async () => {
      const result = await getPdfMetadata({
        filePath: pdfPath,
        log: makeTestLogger("PdfParser"),
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.metadata.type, "pdf");
      assert.strictEqual(result.metadata.totalPages, 1);
      assert.strictEqual(result.metadata.hasText, true);
      assert.ok(result.metadata.charCount > 0, `charCount 应 > 0, 实际: ${result.metadata.charCount}`);
    });

    it("文件不存在 → error: 'pdf_parse_error'", async () => {
      const result = await getPdfMetadata({
        filePath: missingPath,
        log: makeTestLogger("PdfParser"),
      });

      assert.strictEqual(result.error, "pdf_parse_error");
    });
  });
});

// =============================================================================
// 测试组 8: Office Parser — 真实临时文件 + 真实 officeparser
// =============================================================================

describe("Office Parser", () => {
  /** @type {typeof import("../../modules/document/parser/office_parser.js").parseOffice} */
  let parseOffice;
  /** @type {typeof import("../../modules/document/parser/office_parser.js").getOfficeMetadata} */
  let getOfficeMetadata;
  /** @type {string} */
  let tempDir;
  /** @type {string} */
  let docxPath;
  /** @type {string} */
  let missingPath;

  before(async () => {
    const mod = await import("../../modules/document/parser/office_parser.js");
    parseOffice = mod.parseOffice;
    getOfficeMetadata = mod.getOfficeMetadata;
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "office-parser-"));
    docxPath = join(tempDir, "test.docx");
    missingPath = join(tempDir, "nonexistent.docx");
    await writeFile(docxPath, makeMinimalDocx());
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("parseOffice()", () => {
    it("有效 DOCX → ok: true + 提取文本 + metadata", async () => {
      const result = await parseOffice({
        filePath: docxPath,
        type: "docx",
        log: makeTestLogger("OfficeParser"),
      });

      assert.strictEqual(result.ok, true);
      assert.ok(result.content.includes("Hello DOCX World"),
        `内容应含 'Hello DOCX World'，实际: ${result.content}`);
      assert.strictEqual(typeof result.content, "string");
      assert.strictEqual(result.metadata.type, "docx");
      assert.strictEqual(result.metadata.parser, "office");
    });

    it("format=markdown → metadata.format = 'markdown'", async () => {
      const result = await parseOffice({
        filePath: docxPath,
        type: "docx",
        format: "markdown",
        log: makeTestLogger("OfficeParser"),
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.metadata.format, "markdown");
    });

    it("文件不存在 → error: 'office_parse_error'", async () => {
      const result = await parseOffice({
        filePath: missingPath,
        type: "docx",
        log: makeTestLogger("OfficeParser"),
      });

      assert.strictEqual(result.error, "office_parse_error");
    });
  });

  describe("getOfficeMetadata()", () => {
    it("有效 DOCX → ok + metadata 含 hasText/charCount", async () => {
      const result = await getOfficeMetadata({
        filePath: docxPath,
        type: "docx",
        log: makeTestLogger("OfficeParser"),
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.metadata.type, "docx");
      assert.strictEqual(result.metadata.hasText, true);
      assert.ok(result.metadata.charCount > 0, `charCount 应 > 0, 实际: ${result.metadata.charCount}`);
    });

    it("文件不存在 → error: 'office_parse_error'", async () => {
      const result = await getOfficeMetadata({
        filePath: missingPath,
        type: "docx",
        log: makeTestLogger("OfficeParser"),
      });

      assert.strictEqual(result.error, "office_parse_error");
    });
  });
});

// =============================================================================
// 主测试套件
// =============================================================================

describe("Document Module", () => {
  // -- 共享 mock 状态（在 before 中初始化） --
  /** @type {import("node:test").Mock<(...args: any[]) => any>} */
  let mockParsePdf;
  /** @type {import("node:test").Mock<(...args: any[]) => any>} */
  let mockGetPdfMetadata;
  /** @type {import("node:test").Mock<(...args: any[]) => any>} */
  let mockParseOfficeFn;
  /** @type {import("node:test").Mock<(...args: any[]) => any>} */
  let mockGetOfficeMetadata;

  /** @type {(...args: any[]) => any} */
  let parsePdfImpl;
  /** @type {(...args: any[]) => any} */
  let getPdfMetadataImpl;
  /** @type {(...args: any[]) => any} */
  let parseOfficeImpl;
  /** @type {(...args: any[]) => any} */
  let getOfficeMetadataImpl;

  /** @type {any} */
  let docModule;
  /** @type {typeof import("../../modules/document/document_reader.js").DocumentReader} */
  let DocumentReaderClass;

  /** 模块级共享 pathResolver/permissionManager，避免 integration after 清理后引用已删除临时目录 */
  let sharedPathResolver;
  let sharedPermissionManager;

  before(async () => {
    // 可变实现：允许测试按需覆盖行为
    parsePdfImpl = ({ filePath }) =>
      Promise.resolve({
        ok: true,
        content: "mock PDF content",
        metadata: { type: "pdf", parser: "pdf" },
      });
    getPdfMetadataImpl = ({ filePath }) =>
      Promise.resolve({
        ok: true,
        metadata: { type: "pdf", hasText: true, charCount: 16 },
      });
    parseOfficeImpl = ({ filePath, type, format }) =>
      Promise.resolve({
        ok: true,
        content: "mock Office content",
        metadata: { type, parser: "office", format: format || "text" },
      });
    getOfficeMetadataImpl = ({ filePath, type }) =>
      Promise.resolve({
        ok: true,
        metadata: { type, hasText: true, charCount: 17 },
      });

    mockParsePdf = mock.fn((...args) => parsePdfImpl(...args));
    mockGetPdfMetadata = mock.fn((...args) => getPdfMetadataImpl(...args));
    mockParseOfficeFn = mock.fn((...args) => parseOfficeImpl(...args));
    mockGetOfficeMetadata = mock.fn((...args) => getOfficeMetadataImpl(...args));

    // Mock 解析器模块 —— mock.module 必须在测试上下文中调用，不能在顶层
    await mock.module(PDF_PARSER_URL, {
      namedExports: {
        parsePdf: mockParsePdf,
        getPdfMetadata: mockGetPdfMetadata,
      },
    });
    await mock.module(OFFICE_PARSER_URL, {
      namedExports: {
        parseOffice: mockParseOfficeFn,
        getOfficeMetadata: mockGetOfficeMetadata,
      },
    });

    // 动态 import 必须在 mock.module 之后，使 mock 拦截生效
    docModule = (await import("../../modules/document/index.js")).default;
    const readerMod = await import("../../modules/document/document_reader.js");
    DocumentReaderClass = readerMod.DocumentReader;
  });

  // 测试套件结束后清理 mock，避免污染其他测试文件
  after(() => {
    mock.restoreAll();
  });

  // 每个测试前重置调用计数和默认实现
  beforeEach(() => {
    mockParsePdf.mock.resetCalls();
    mockGetPdfMetadata.mock.resetCalls();
    mockParseOfficeFn.mock.resetCalls();
    mockGetOfficeMetadata.mock.resetCalls();

    parsePdfImpl = ({ filePath }) =>
      Promise.resolve({
        ok: true,
        content: "mock PDF content",
        metadata: { type: "pdf", parser: "pdf" },
      });
    getPdfMetadataImpl = ({ filePath }) =>
      Promise.resolve({
        ok: true,
        metadata: { type: "pdf", hasText: true, charCount: 16 },
      });
    parseOfficeImpl = ({ filePath, type, format }) =>
      Promise.resolve({
        ok: true,
        content: "mock Office content",
        metadata: { type, parser: "office", format: format || "text" },
      });
    getOfficeMetadataImpl = ({ filePath, type }) =>
      Promise.resolve({
        ok: true,
        metadata: { type, hasText: true, charCount: 17 },
      });
  });

  // ===========================================================================
  // 测试组 1: Type Detector 纯单元测试
  // ===========================================================================

  describe("Type Detector — 纯单元测试", () => {
    describe("detectType()", () => {
      it("应识别 .pdf 文件", () => {
        const result = detectType("document.pdf");
        assert.deepStrictEqual(result, { type: "pdf", parser: "pdf" });
      });

      it("应识别 .docx 文件", () => {
        const result = detectType("document.docx");
        assert.deepStrictEqual(result, { type: "docx", parser: "office" });
      });

      it("应识别 .xlsx 文件", () => {
        const result = detectType("document.xlsx");
        assert.deepStrictEqual(result, { type: "xlsx", parser: "office" });
      });

      it("应识别 .pptx 文件", () => {
        const result = detectType("document.pptx");
        assert.deepStrictEqual(result, { type: "pptx", parser: "office" });
      });

      it("应识别带路径前缀的文件", () => {
        const result = detectType("/home/user/docs/report.pdf");
        assert.deepStrictEqual(result, { type: "pdf", parser: "pdf" });
      });

      it("应识别 Windows 路径中的文件", () => {
        const result = detectType("C:\\Users\\data\\sheet.xlsx");
        assert.deepStrictEqual(result, { type: "xlsx", parser: "office" });
      });

      it("应识别大写扩展名 .PDF", () => {
        const result = detectType("FILE.PDF");
        assert.deepStrictEqual(result, { type: "pdf", parser: "pdf" });
      });

      it("应识别大写扩展名 .DOCX", () => {
        const result = detectType("FILE.DOCX");
        assert.deepStrictEqual(result, { type: "docx", parser: "office" });
      });

      it("应识别大写扩展名 .XLSX", () => {
        const result = detectType("FILE.XLSX");
        assert.deepStrictEqual(result, { type: "xlsx", parser: "office" });
      });

      it("应识别大写扩展名 .PPTX", () => {
        const result = detectType("FILE.PPTX");
        assert.deepStrictEqual(result, { type: "pptx", parser: "office" });
      });

      it("对 .txt 文件应返回 null", () => {
        assert.strictEqual(detectType("file.txt"), null);
      });

      it("对 .js 文件应返回 null", () => {
        assert.strictEqual(detectType("script.js"), null);
      });

      it("对 .png 文件应返回 null", () => {
        assert.strictEqual(detectType("image.png"), null);
      });

      it("对空字符串应返回 null", () => {
        assert.strictEqual(detectType(""), null);
      });

      it("对无扩展名的文件应返回 null", () => {
        assert.strictEqual(detectType("Makefile"), null);
      });
    });

    describe("isSupported()", () => {
      it("对 .pdf 应返回 true", () => {
        assert.strictEqual(isSupported("doc.pdf"), true);
      });

      it("对 .docx 应返回 true", () => {
        assert.strictEqual(isSupported("doc.docx"), true);
      });

      it("对 .txt 应返回 false", () => {
        assert.strictEqual(isSupported("doc.txt"), false);
      });

      it("对无扩展名应返回 false", () => {
        assert.strictEqual(isSupported("README"), false);
      });
    });

    describe("getSupportedExtensions()", () => {
      it("应返回包含 4 个扩展名的数组", () => {
        const exts = getSupportedExtensions();
        assert.strictEqual(exts.length, 4);
        assert.ok(exts.includes(".pdf"));
        assert.ok(exts.includes(".docx"));
        assert.ok(exts.includes(".xlsx"));
        assert.ok(exts.includes(".pptx"));
      });

      it("每次调用应返回新数组（非同一引用）", () => {
        const a = getSupportedExtensions();
        const b = getSupportedExtensions();
        assert.notStrictEqual(a, b);
        assert.deepStrictEqual(a, b);
      });
    });

    describe("getTypeLabel()", () => {
      it('pdf → "PDF"', () => {
        assert.strictEqual(getTypeLabel("pdf"), "PDF");
      });

      it('docx → "Word"', () => {
        assert.strictEqual(getTypeLabel("docx"), "Word");
      });

      it('xlsx → "Excel"', () => {
        assert.strictEqual(getTypeLabel("xlsx"), "Excel");
      });

      it('pptx → "PowerPoint"', () => {
        assert.strictEqual(getTypeLabel("pptx"), "PowerPoint");
      });

      it("未知类型应返回原名（fallback）", () => {
        assert.strictEqual(getTypeLabel("unknown"), "unknown");
      });
    });
  });

  // ===========================================================================
  // 测试组 2: 模块接口验证
  // ===========================================================================

  describe("模块接口验证", () => {
    it("name 应为 'document'", () => {
      assert.strictEqual(docModule.name, "document");
    });

    it("toolGroupId 应为 'document_processing'", () => {
      assert.strictEqual(docModule.toolGroupId, "document_processing");
    });

    it("toolGroupDescription 应为非空字符串", () => {
      assert.strictEqual(typeof docModule.toolGroupDescription, "string");
      assert.ok(docModule.toolGroupDescription.length > 0);
    });

    it("toolGroupDescription 应提及支持的格式", () => {
      assert.ok(docModule.toolGroupDescription.includes(".pdf"));
    });

    it("init 应为函数", () => {
      assert.strictEqual(typeof docModule.init, "function");
    });

    it("executeToolCall 应为函数", () => {
      assert.strictEqual(typeof docModule.executeToolCall, "function");
    });

    it("shutdown 应为函数", () => {
      assert.strictEqual(typeof docModule.shutdown, "function");
    });

    it("getToolDefinitions 应为函数", () => {
      assert.strictEqual(typeof docModule.getToolDefinitions, "function");
    });
  });

  // ===========================================================================
  // 测试组 3: 工具定义结构
  // ===========================================================================

  describe("工具定义结构", () => {
    let tools;

    before(() => {
      tools = docModule.getToolDefinitions();
    });

    it("应返回包含 3 个工具的数组", () => {
      assert.strictEqual(tools.length, 3);
    });

    // -- 通用结构验证 --
    for (const idx of [0, 1, 2]) {
      it(`工具[${idx}] type 应为 "function"`, () => {
        assert.strictEqual(tools[idx].type, "function");
      });

      it(`工具[${idx}] function.name 应为非空字符串`, () => {
        assert.strictEqual(typeof tools[idx].function.name, "string");
        assert.ok(tools[idx].function.name.length > 0);
      });

      it(`工具[${idx}] function.description 应为非空字符串`, () => {
        assert.strictEqual(typeof tools[idx].function.description, "string");
        assert.ok(tools[idx].function.description.length > 0);
      });

      it(`工具[${idx}] function.parameters 应为 { type: "object" }`, () => {
        assert.strictEqual(tools[idx].function.parameters.type, "object");
      });

      it(`工具[${idx}] function.parameters.required 应为数组`, () => {
        assert.ok(Array.isArray(tools[idx].function.parameters.required));
      });
    }

    // -- document_read 专用 --
    describe("document_read", () => {
      let tool;
      before(() => {
        tool = tools.find((t) => t.function.name === "document_read");
      });

      it("应存在", () => {
        assert.ok(tool);
      });

      it("required 应为 ['path']", () => {
        assert.deepStrictEqual(tool.function.parameters.required, ["path"]);
      });

      it("properties 应含 path/format，不应含 pages/sheet/slides", () => {
        const props = tool.function.parameters.properties;
        assert.ok("path" in props);
        assert.ok("format" in props);
        assert.ok(!("pages" in props));
        assert.ok(!("sheet" in props));
        assert.ok(!("slides" in props));
      });

      it("format 应有 enum 约束", () => {
        assert.deepStrictEqual(
          tool.function.parameters.properties.format.enum,
          ["text", "markdown"],
        );
      });
    });

    // -- document_info 专用 --
    describe("document_info", () => {
      let tool;
      before(() => {
        tool = tools.find((t) => t.function.name === "document_info");
      });

      it("应存在", () => {
        assert.ok(tool);
      });

      it("required 应为 ['path']", () => {
        assert.deepStrictEqual(tool.function.parameters.required, ["path"]);
      });

      it("properties 应含 path", () => {
        assert.ok("path" in tool.function.parameters.properties);
      });
    });

    // -- document_search 专用 --
    describe("document_search", () => {
      let tool;
      before(() => {
        tool = tools.find((t) => t.function.name === "document_search");
      });

      it("应存在", () => {
        assert.ok(tool);
      });

      it("required 应为 ['path', 'keyword']", () => {
        assert.deepStrictEqual(tool.function.parameters.required, [
          "path",
          "keyword",
        ]);
      });

      it("properties 应含 path/keyword/caseSensitive/contextLines", () => {
        const props = tool.function.parameters.properties;
        assert.ok("path" in props);
        assert.ok("keyword" in props);
        assert.ok("caseSensitive" in props);
        assert.ok("contextLines" in props);
      });
    });
  });

  // ===========================================================================
  // 测试组 4: DocumentReader 单元测试
  // ===========================================================================

  describe("DocumentReader 单元测试", () => {
    // -- 共享 setup --
    let tempDir;
    let pathResolver;
    let permissionManager;

    /** @type {InstanceType<typeof DocumentReaderClass>} */
    let reader;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "doc-test-"));
      pathResolver = makeMockPathResolver(tempDir);
      permissionManager = makeMockPermissionManager(true);

      reader = new DocumentReaderClass({
        log: makeTestLogger("DocReader"),
        pathResolver,
        permissionManager,
      });
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    // ---------------------------------------------------------------------
    // read() — 错误路径
    // ---------------------------------------------------------------------

    describe("read() — 错误路径", () => {
      it("pathResolver 抛 agent_id_required → path_resolve_failed", async () => {
        pathResolver.resolvePath.mock.mockImplementation(() => {
          throw new Error("agent_id_required");
        });
        const result = await reader.read({}, { path: "test.pdf" });
        assert.strictEqual(result.error, "path_resolve_failed");
        assert.ok(result.message.includes("agent_id_required"));
      });

      it("pathResolver 抛 forbidden_path_segment → forbidden_path_segment", async () => {
        pathResolver.resolvePath.mock.mockImplementation(() => {
          throw new Error("forbidden_path_segment");
        });
        const result = await reader.read(
          { agent: { id: "agent-1" } },
          { path: "../outside.pdf" },
        );
        assert.strictEqual(result.error, "forbidden_path_segment");
      });

      it("external 路径未授权读取 → access_denied", async () => {
        const externalPath = join(tempDir, "external.pdf");
        await writeFile(externalPath, "dummy");
        pathResolver.resolvePath.mock.mockImplementation(async () => ({
          scope: "external",
          absolutePath: externalPath,
          relativePath: null,
          orgId: "org-1",
        }));
        permissionManager.checkReadPermission.mock.mockImplementation(async () => ({
          allowed: false,
        }));

        const result = await reader.read(
          { agent: { id: "agent-1" } },
          { path: externalPath },
        );
        assert.strictEqual(result.error, "access_denied");
        assert.ok(result.message.includes("没有权限读取外部文档"));
      });

      it("不支持格式 (.txt) → unsupported_format", async () => {
        await writeFile(join(tempDir, "notes.txt"), "hello");
        const result = await reader.read(
          { agent: { id: "agent-1" } },
          { path: "notes.txt" },
        );
        assert.strictEqual(result.error, "unsupported_format");
        assert.ok(result.message.includes(".pdf"));
      });

      it("文件不存在 (ENOENT) → file_not_found", async () => {
        // 不创建文件，stat 会抛 ENOENT
        const result = await reader.read(
          { agent: { id: "agent-1" } },
          { path: "nonexistent.pdf" },
        );
        assert.strictEqual(result.error, "file_not_found");
      });

      it("文件超过 50MB 上限 → file_too_large", async () => {
        const filePath = join(tempDir, "large.pdf");
        const handle = await open(filePath, "w");
        await handle.truncate(50 * 1024 * 1024 + 1);
        await handle.close();

        const result = await reader.read(
          { agent: { id: "agent-1" } },
          { path: "large.pdf" },
        );
        assert.strictEqual(result.error, "file_too_large");
        assert.ok(result.message.includes("50.0 MB"));
      });
    });

    // ---------------------------------------------------------------------
    // read() — 成功路径
    // ---------------------------------------------------------------------

    describe("read() — 成功路径", () => {
      it("PDF 读取成功 → ok: true + content + metadata", async () => {
        await writeFile(join(tempDir, "report.pdf"), "dummy");

        const result = await reader.read(
          { agent: { id: "agent-1" } },
          { path: "report.pdf" },
        );

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.content, "mock PDF content");
        assert.deepStrictEqual(result.metadata, {
          type: "pdf",
          parser: "pdf",
        });
      });

      it("PDF 内容超过 200000 字符 → 截断并标记 truncated", async () => {
        await writeFile(join(tempDir, "long.pdf"), "dummy");
        const longContent = "x".repeat(200100);
        parsePdfImpl = () =>
          Promise.resolve({
            ok: true,
            content: longContent,
            metadata: { type: "pdf", parser: "pdf" },
          });

        const result = await reader.read(
          { agent: { id: "agent-1" } },
          { path: "long.pdf" },
        );

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.content.length, 200000);
        assert.strictEqual(result.metadata.truncated, true);
        assert.strictEqual(result.metadata.totalChars, 200000);
        assert.ok(result.metadata.note.includes("200000"));
      });

      it("external 授权只读 PDF → ok: true + content + metadata", async () => {
        const externalPath = join(tempDir, "external.pdf");
        await writeFile(externalPath, "dummy");
        pathResolver.resolvePath.mock.mockImplementation(async () => ({
          scope: "external",
          absolutePath: externalPath,
          relativePath: null,
          orgId: "org-1",
        }));

        const result = await reader.read(
          { agent: { id: "agent-1" } },
          { path: externalPath },
        );

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.content, "mock PDF content");
        assert.deepStrictEqual(result.metadata, {
          type: "pdf",
          parser: "pdf",
        });
        assert.strictEqual(permissionManager.checkReadPermission.mock.callCount(), 1);
      });

      it("Office (docx) 读取成功 → ok: true + content + metadata", async () => {
        await writeFile(join(tempDir, "doc.docx"), "dummy");

        const result = await reader.read(
          { agent: { id: "agent-1" } },
          { path: "doc.docx" },
        );

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.content, "mock Office content");
        assert.deepStrictEqual(result.metadata, {
          type: "docx",
          parser: "office",
          format: "text",
        });
      });

      it("Office 读取支持 markdown 格式", async () => {
        await writeFile(join(tempDir, "doc.docx"), "dummy");

        const result = await reader.read(
          { agent: { id: "agent-1" } },
          { path: "doc.docx", format: "markdown" },
        );

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.metadata.format, "markdown");
      });

      it("PDF 解析器返回错误 → error: pdf_parse_error", async () => {
        // 真实 parsePdf 内部 catch 异常后返回 error 对象，而非向上抛
        await writeFile(join(tempDir, "broken.pdf"), "dummy");
        parsePdfImpl = () =>
          Promise.resolve({
            error: "pdf_parse_error",
            message: "PDF 解析失败: corrupt PDF",
          });

        const result = await reader.read(
          { agent: { id: "agent-1" } },
          { path: "broken.pdf" },
        );

        assert.strictEqual(result.error, "pdf_parse_error");
        assert.ok(result.message.includes("corrupt PDF"));
      });

      it("Office 解析器返回错误 → error: office_parse_error", async () => {
        await writeFile(join(tempDir, "broken.docx"), "dummy");
        parseOfficeImpl = () =>
          Promise.resolve({
            error: "office_parse_error",
            message: "Office 文档解析失败: corrupt docx",
          });

        const result = await reader.read(
          { agent: { id: "agent-1" } },
          { path: "broken.docx" },
        );

        assert.strictEqual(result.error, "office_parse_error");
        assert.ok(result.message.includes("corrupt docx"));
      });
    });

    // ---------------------------------------------------------------------
    // info()
    // ---------------------------------------------------------------------

    describe("info()", () => {
      it("pathResolver 抛 agent_id_required → path_resolve_failed", async () => {
        pathResolver.resolvePath.mock.mockImplementation(() => {
          throw new Error("agent_id_required");
        });
        const result = await reader.info({}, { path: "test.pdf" });
        assert.strictEqual(result.error, "path_resolve_failed");
        assert.ok(result.message.includes("agent_id_required"));
      });

      it("不支持格式 → unsupported_format", async () => {
        const result = await reader.info(
          { agent: { id: "agent-1" } },
          { path: "file.txt" },
        );
        assert.strictEqual(result.error, "unsupported_format");
      });

      it("文件不存在 → file_not_found", async () => {
        const result = await reader.info(
          { agent: { id: "agent-1" } },
          { path: "missing.pdf" },
        );
        assert.strictEqual(result.error, "file_not_found");
      });

      it("PDF info 成功 → ok + metadata", async () => {
        await writeFile(join(tempDir, "info.pdf"), "A".repeat(1024));

        const result = await reader.info(
          { agent: { id: "agent-1" } },
          { path: "info.pdf" },
        );

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.metadata.type, "pdf");
        assert.strictEqual(result.metadata.size, 1024);
        assert.strictEqual(typeof result.metadata.sizeFormatted, "string");
        assert.strictEqual(result.metadata.hasText, true);
        assert.strictEqual(result.metadata.charCount, 16);
      });

      it("external 授权只读 info → ok + metadata", async () => {
        const externalPath = join(tempDir, "external-info.pdf");
        await writeFile(externalPath, "A".repeat(64));
        pathResolver.resolvePath.mock.mockImplementation(async () => ({
          scope: "external",
          absolutePath: externalPath,
          relativePath: null,
          orgId: "org-1",
        }));

        const result = await reader.info(
          { agent: { id: "agent-1" } },
          { path: externalPath },
        );

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.metadata.type, "pdf");
        assert.strictEqual(result.metadata.size, 64);
        assert.strictEqual(permissionManager.checkReadPermission.mock.callCount(), 1);
      });

      it("external 未授权 info → access_denied", async () => {
        const externalPath = join(tempDir, "external-denied-info.pdf");
        await writeFile(externalPath, "A".repeat(64));
        pathResolver.resolvePath.mock.mockImplementation(async () => ({
          scope: "external",
          absolutePath: externalPath,
          relativePath: null,
          orgId: "org-1",
        }));
        permissionManager.checkReadPermission.mock.mockImplementation(async () => ({
          allowed: false,
        }));

        const result = await reader.info(
          { agent: { id: "agent-1" } },
          { path: externalPath },
        );

        assert.strictEqual(result.error, "access_denied");
        assert.ok(result.message.includes("没有权限读取外部文档"));
        assert.strictEqual(permissionManager.checkReadPermission.mock.callCount(), 1);
      });

      it("Office info 成功 → ok + metadata", async () => {
        await writeFile(join(tempDir, "info.docx"), "dummy");

        const result = await reader.info(
          { agent: { id: "agent-1" } },
          { path: "info.docx" },
        );

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.metadata.type, "docx");
        assert.strictEqual(result.metadata.hasText, true);
        assert.strictEqual(result.metadata.charCount, 17);
      });

      it("Parser 失败但仍返回 ok（stat 元数据正常）", async () => {
        // 真实 getPdfMetadata 内部 catch 异常后返回 error 对象
        await writeFile(join(tempDir, "info.pdf"), "data");
        getPdfMetadataImpl = () =>
          Promise.resolve({
            error: "pdf_parse_error",
            message: "获取 PDF 元数据失败: metadata parse failed",
          });

        const result = await reader.info(
          { agent: { id: "agent-1" } },
          { path: "info.pdf" },
        );

        // stat 成功 → ok: true，但 parser 元数据未合并
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.metadata.type, "pdf");
        assert.strictEqual(result.metadata.size, 4);
        // hasText 来自 parser metadata，parser 失败故不应有该字段
        assert.strictEqual(result.metadata.hasText, undefined);
      });
    });

    // ---------------------------------------------------------------------
    // search()
    // ---------------------------------------------------------------------

    describe("search()", () => {
      /**
       * 为 search 测试准备文件并设置 mock 内容。
       * @param {string} relPath - 相对路径
       * @param {string} content - 文档文本内容
       */
      async function prepareSearchDoc(relPath, content) {
        await writeFile(join(tempDir, relPath), "dummy");
        const isPdf = relPath.endsWith(".pdf");
        parsePdfImpl = ({ filePath }) =>
          Promise.resolve({
            ok: true,
            content,
            metadata: { type: isPdf ? "pdf" : "docx", parser: isPdf ? "pdf" : "office" },
          });
        parseOfficeImpl = ({ filePath, type, format }) =>
          Promise.resolve({
            ok: true,
            content,
            metadata: { type, parser: "office", format: format || "text" },
          });
      }

      it("关键字匹配（不区分大小写，默认）", async () => {
        await prepareSearchDoc(
          "doc.pdf",
          "line one\nline TWO keyword here\nline three\nline four",
        );

        const result = await reader.search(
          { agent: { id: "agent-1" } },
          { path: "doc.pdf", keyword: "keyword" },
        );

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.totalMatches, 1);
        assert.strictEqual(result.matches[0].line, 2);
        assert.ok(result.matches[0].context.length >= 1);
      });

      it("关键字未找到 → totalMatches: 0", async () => {
        await prepareSearchDoc("doc.pdf", "no match here\nnothing");

        const result = await reader.search(
          { agent: { id: "agent-1" } },
          { path: "doc.pdf", keyword: "xyz" },
        );

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.totalMatches, 0);
        assert.deepStrictEqual(result.matches, []);
      });

      it("caseSensitive: true → 仅匹配精确大小写", async () => {
        await prepareSearchDoc("doc.pdf", "Apple\napple\nAPPLE");

        const result = await reader.search(
          { agent: { id: "agent-1" } },
          { path: "doc.pdf", keyword: "apple", caseSensitive: true },
        );

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.totalMatches, 1);
        assert.strictEqual(result.matches[0].line, 2);
      });

      it("contextLines = 0 → 仅匹配行本身", async () => {
        await prepareSearchDoc(
          "doc.pdf",
          "line one\nline two target here\nline three\nline four\nline five",
        );

        const result = await reader.search(
          { agent: { id: "agent-1" } },
          { path: "doc.pdf", keyword: "target", contextLines: 0 },
        );

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.matches[0].context.length, 1);
      });

      it("contextLines = 5 → 上下文行数正确", async () => {
        await prepareSearchDoc(
          "doc.pdf",
          "line 1\nline 2\nline 3 target\nline 4\nline 5",
        );

        const result = await reader.search(
          { agent: { id: "agent-1" } },
          { path: "doc.pdf", keyword: "target", contextLines: 5 },
        );

        assert.strictEqual(result.ok, true);
        // 总共 5 行，全部应在 context 中
        assert.strictEqual(result.matches[0].context.length, 5);
      });

      it("多个匹配时返回所有匹配行", async () => {
        await prepareSearchDoc(
          "doc.pdf",
          "target here\nmiddle\nanother target there\nend",
        );

        const result = await reader.search(
          { agent: { id: "agent-1" } },
          { path: "doc.pdf", keyword: "target" },
        );

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.totalMatches, 2);
        assert.strictEqual(result.matches[0].line, 1);
        assert.strictEqual(result.matches[1].line, 3);
      });

      it("external 授权只读 search → ok + matches", async () => {
        const externalPath = join(tempDir, "external-search.pdf");
        await writeFile(externalPath, "dummy");
        parsePdfImpl = ({ filePath }) =>
          Promise.resolve({
            ok: true,
            content: "alpha\nexternal target\nomega",
            metadata: { type: "pdf", parser: "pdf" },
          });
        pathResolver.resolvePath.mock.mockImplementation(async () => ({
          scope: "external",
          absolutePath: externalPath,
          relativePath: null,
          orgId: "org-1",
        }));

        const result = await reader.search(
          { agent: { id: "agent-1" } },
          { path: externalPath, keyword: "target" },
        );

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.totalMatches, 1);
        assert.strictEqual(result.matches[0].line, 2);
        assert.strictEqual(permissionManager.checkReadPermission.mock.callCount(), 1);
      });

      it("external 未授权 search → access_denied", async () => {
        const externalPath = join(tempDir, "external-denied-search.pdf");
        await writeFile(externalPath, "dummy");
        parsePdfImpl = ({ filePath }) =>
          Promise.resolve({
            ok: true,
            content: "alpha\nexternal target\nomega",
            metadata: { type: "pdf", parser: "pdf" },
          });
        pathResolver.resolvePath.mock.mockImplementation(async () => ({
          scope: "external",
          absolutePath: externalPath,
          relativePath: null,
          orgId: "org-1",
        }));
        permissionManager.checkReadPermission.mock.mockImplementation(async () => ({
          allowed: false,
        }));

        const result = await reader.search(
          { agent: { id: "agent-1" } },
          { path: externalPath, keyword: "target" },
        );

        assert.strictEqual(result.error, "access_denied");
        assert.ok(result.message.includes("没有权限读取外部文档"));
        assert.strictEqual(permissionManager.checkReadPermission.mock.callCount(), 1);
      });
    });
  });

  // ===========================================================================
  // 测试组 5: 模块集成测试 (executeToolCall)
  // ===========================================================================

  describe("模块集成测试 (executeToolCall)", () => {
    // 前置条件：registry 全局单例，按顺序编排

    describe("提供前 — module_not_ready", () => {
      // 此时 docModule 已 declared 但未 provide，_reader 为 null

      it("document_read → module_not_ready", async () => {
        const result = await docModule.executeToolCall(
          { agent: { id: "agent-1" } },
          "document_read",
          { path: "test.pdf" },
        );
        assert.strictEqual(result.error, "module_not_ready");
      });

      it("document_info → module_not_ready", async () => {
        const result = await docModule.executeToolCall(
          { agent: { id: "agent-1" } },
          "document_info",
          { path: "test.pdf" },
        );
        assert.strictEqual(result.error, "module_not_ready");
      });

      it("document_search → module_not_ready", async () => {
        const result = await docModule.executeToolCall(
          { agent: { id: "agent-1" } },
          "document_search",
          { path: "test.pdf", keyword: "test" },
        );
        assert.strictEqual(result.error, "module_not_ready");
      });

      it("unknown_tool → module_not_ready（_reader 先检查）", async () => {
        // executeToolCall 先检查 _reader，再 dispatch toolName
        const result = await docModule.executeToolCall(
          { agent: { id: "agent-1" } },
          "nonexistent_tool",
          {},
        );
        assert.strictEqual(result.error, "module_not_ready");
      });
    });

    describe("提供后 — 正常调用", () => {
      let tempDir;
      let resolveWorkspacePath;

      before(async () => {
        tempDir = await mkdtemp(join(tmpdir(), "doc-int-"));
        sharedPathResolver = makeMockPathResolver(tempDir);
        sharedPermissionManager = makeMockPermissionManager(true);
        resolveWorkspacePath = async (_ctx, rawPath) => ({
          scope: "workspace",
          absolutePath: join(tempDir, rawPath),
          relativePath: rawPath,
          orgId: "org-1",
        });

        await registry.provide({
          logRoot: testLoggerRoot,
          workspaceFileAccessService: {
            pathResolver: sharedPathResolver,
            externalPermissionManager: sharedPermissionManager,
          },
        });

        // 现在 _reader 已初始化
      });

      after(async () => {
        await rm(tempDir, { recursive: true, force: true });
      });

      beforeEach(() => {
        mockParsePdf.mock.resetCalls();
        mockGetPdfMetadata.mock.resetCalls();
        mockParseOfficeFn.mock.resetCalls();
        mockGetOfficeMetadata.mock.resetCalls();

        sharedPathResolver.resolvePath.mock.resetCalls();
        sharedPathResolver.resolvePath.mock.mockImplementation(resolveWorkspacePath);
        sharedPermissionManager.checkReadPermission.mock.resetCalls();
        sharedPermissionManager.checkReadPermission.mock.mockImplementation(async () => ({ allowed: true }));

        parsePdfImpl = ({ filePath }) =>
          Promise.resolve({
            ok: true,
            content: "mock PDF content",
            metadata: { type: "pdf", parser: "pdf" },
          });
        getPdfMetadataImpl = ({ filePath }) =>
          Promise.resolve({
            ok: true,
            metadata: { type: "pdf", hasText: true, charCount: 16 },
          });
        parseOfficeImpl = ({ filePath, type, format }) =>
          Promise.resolve({
            ok: true,
            content: "mock Office content",
            metadata: { type, parser: "office", format: format || "text" },
          });
        getOfficeMetadataImpl = ({ filePath, type }) =>
          Promise.resolve({
            ok: true,
            metadata: { type, hasText: true, charCount: 17 },
          });
      });

      it("document_read 成功 → ok: true", async () => {
        await writeFile(join(tempDir, "readme.pdf"), "dummy");

        const result = await docModule.executeToolCall(
          { agent: { id: "agent-1" } },
          "document_read",
          { path: "readme.pdf" },
        );

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.content, "mock PDF content");
      });

      it("document_info 成功 → ok: true", async () => {
        await writeFile(join(tempDir, "info.pdf"), "12345");

        const result = await docModule.executeToolCall(
          { agent: { id: "agent-1" } },
          "document_info",
          { path: "info.pdf" },
        );

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.metadata.type, "pdf");
        assert.strictEqual(result.metadata.size, 5);
      });

      it("document_search 成功 → ok: true", async () => {
        await writeFile(join(tempDir, "search.pdf"), "dummy");
        parsePdfImpl = ({ filePath }) =>
          Promise.resolve({
            ok: true,
            content: "line one\nsearch term\nline three",
            metadata: { type: "pdf", parser: "pdf" },
          });

        const result = await docModule.executeToolCall(
          { agent: { id: "agent-1" } },
          "document_search",
          { path: "search.pdf", keyword: "search term" },
        );

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.totalMatches, 1);
        assert.strictEqual(result.matches[0].line, 2);
      });

      it("document_read 外部授权只读 → ok: true", async () => {
        const externalPath = join(tempDir, "external.pdf");
        await writeFile(externalPath, "dummy");
        sharedPathResolver.resolvePath.mock.mockImplementation(async () => ({
          scope: "external",
          absolutePath: externalPath,
          relativePath: null,
          orgId: "org-1",
        }));

        const result = await docModule.executeToolCall(
          { agent: { id: "agent-1" } },
          "document_read",
          { path: externalPath },
        );

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.content, "mock PDF content");
        assert.strictEqual(sharedPermissionManager.checkReadPermission.mock.callCount(), 1);
      });

      it("document_read 外部未授权 → access_denied", async () => {
        const externalPath = join(tempDir, "external-denied.pdf");
        await writeFile(externalPath, "dummy");
        sharedPathResolver.resolvePath.mock.mockImplementation(async () => ({
          scope: "external",
          absolutePath: externalPath,
          relativePath: null,
          orgId: "org-1",
        }));
        sharedPermissionManager.checkReadPermission.mock.mockImplementation(async () => ({
          allowed: false,
        }));

        const result = await docModule.executeToolCall(
          { agent: { id: "agent-1" } },
          "document_read",
          { path: externalPath },
        );

        assert.strictEqual(result.error, "access_denied");
        assert.ok(result.message.includes("没有权限读取外部文档"));
      });

      it("unknown_tool → unknown_tool", async () => {
        const result = await docModule.executeToolCall(
          { agent: { id: "agent-1" } },
          "made_up_tool",
          {},
        );
        assert.strictEqual(result.error, "unknown_tool");
      });

      it("缺少 path 参数 → missing_parameter", async () => {
        const result = await docModule.executeToolCall(
          { agent: { id: "agent-1" } },
          "document_read",
          {},
        );
        assert.strictEqual(result.error, "missing_parameter");
        assert.ok(result.message.includes("path"));
      });

      it("缺少 keyword 参数 → missing_parameter", async () => {
        const result = await docModule.executeToolCall(
          { agent: { id: "agent-1" } },
          "document_search",
          { path: "test.pdf" },
        );
        assert.strictEqual(result.error, "missing_parameter");
        assert.ok(result.message.includes("keyword"));
      });
    });
  });

  // ===========================================================================
  // 测试组 6: 错误结构一致性
  // ===========================================================================

  describe("错误结构一致性", () => {
    let tempDir;

    before(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "doc-err-"));

      // 如果模块尚未初始化（例如单独运行本组测试），则创建共享依赖并初始化。
      if (!sharedPathResolver) {
        sharedPathResolver = makeMockPathResolver(tempDir);
        sharedPermissionManager = makeMockPermissionManager(true);
        await registry.provide({
          logRoot: testLoggerRoot,
          workspaceFileAccessService: {
            pathResolver: sharedPathResolver,
            externalPermissionManager: sharedPermissionManager,
          },
        });
      } else {
        // 已初始化时只能原地更新 mock 实现，不能替换 _reader 持有的对象引用。
        sharedPathResolver.resolvePath.mock.resetCalls();
        sharedPathResolver.resolvePath.mock.mockImplementation(async (_ctx, rawPath) => ({
          scope: "workspace",
          absolutePath: join(tempDir, rawPath),
          relativePath: rawPath,
          orgId: "org-1",
        }));
        sharedPermissionManager.checkReadPermission.mock.resetCalls();
        sharedPermissionManager.checkReadPermission.mock.mockImplementation(async () => ({
          allowed: true,
        }));
      }
    });

    after(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("错误返回应含 error: string + message: string", async () => {
      // 用 unsupported_format 做样本
      const result = await docModule.executeToolCall(
        { agent: { id: "agent-1" } },
        "document_read",
        { path: "file.txt" },
      );

      assert.strictEqual(typeof result.error, "string");
      assert.ok(result.error.length > 0);
      assert.strictEqual(typeof result.message, "string");
      assert.ok(result.message.length > 0);
      // 确保不含 ok: true
      assert.strictEqual(result.ok, undefined);
    });

    it("成功返回应含 ok: true 且无 error 字段", async () => {
      await writeFile(join(tempDir, "ok.pdf"), "dummy");

      const result = await docModule.executeToolCall(
        { agent: { id: "agent-1" } },
        "document_read",
        { path: "ok.pdf" },
      );

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.error, undefined);
    });

    it("missing_parameter 的 message 应含参数名", async () => {
      const result = await docModule.executeToolCall(
        { agent: { id: "agent-1" } },
        "document_search",
        { path: "test.pdf" },
      );

      assert.strictEqual(result.error, "missing_parameter");
      assert.ok(result.message.includes("keyword"));
    });

    it("unsupported_format 的 message 应含支持的扩展列表", async () => {
      await writeFile(join(tempDir, "unsupported.txt"), "hello");

      const result = await docModule.executeToolCall(
        { agent: { id: "agent-1" } },
        "document_read",
        { path: "unsupported.txt" },
      );

      assert.strictEqual(result.error, "unsupported_format");
      const exts = getSupportedExtensions();
      for (const ext of exts) {
        assert.ok(result.message.includes(ext));
      }
    });
  });
});
