/**
 * OCR 服务 — 封装 @arcships/light-ocr 引擎，处理工作区图片识别。
 *
 * 通过 DI 注入 findWorkspaceIdForAgent，不依赖模块级全局变量。
 */

import path from "node:path";
import { execSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createEngine } from "@arcships/light-ocr";
import { getWorkspaceManager } from "../../src/platform/services/workspace/workspace_manager.js";

/** 支持识别的图片扩展名 */
const SUPPORTED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tiff", ".tif"];

/** 图片文件大小上限：50MB */
const MAX_FILE_SIZE = 50 * 1024 * 1024;

export class OcrService {
  /**
   * @param {object} options
   * @param {any} options.log - 日志对象
   * @param {(agentId: string) => string|null} options.findWorkspaceIdForAgent - 查找工作区ID
   */
  constructor({ log, findWorkspaceIdForAgent }) {
    this._log = log;
    this._findWorkspaceIdForAgent = findWorkspaceIdForAgent;
    /** @type {import("@arcships/light-ocr").OcrEngine|null} */
    this._engine = null;
    /** 是否已尝试过自动安装原生包 */
    this._installAttempted = false;
  }

  /**
   * 识别工作区内图片中的文字。
   * @param {any} ctx - 调用上下文（含 ctx.agent.id）
   * @param {object} args - 参数 { path }
   * @returns {Promise<object>}
   */
  async recognize(ctx, args) {
    const workspace = await this._resolveWorkspace(ctx);
    if (workspace.error) return workspace;

    const absPath = this._resolvePath(workspace, args.path);
    if (absPath.error) return absPath;

    const ext = path.extname(absPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      return {
        error: "unsupported_format",
        message: `不支持的图片格式（${ext}），支持: ${SUPPORTED_EXTENSIONS.join(", ")}`,
      };
    }

    const sizeCheck = await this._checkFileSize(absPath);
    if (sizeCheck.error) return sizeCheck;

    let imageBytes;
    try {
      imageBytes = await readFile(absPath);
    } catch (err) {
      return {
        error: "file_read_error",
        message: `无法读取图片文件: ${err.message}`,
      };
    }

    if (!this._engine) {
      const engineErr = await this._ensureEngine();
      if (engineErr) return engineErr;
    }

    let includeDiag = false;
    if (args.includeDiagnostics === true) {
      includeDiag = true;
    }

    try {
      const result = await this._engine.recognizeEncoded(
        new Uint8Array(imageBytes),
        { includeDiagnostics: includeDiag },
      );

      const imgW = result.imageWidth;
      const imgH = result.imageHeight;
      const rawLines = result.lines;
      const sortedLines = _sortReadingOrder(rawLines);

      // 格式化每一行（含排版位置信息）
      const lines = sortedLines.map((line, index) => {
        const box = line.box;
        const { x, y, width: lw, height: lh } = _bbox(box);

        return {
          index,
          text: line.text,
          confidence: _round4(line.confidence),
          // 包围框四角坐标（像素）
          box: {
            topLeft:     { x: box[0].x, y: box[0].y },
            topRight:    { x: box[1].x, y: box[1].y },
            bottomRight: { x: box[2].x, y: box[2].y },
            bottomLeft:  { x: box[3].x, y: box[3].y },
          },
          // 包围框轴对齐矩形（x, y, width, height）
          bbox: { x, y, width: lw, height: lh },
          // 包围框中心点
          center: { x: _round1(x + lw / 2), y: _round1(y + lh / 2) },
        };
      });

      // 排版聚合
      const paragraphs = _buildParagraphs(sortedLines);
      const columns = _detectColumns(sortedLines, imgW);
      const confidenceStats = _confidenceStats(sortedLines);
      const lineHeightStats = _lineHeightStats(sortedLines);
      const density = _pageDensity(sortedLines, imgW, imgH);
      const readingDirection = _inferDirection(sortedLines);

      const response = {
        ok: true,
        // 全文拼接（便于 LLM 直接使用）
        text: lines.map(l => l.text).join("\n"),
        lines,
        lineCount: lines.length,
        // 图片维度
        imageWidth: imgW,
        imageHeight: imgH,
        // 排版分析
        layout: {
          paragraphs,
          paragraphCount: paragraphs.length,
          columns,
          columnCount: columns.length,
          readingDirection,
        },
        // 统计信息
        stats: {
          confidence: confidenceStats,
          lineHeight: lineHeightStats,
          density,
        },
        // 引擎/模型信息
        engine: {
          modelBundleId: result.modelBundleId,
          coreVersion: this._engine.info.coreVersion,
          backend: this._engine.info.backend,
          executionProvider: this._engine.info.executionProvider,
        },
        // 耗时明细（微秒）
        timing: {
          us: result.timingUs,
          ms: {
            total:                _round1(result.timingUs.total / 1000),
            decode:               _round1(result.timingUs.decode / 1000),
            inputValidation:      _round1(result.timingUs.inputValidation / 1000),
            detectionPreprocess:  _round1(result.timingUs.detectionPreprocess / 1000),
            detectionInference:   _round1(result.timingUs.detectionInference / 1000),
            detectionPostprocess: _round1(result.timingUs.detectionPostprocess / 1000),
            detectionMerge:       _round1(result.timingUs.detectionMerge / 1000),
            cropAndSort:          _round1(result.timingUs.cropAndSort / 1000),
            recognitionPreprocess:  _round1(result.timingUs.recognitionPreprocess / 1000),
            recognitionInference:   _round1(result.timingUs.recognitionInference / 1000),
            recognitionPostprocess: _round1(result.timingUs.recognitionPostprocess / 1000),
          },
          phases: {
            detection:    _round1(result.timingUs.detectionPreprocess + result.timingUs.detectionInference + result.timingUs.detectionPostprocess + result.timingUs.detectionMerge),
            recognition:  _round1(result.timingUs.recognitionPreprocess + result.timingUs.recognitionInference + result.timingUs.recognitionPostprocess),
            overhead:     _round1(result.timingUs.decode + result.timingUs.inputValidation + result.timingUs.cropAndSort),
          },
        },
      };

      if (includeDiag && result.diagnostics) {
        const d = result.diagnostics;
        response.diagnostics = {
          detectedCandidates:      d.detectedCandidates,
          acceptedBoxes:           d.acceptedBoxes,
          rawDetectionBoxes:       d.rawDetectionBoxes,
          suppressedDuplicateBoxes: d.suppressedDuplicateBoxes,
          detectionInputWidth:     d.detectionInputWidth,
          detectionInputHeight:    d.detectionInputHeight,
          maxLiveDetectionPassBuffers: d.maxLiveDetectionPassBuffers,
          rejectedLines: (d.rejectedLines || []).map(rl => ({
            text:       rl.line.text,
            confidence: _round4(rl.line.confidence),
            reason:     rl.reason,
          })),
          rejectedCount: (d.rejectedLines || []).length,
          warnings: (d.warnings || []).map(w => ({
            code:    w.code,
            message: w.message,
          })),
          warningCount: (d.warnings || []).length,
          detectionPasses: (d.detectionPasses || []).map(dp => ({
            tileOrdinal:      dp.tileOrdinal,
            x:                dp.x,
            y:                dp.y,
            width:            dp.width,
            height:           dp.height,
            contourCandidates: dp.contourCandidates,
            rawCandidates:    dp.rawCandidates,
          })),
          recognitionBatchShapes: (d.recognitionBatchShapes || []).map(bs => ({
            batchSize: bs.batchSize,
            height:    bs.height,
            width:     bs.width,
            computeUnit: bs.computeUnit,
            modelId:   bs.modelId,
            shapeBucket: bs.shapeBucket,
          })),
        };
      }

      return response;
    } catch (err) {
      this._log.error("[OcrService] OCR 识别失败", {
        path: args.path,
        message: err.message,
        stack: err.stack,
      });
      return {
        error: "recognition_failed",
        message: `OCR 识别失败: ${err.message}`,
      };
    }
  }

  /**
   * 确保 OCR 引擎已初始化。首次创建失败时，若原因
   * 是缺少平台原生包（package_load_failed），则自动执行
   * npm install 安装对应平台包后重试一次。
   * @returns {Promise<{ error: string, message: string } | null>}
   */
  async _ensureEngine() {
    this._log.info("[OcrService] 正在创建 OCR 引擎（首次使用）…");

    try {
      this._engine = await createEngine();
    } catch (err) {
      // 只处理缺少平台原生包的情况
      const canInstall = err?.name === "OcrError"
        && err?.code === "package_load_failed"
        && typeof err?.message === "string"
        && err.message.startsWith("Unable to locate ");

      if (!canInstall || this._installAttempted) {
        this._log.error("[OcrService] OCR 引擎创建失败", {
          message: err.message,
          stack: err.stack,
        });
        return {
          error: "engine_init_failed",
          message: `OCR 引擎初始化失败: ${err.message}`,
        };
      }

      // 提取包名："Unable to locate @arcships/light-ocr-win32-x64"
      const pkgName = err.message.slice("Unable to locate ".length).trim();
      this._log.warn("[OcrService] 缺少平台原生包，尝试自动安装", { pkgName, platform: process.platform, arch: process.arch });
      this._installAttempted = true;

      try {
        execSync(`npm install --no-save ${pkgName}`, {
          stdio: "pipe",
          timeout: 120000,
        });
        this._log.info("[OcrService] 平台原生包安装成功，重试创建引擎", { pkgName });
      } catch (installErr) {
        this._log.error("[OcrService] 平台原生包自动安装失败", {
          pkgName,
          message: installErr.message,
          stderr: installErr.stderr?.toString?.() ?? "",
        });
        return {
          error: "engine_init_failed",
          message: `OCR 引擎初始化失败: 缺少平台原生包 ${pkgName}，自动安装失败 — ${installErr.message}`,
        };
      }

      try {
        this._engine = await createEngine();
      } catch (retryErr) {
        this._log.error("[OcrService] 安装后重试创建引擎仍失败", {
          pkgName,
          message: retryErr.message,
          stack: retryErr.stack,
        });
        return {
          error: "engine_init_failed",
          message: `OCR 引擎初始化失败: 已自动安装 ${pkgName}，但创建引擎仍失败 — ${retryErr.message}`,
        };
      }
    }

    this._log.info("[OcrService] OCR 引擎创建成功", {
      coreVersion: this._engine.info.coreVersion,
      backend: this._engine.info.backend,
      executionProvider: this._engine.info.executionProvider,
    });
    return null;
  }

  /**
   * 关闭 OCR 引擎，释放资源。
   */
  async close() {
    if (this._engine) {
      try {
        await this._engine.close();
        this._log.info("[OcrService] OCR 引擎已关闭");
      } catch (err) {
        this._log.error("[OcrService] OCR 引擎关闭失败", {
          message: err.message,
          stack: err.stack,
        });
      }
      this._engine = null;
    }
    this._installAttempted = false;
  }

  // ---- 内部方法 ----

  /**
   * 根据 ctx 解析 workspace 对象。
   * @param {any} ctx
   * @returns {Promise<import("../../src/platform/services/workspace/workspace.js").Workspace | { error: string, message: string }>}
   */
  async _resolveWorkspace(ctx) {
    const agentId = ctx?.agent?.id;
    if (!agentId) {
      return { error: "no_workspace", message: "无法获取智能体 ID" };
    }
    const wsId = this._findWorkspaceIdForAgent(agentId);
    if (!wsId) {
      return { error: "no_workspace", message: "该智能体没有关联的工作区" };
    }
    const wm = getWorkspaceManager();
    if (!wm) {
      return { error: "no_workspace", message: "工作区管理器未初始化" };
    }
    return await wm.getWorkspace(wsId);
  }

  /**
   * 通过 workspace 解析绝对路径。
   * @param {object} workspace - Workspace 实例
   * @param {string} relativePath - 工作区相对路径
   * @returns {string | { error: string, message: string }}
   */
  _resolvePath(workspace, relativePath) {
    try {
      return workspace.resolveAbsolutePath(relativePath);
    } catch (err) {
      return {
        error: "file_not_found",
        message: `路径无效或越权: ${relativePath}`,
      };
    }
  }

  /**
   * 检查文件大小是否在上限内。
   * @param {string} absPath
   * @returns {Promise<object>}
   */
  async _checkFileSize(absPath) {
    try {
      const fileStat = await stat(absPath);
      if (fileStat.size > MAX_FILE_SIZE) {
        return {
          error: "file_too_large",
          message: `图片过大（${this._formatBytes(fileStat.size)}），上限为 ${this._formatBytes(MAX_FILE_SIZE)}`,
        };
      }
      return {};
    } catch (err) {
      return {
        error: "file_not_found",
        message: `图片文件不存在: ${absPath}`,
      };
    }
  }

  /**
   * 格式化字节数为可读字符串。
   * @param {number} bytes
   * @returns {string}
   */
  _formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }
}

// ============================================================
// 排版分析辅助函数（纯函数）
// ============================================================

/**
 * 计算四边形四个角点的轴对齐包围矩形。
 */
function _bbox(box) {
  const xs = box.map(p => p.x);
  const ys = box.map(p => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width  = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  return { x, y, width, height };
}

/**
 * 阅读顺序排序：先 Y 轴（行），再 X 轴（列）。
 * 同一行允许 0.6 倍行高内的浮动。
 */
function _sortReadingOrder(lines) {
  if (lines.length === 0) return [];

  const heights = lines.map(l => _bbox(l.box).height).filter(h => h > 0);
  const avgH = heights.length > 0
    ? heights.reduce((a, b) => a + b, 0) / heights.length
    : 10;
  const yTolerance = avgH * 0.6;

  const indexed = lines.map((line, i) => ({
    ...line,
    _idx: i,
    _y: _bbox(line.box).y,
    _x: _bbox(line.box).x,
  }));

  // 按 Y 排序
  indexed.sort((a, b) => a._y - b._y);

  // 扫描分组：Y 差距小于 tolerance 的视为同一行，组内按 X 排序
  const rows = [];
  let currentRow = [indexed[0]];
  for (let i = 1; i < indexed.length; i++) {
    const prevY = currentRow[currentRow.length - 1]._y;
    if (Math.abs(indexed[i]._y - prevY) <= yTolerance) {
      currentRow.push(indexed[i]);
    } else {
      currentRow.sort((a, b) => a._x - b._x);
      rows.push(currentRow);
      currentRow = [indexed[i]];
    }
  }
  currentRow.sort((a, b) => a._x - b._x);
  rows.push(currentRow);

  const order = rows.flat().map(item => item._idx);
  return order.map(idx => lines[idx]);
}

/**
 * 段落检测：行间距大于 1.8 倍平均行高则视为段边界。
 */
function _buildParagraphs(lines) {
  if (lines.length === 0) return [];

  const withBox = lines.map(line => ({
    ...line,
    _bbox: _bbox(line.box),
  }));

  const heights = withBox.map(w => w._bbox.height).filter(h => h > 0);
  const avgH = heights.length > 0
    ? heights.reduce((a, b) => a + b, 0) / heights.length
    : 10;
  const gapThreshold = avgH * 1.8;

  const paragraphs = [];
  let paraStart = 0;
  let currentPara = [withBox[0]];

  for (let i = 1; i < withBox.length; i++) {
    const prevBottom = currentPara[currentPara.length - 1]._bbox.y
                     + currentPara[currentPara.length - 1]._bbox.height;
    const gap = withBox[i]._bbox.y - prevBottom;
    if (gap > gapThreshold) {
      paragraphs.push(_summarizeParagraph(currentPara, paraStart, i - 1));
      currentPara = [withBox[i]];
      paraStart = i;
    } else {
      currentPara.push(withBox[i]);
    }
  }
  paragraphs.push(_summarizeParagraph(currentPara, paraStart, withBox.length - 1));

  return paragraphs;
}

function _summarizeParagraph(lines, firstIndex, lastIndex) {
  const texts = lines.map(l => l.text);
  const boxes = lines.map(l => l._bbox);
  const xs = boxes.map(b => b.x);
  const ys = boxes.map(b => b.y);
  const rights  = boxes.map(b => b.x + b.width);
  const bottoms = boxes.map(b => b.y + b.height);

  return {
    text: texts.join(""),
    lineCount: lines.length,
    firstLineIndex: firstIndex,
    lastLineIndex: lastIndex,
    boundingBox: {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width:  Math.max(...rights)  - Math.min(...xs),
      height: Math.max(...bottoms) - Math.min(...ys),
    },
    averageLineHeight: _round1(
      boxes.reduce((s, b) => s + b.height, 0) / boxes.length,
    ),
  };
}

/**
 * 列检测：基于行包围框的 X 轴聚类。
 * 当行间 X 偏移超过 2× 平均行高时，认为进入了新列。
 */
function _detectColumns(lines, imageWidth) {
  if (lines.length === 0) return [];

  const withBox = lines.map(line => ({ ...line, _bbox: _bbox(line.box) }));
  const avgH = _lineHeightStats(lines).average;

  // 按 X 坐标分组
  const xSorted = [...withBox].sort((a, b) => a._bbox.x - b._bbox.x);
  const gapThreshold = Math.max(avgH * 2, imageWidth * 0.05);

  const columns = [];
  let currentCol = [xSorted[0]];

  for (let i = 1; i < xSorted.length; i++) {
    const prevRight = currentCol[currentCol.length - 1]._bbox.x
                    + currentCol[currentCol.length - 1]._bbox.width;
    const gap = xSorted[i]._bbox.x - prevRight;
    if (gap > gapThreshold) {
      columns.push(currentCol);
      currentCol = [xSorted[i]];
    } else {
      currentCol.push(xSorted[i]);
    }
  }
  columns.push(currentCol);

  return columns.map(col => {
    const xs  = col.map(l => l._bbox.x);
    const ys  = col.map(l => l._bbox.y);
    const ws  = col.map(l => l._bbox.width);
    const hs  = col.map(l => l._bbox.height);
    return {
      lineCount: col.length,
      boundingBox: {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width:  Math.max(...xs.map((x, i) => x + ws[i])) - Math.min(...xs),
        height: Math.max(...ys.map((y, i) => y + hs[i])) - Math.min(...ys),
      },
    };
  });
}

/**
 * 推理阅读方向（近似）。
 * 如果行的平均宽高比 > 3 且 列数 ≤ 1，大概率是横向文本。
 */
function _inferDirection(lines) {
  if (lines.length === 0) return "unknown";

  const ratios = lines.map(line => {
    const b = _bbox(line.box);
    return b.height > 0 ? b.width / b.height : 0;
  });

  const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const heights = lines.map(l => _bbox(l.box).height);
  const avgH = heights.reduce((a, b) => a + b, 0) / heights.length;

  // 宽高比大 + 行间距小 → 横向
  if (avgRatio > 3) return "horizontal";
  // 宽高比小 + 行高等 → 可能是竖向
  if (avgRatio < 1.5 && avgH > 0) return "vertical";
  return "horizontal";
}

// ---- 统计函数 ----

function _confidenceStats(lines) {
  if (lines.length === 0) return { average: 0, min: 0, max: 0 };
  const scores = lines.map(l => l.confidence);
  return {
    average: _round4(scores.reduce((a, b) => a + b, 0) / scores.length),
    min:     _round4(Math.min(...scores)),
    max:     _round4(Math.max(...scores)),
  };
}

function _lineHeightStats(lines) {
  if (lines.length === 0) return { average: 0, min: 0, max: 0 };
  const heights = lines.map(l => _bbox(l.box).height);
  return {
    average: _round1(heights.reduce((a, b) => a + b, 0) / heights.length),
    min:     _round1(Math.min(...heights)),
    max:     _round1(Math.max(...heights)),
  };
}

/**
 * 页面文字密度：文本包围框总面积 / 图片总面积。
 */
function _pageDensity(lines, imgW, imgH) {
  if (lines.length === 0 || imgW <= 0 || imgH <= 0) return 0;
  const totalTextArea = lines.reduce((sum, line) => {
    const b = _bbox(line.box);
    return sum + b.width * b.height;
  }, 0);
  return _round4(totalTextArea / (imgW * imgH));
}

// ---- 数值格式化 ----

function _round1(n) {
  return Math.round(n * 10) / 10;
}

function _round4(n) {
  return Math.round(n * 10000) / 10000;
}
