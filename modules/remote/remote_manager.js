/**
 * Remote Manager — SSH 连接管理和命令执行
 *
 * 职责：
 * - 管理每个 Agent 的 SSH 连接
 * - 将文件操作翻译为 SSH 命令
 * - 执行命令并返回结果
 */

import { Client } from 'ssh2';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

const MAX_OUTPUT_CHARS = 50000;

class RemoteManager {
  constructor(log, dataDir) {
    this.log = log;
    this.dataDir = dataDir;
    /** @type {Map<string, {client: Client, config: object, connected: boolean, lastUsed: number}>} */
    this._connections = new Map();
    this._connectionCounter = 0;
    /** @type {Map<string, {agentId: string, status: string, exitCode: number, outputFile: string|null, command: string, createdAt: number}>} */
    this._processes = new Map();
    this._processCounter = 0;

    /** @type {Set<Function>} 进程事件监听器（日志/启动/退出事件订阅） */
    this._processListeners = new Set();
  }

  /**
   * 订阅远程进程事件（'log' | 'started' | 'exit'），与本地 ProcessManager 语义一致。
   * 事件对象: { processId, agentId, pushEvents, type, text?, pid?, status?, exitCode?, signal?, error?, command?, args?, ts }
   * @param {(evt: object) => void} listener - 事件监听器
   * @returns {() => void} 取消订阅函数
   */
  onProcessEvent(listener) {
    if (typeof listener === 'function') {
      this._processListeners.add(listener);
    }
    return () => {
      this._processListeners.delete(listener);
    };
  }

  /**
   * 向所有监听器派发进程事件（逐个捕获异常，不阻断其他监听器）。
   * @param {object} evt - 事件对象
   * @private
   */
  _emitProcessEvent(evt) {
    for (const listener of this._processListeners) {
      try {
        listener(evt);
      } catch (err) {
        this.log.error('[Remote] 进程事件监听器执行失败', {
          processId: evt?.processId ?? null,
          type: evt?.type ?? null,
          error: err?.message ?? String(err),
          stack: err?.stack,
          name: err?.name
        });
      }
    }
  }

  /**
   * 获取或创建 Agent 的 SSH 连接
   * @param {string} agentId
   * @param {object} remoteConfig - { host, port, username, password, privateKey, passphrase }
   * @returns {Promise<Client>}
   */
  async getConnection(agentId, remoteConfig) {
    const existing = this._connections.get(agentId);
    if (existing && existing.connected) {
      existing.lastUsed = Date.now();
      return existing.client;
    }

    // 如果有旧连接，先清理
    if (existing) {
      try { existing.client.end(); } catch (_) { /* ignore */ }
      this._connections.delete(agentId);
    }

    return this._createConnection(agentId, remoteConfig);
  }

  /**
   * 创建新的 SSH 连接
   */
  _createConnection(agentId, remoteConfig) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const connId = ++this._connectionCounter;

      const entry = {
        client,
        config: remoteConfig,
        connected: false,
        lastUsed: Date.now(),
        connId,
      };

      this._connections.set(agentId, entry);

      const timeout = setTimeout(() => {
        client.end();
        reject(new Error(`SSH connection timeout (${remoteConfig.host}:${remoteConfig.port})`));
      }, 30000);

      client.on('ready', () => {
        clearTimeout(timeout);
        entry.connected = true;
        this.log.info(`[Remote] SSH 连接已建立`, { agentId, host: remoteConfig.host, connId });
        resolve(client);
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        entry.connected = false;
        this.log.error(`[Remote] SSH 连接错误`, { agentId, host: remoteConfig.host, error: err.message });
        reject(err);
      });

      client.on('close', () => {
        entry.connected = false;
        this.log.info(`[Remote] SSH 连接已关闭`, { agentId, connId });
      });

      const connectOpts = {
        host: remoteConfig.host,
        port: remoteConfig.port || 22,
        username: remoteConfig.username || 'root',
        readyTimeout: 30000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
      };

      if (remoteConfig.password) {
        connectOpts.password = remoteConfig.password;
      }
      if (remoteConfig.privateKey) {
        connectOpts.privateKey = remoteConfig.privateKey;
        if (remoteConfig.passphrase) {
          connectOpts.passphrase = remoteConfig.passphrase;
        }
      }

      client.connect(connectOpts);
    });
  }

  /**
   * 在远程执行命令
   * @param {string} agentId
   * @param {object} remoteConfig
   * @param {string} command
   * @param {object} [options]
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
   */
  async execCommand(agentId, remoteConfig, command, options = {}) {
    const client = await this.getConnection(agentId, remoteConfig);

    return new Promise((resolve, reject) => {
      const timeout = options.timeout || 30000;
      const timer = setTimeout(() => {
        reject(new Error(`Command timed out after ${timeout}ms: ${command.substring(0, 100)}`));
      }, timeout);

      client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data) => {
          const text = data.toString('utf8');
          if (stdout.length < MAX_OUTPUT_CHARS) {
            stdout += text;
          }
        });

        stream.stderr.on('data', (data) => {
          const text = data.toString('utf8');
          if (stderr.length < MAX_OUTPUT_CHARS) {
            stderr += text;
          }
        });

        stream.on('close', (exitCode) => {
          clearTimeout(timer);
          resolve({
            stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
            stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
            exitCode: exitCode ?? -1,
          });
        });

        stream.on('error', (streamErr) => {
          clearTimeout(timer);
          reject(streamErr);
        });
      });
    });
  }

  /**
   * 安全转义 Shell 参数（防止命令注入）
   */
  _escapeShellArg(arg) {
    // 使用单引号包裹，并转义内部的单引号
    return "'" + String(arg).replace(/'/g, "'\\''") + "'";
  }

  /**
   * 读取远程文件（整段/按行，供内部使用）
   * @param {string} agentId
   * @param {object} remoteConfig
   * @param {string} filePath - 远程文件路径
   * @param {object} [options]
   * @returns {Promise<{content: string, error?: string}>}
   */
  async readFile(agentId, remoteConfig, filePath, options = {}) {
    const escapedPath = this._escapeShellArg(filePath);

    let cmd;
    if (options.offset !== undefined && options.limit !== undefined) {
      // 从 offset 行开始读取 limit 行 (1-indexed)
      cmd = `tail -n +${options.offset} ${escapedPath} | head -n ${options.limit}`;
    } else if (options.limit !== undefined) {
      cmd = `head -n ${options.limit} ${escapedPath}`;
    } else if (options.offset !== undefined) {
      cmd = `tail -n +${options.offset} ${escapedPath}`;
    } else {
      cmd = `cat ${escapedPath}`;
    }

    try {
      const result = await this.execCommand(agentId, remoteConfig, cmd, { timeout: 15000 });
      if (result.exitCode !== 0 && result.stderr) {
        return { content: '', error: result.stderr.trim() || `exit code: ${result.exitCode}` };
      }
      return { content: result.stdout };
    } catch (err) {
      return { content: '', error: err.message };
    }
  }

  /**
   * 按行号范围读取远程文件（对齐 bigfile_service.readLines 语义）
   * @param {string} agentId
   * @param {object} remoteConfig
   * @param {string} filePath
   * @param {object} [options] - { start_line?, end_line? }
   * @returns {Promise<{ok: boolean, lines?: string[], start_line?: number, end_line?: number, total_lines?: number, error?: string, message?: string}>}
   */
  async readLines(agentId, remoteConfig, filePath, options = {}) {
    const escapedPath = this._escapeShellArg(filePath);
    try {
      // 获取总行数（wc -l；空文件返回 0，本地 split 语义对空文件为 1，这里补 0→1 以对齐）
      const wcResult = await this.execCommand(
        agentId, remoteConfig,
        `wc -l < ${escapedPath} 2>/dev/null; echo $?`,
        { timeout: 15000 }
      );
      const totalLinesRaw = parseInt((wcResult.stdout || '').trim().split('\n')[0], 10);
      const totalLines = Number.isFinite(totalLinesRaw) ? totalLinesRaw : 0;

      const startLine = Math.max(1, Number(options.start_line) || 1);
      const endLine = Math.min(totalLines, Number(options.end_line) || Math.max(500, startLine + 499));

      if (startLine > totalLines) {
        return { ok: true, lines: [], start_line: startLine, end_line: 0, total_lines: totalLines };
      }

      const readResult = await this.execCommand(
        agentId, remoteConfig,
        `sed -n '${startLine},${endLine}p' ${escapedPath}`,
        { timeout: 15000 }
      );

      const text = readResult.stdout;
      const lines = text.length > 0 ? text.split('\n') : [];
      // sed 输出的最后一行若有换行会多一个空元素，去掉
      if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) {
        lines.pop();
      }

      return {
        ok: true,
        lines,
        start_line: startLine,
        end_line: Math.min(endLine, totalLines),
        total_lines: totalLines,
      };
    } catch (err) {
      return { ok: false, error: 'read_failed', message: err.message };
    }
  }

  /**
   * 按字节偏移读取远程文件（对齐 bigfile_service.read 语义）
   * @param {string} agentId
   * @param {object} remoteConfig
   * @param {string} filePath
   * @param {object} [options] - { offset?, length? }（字节）
   * @returns {Promise<{ok: boolean, content?: string, start?: number, total?: number, read_length?: number, error?: string}>}
   */
  async readBytes(agentId, remoteConfig, filePath, options = {}) {
    const escapedPath = this._escapeShellArg(filePath);
    const offset = Number(options.offset) || 0;
    const length = Number(options.length) || 500;

    try {
      // 获取文件总大小（字节）
      const statResult = await this.execCommand(
        agentId, remoteConfig,
        `stat -c '%s' ${escapedPath} 2>/dev/null`,
        { timeout: 10000 }
      );
      const total = parseInt((statResult.stdout || '').trim(), 10);
      if (!Number.isFinite(total)) {
        return { ok: false, error: 'stat_error', message: `无法获取文件大小: ${statResult.stderr || statResult.stdout}` };
      }

      if (offset >= total) {
        return { ok: true, content: '', start: offset, total, read_length: 0, truncated: false };
      }

      // tail -c 读取（offset 为 0 时直接 head -c）
      const bytesToRead = Math.min(length, total - offset);
      const cmd = offset === 0
        ? `head -c ${bytesToRead} ${escapedPath}`
        : `tail -c +${offset + 1} ${escapedPath} | head -c ${bytesToRead}`;

      const result = await this.execCommand(agentId, remoteConfig, cmd, { timeout: 15000 });
      const content = result.stdout;

      return {
        ok: true,
        content,
        start: offset,
        total,
        read_length: Buffer.byteLength(content, 'utf8'),
        truncated: false,
      };
    } catch (err) {
      return { ok: false, error: 'read_error', message: err.message };
    }
  }

  /**
   * 获取远程文件总行数（对齐 bigfile_service.getLineCount 语义）
   * @returns {Promise<{ok: boolean, path?: string, lines?: number, error?: string}>}
   */
  async getLineCount(agentId, remoteConfig, filePath) {
    const escapedPath = this._escapeShellArg(filePath);
    try {
      const result = await this.execCommand(
        agentId, remoteConfig,
        `wc -l < ${escapedPath} 2>&1`,
        { timeout: 10000 }
      );
      if (result.exitCode !== 0) {
        return { ok: false, error: 'line_count_error', message: (result.stderr || result.stdout).trim() };
      }
      const lines = parseInt((result.stdout || '').trim().split('\n')[0], 10) || 0;
      return { ok: true, path: filePath, lines };
    } catch (err) {
      return { ok: false, error: 'line_count_error', message: err.message };
    }
  }

  /**
   * 列出远程目录（对齐 external_file_service.listDirectory 语义）
   * @param {string} agentId
   * @param {object} remoteConfig
   * @param {string} dirPath
   * @returns {Promise<{ok: boolean, entries?: Array<{name: string, isDirectory: boolean, isFile: boolean, path: string}>, path?: string, error?: string, message?: string}>}
   */
  async listFiles(agentId, remoteConfig, dirPath) {
    const escapedPath = this._escapeShellArg(dirPath);
    // ls -la --time-style=iso 获取详细信息（目录结尾加 / 便于识别）
    const cmd = `ls -la --time-style=iso ${escapedPath} 2>&1`;

    try {
      const result = await this.execCommand(agentId, remoteConfig, cmd, { timeout: 10000 });

      if (result.exitCode !== 0) {
        const errText = result.stdout.trim() || result.stderr.trim() || `exit code: ${result.exitCode}`;
        if (errText.includes('No such file') || errText.includes('cannot access')) {
          return { ok: false, error: 'directory_not_found', message: '目录不存在' };
        }
        return { ok: false, error: 'list_failed', message: errText };
      }

      const entries = this._parseLsOutput(result.stdout, dirPath);
      return { ok: true, entries, path: dirPath };
    } catch (err) {
      return { ok: false, error: 'list_failed', message: err.message };
    }
  }

  /**
   * 解析 ls -la 输出（对齐 external listDirectory 的 entries 结构）
   */
  _parseLsOutput(output, dirPath) {
    const lines = output.split('\n');
    const entries = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      // 跳过 "total" 行
      if (line.startsWith('total ')) continue;

      const parts = line.trim().split(/\s+/);
      if (parts.length < 8) continue;

      const permissions = parts[0];
      const name = parts.slice(8).join(' ');

      if (name === '.' || name === '..') continue;

      const isDirectory = permissions.startsWith('d');
      const isSymlink = permissions.startsWith('l');

      entries.push({
        name,
        isDirectory: isDirectory || isSymlink,
        isFile: !isDirectory && !isSymlink,
        path: `${dirPath.replace(/\/+$/, '')}/${name}`,
        // 附加信息（供内部使用，不影响 Agent）
        size: parseInt(parts[4], 10) || 0,
        mtime: parts.slice(5, 8).join(' '),
        permissions,
      });
    }

    return entries;
  }

  /**
   * 获取远程文件信息（对齐 bigfile_service.getInfo 语义）
   * @returns {Promise<{ok: boolean, total_size?: number, total_lines?: number, extension?: string, estimated_type?: string, error?: string}>}
   */
  async getFileInfo(agentId, remoteConfig, filePath) {
    const escapedPath = this._escapeShellArg(filePath);
    try {
      const result = await this.execCommand(
        agentId, remoteConfig,
        `stat -c '%s|%F' ${escapedPath} 2>&1`,
        { timeout: 10000 }
      );

      if (result.exitCode !== 0) {
        const errText = (result.stdout || result.stderr).trim();
        return { ok: false, error: 'stat_error', message: errText || `文件不存在: ${filePath}` };
      }

      const [sizeStr, typeStr] = result.stdout.trim().split('|');
      const total_size = parseInt(sizeStr, 10) || 0;

      // 如果是文件，统计行数
      let total_lines = 0;
      if (typeStr && !typeStr.includes('directory')) {
        const wc = await this.execCommand(
          agentId, remoteConfig,
          `wc -l < ${escapedPath} 2>/dev/null`,
          { timeout: 10000 }
        );
        total_lines = parseInt((wc.stdout || '').trim().split('\n')[0], 10) || 0;
      }

      const extension = filePath.includes('.')
        ? filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
        : '';
      let estimated_type = 'text';
      if (extension === '.json') estimated_type = 'json';
      else if (extension === '.jsonl' || extension === '.ndjson') estimated_type = 'jsonl';
      else if (extension === '.log') estimated_type = 'log';

      return { ok: true, total_size, total_lines, extension, estimated_type };
    } catch (err) {
      return { ok: false, error: 'stat_error', message: err.message };
    }
  }

  /**
   * 写入远程文件（对齐 tools_file._executeWriteFile 的返回包装语义）
   * @returns {Promise<{ok: boolean, files?: Array<{path: string, size: number, mimeType: string}>, versionId?: null, error?: string}>}
   */
  async writeFile(agentId, remoteConfig, filePath, content, mimeType) {
    const escapedPath = this._escapeShellArg(filePath);
    // 使用 base64 避免内容中的特殊字符问题
    const b64Content = Buffer.from(content, 'utf8').toString('base64');
    const cmd = `mkdir -p $(dirname ${escapedPath}) 2>/dev/null; echo ${this._escapeShellArg(b64Content)} | base64 -d > ${escapedPath} && wc -c < ${escapedPath}`;

    try {
      const result = await this.execCommand(agentId, remoteConfig, cmd, { timeout: 30000 });
      if (result.exitCode !== 0) {
        return { ok: false, error: 'write_failed', message: result.stderr || `exit code: ${result.exitCode}` };
      }
      const size = parseInt((result.stdout || '').trim().split('\n').pop(), 10) || 0;
      return {
        ok: true,
        files: [{ path: filePath, size, mimeType: mimeType || null }],
        versionId: null,
      };
    } catch (err) {
      return { ok: false, error: 'write_failed', message: err.message };
    }
  }

  /**
   * 追加内容到远程文件（对齐 tools_file._executeAppendFile 的返回包装语义）
   * @returns {Promise<{ok: boolean, files?: Array<{path: string, size: number, mimeType: string}>, versionId?: null, error?: string}>}
   */
  async appendFile(agentId, remoteConfig, filePath, content, mimeType) {
    const escapedPath = this._escapeShellArg(filePath);
    const b64Content = Buffer.from(content, 'utf8').toString('base64');
    const cmd = `mkdir -p $(dirname ${escapedPath}) 2>/dev/null; echo ${this._escapeShellArg(b64Content)} | base64 -d >> ${escapedPath} && wc -c < ${escapedPath}`;

    try {
      const result = await this.execCommand(agentId, remoteConfig, cmd, { timeout: 30000 });
      if (result.exitCode !== 0) {
        return { ok: false, error: 'append_failed', message: result.stderr || `exit code: ${result.exitCode}` };
      }
      const size = parseInt((result.stdout || '').trim().split('\n').pop(), 10) || 0;
      return {
        ok: true,
        files: [{ path: filePath, size, mimeType: mimeType || null }],
        versionId: null,
      };
    } catch (err) {
      return { ok: false, error: 'append_failed', message: err.message };
    }
  }

  /**
   * 删除远程文件（对齐 external_file_service.deleteFile 语义）
   * @returns {Promise<{ok: boolean, path?: string, error?: string, message?: string}>}
   */
  async deleteFile(agentId, remoteConfig, filePath) {
    const escapedPath = this._escapeShellArg(filePath);
    const cmd = `test -e ${escapedPath} 2>/dev/null; if [ $? -eq 0 ]; then if [ -d ${escapedPath} ]; then rmdir ${escapedPath} 2>/dev/null || echo "__IS_DIR__"; else rm -f ${escapedPath}; echo "__DELETED__"; fi; else echo "__NOT_FOUND__"; fi`;

    try {
      const result = await this.execCommand(agentId, remoteConfig, cmd, { timeout: 10000 });
      if (result.exitCode !== 0) {
        return { ok: false, error: 'delete_failed', message: result.stderr || `exit code: ${result.exitCode}` };
      }
      const out = result.stdout.trim();
      if (out.includes('__NOT_FOUND__')) {
        return { ok: false, error: 'file_not_found', message: '文件不存在' };
      }
      if (out.includes('__IS_DIR__')) {
        return { ok: false, error: 'is_directory', message: '路径是目录，请使用删除目录能力' };
      }
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: 'delete_failed', message: err.message };
    }
  }

  /**
   * 移动/重命名远程文件（对齐 external_file_service.moveFile 语义）
   * @returns {Promise<{ok: boolean, from?: string, to?: string, error?: string, message?: string}>}
   */
  async moveFile(agentId, remoteConfig, sourcePath, destPath, options = {}) {
    const escapedSrc = this._escapeShellArg(sourcePath);
    const escapedDst = this._escapeShellArg(destPath);

    // 检查源存在、目标冲突（本地语义：源不存在报错；目标存在且不 overwrite 报错）
    const checkCmd = [
      `test -e ${escapedSrc} || echo "__SRC_MISSING__"`,
      `test -e ${escapedDst} && [ ! -d ${escapedDst} ] && [ "${options.overwrite ? '1' : '0'}" = "0" ] && echo "__DST_EXISTS__" || true`,
      `test -d ${escapedDst} && echo "__DST_IS_DIR__" || true`,
    ].join('; ');

    try {
      const check = await this.execCommand(agentId, remoteConfig, checkCmd, { timeout: 10000 });
      const checkOut = check.stdout || '';
      if (checkOut.includes('__SRC_MISSING__')) {
        return { ok: false, error: 'file_not_found', message: '源文件不存在' };
      }
      if (checkOut.includes('__DST_EXISTS__')) {
        return { ok: false, error: 'target_exists', message: '目标文件已存在' };
      }
      if (checkOut.includes('__DST_IS_DIR__')) {
        return { ok: false, error: 'target_is_directory', message: '目标路径是目录' };
      }

      const mvCmd = `mkdir -p $(dirname ${escapedDst}) 2>/dev/null; mv ${escapedSrc} ${escapedDst}`;
      const result = await this.execCommand(agentId, remoteConfig, mvCmd, { timeout: 10000 });
      if (result.exitCode !== 0) {
        return { ok: false, error: 'move_failed', message: result.stderr || `exit code: ${result.exitCode}` };
      }
      return { ok: true, from: sourcePath, to: destPath };
    } catch (err) {
      return { ok: false, error: 'move_failed', message: err.message };
    }
  }

  /**
   * 复制远程文件（对齐 workspace_file_access_service.copyFile 语义）
   * @returns {Promise<{ok: boolean, from?: string, to?: string, error?: string, message?: string}>}
   */
  async copyFile(agentId, remoteConfig, sourcePath, destPath, options = {}) {
    const escapedSrc = this._escapeShellArg(sourcePath);
    const escapedDst = this._escapeShellArg(destPath);
    const overwrite = options.overwrite ? '-f' : '-n';

    try {
      const cmd = `mkdir -p $(dirname ${escapedDst}) 2>/dev/null; cp -r ${overwrite} ${escapedSrc} ${escapedDst}`;
      const result = await this.execCommand(agentId, remoteConfig, cmd, { timeout: 30000 });
      if (result.exitCode !== 0) {
        const errText = result.stderr || `exit code: ${result.exitCode}`;
        if (errText.includes('No such file')) {
          return { ok: false, error: 'file_not_found', message: '源文件不存在' };
        }
        if (errText.includes('exists')) {
          return { ok: false, error: 'target_exists', message: '目标文件已存在' };
        }
        return { ok: false, error: 'copy_failed', message: errText };
      }
      return { ok: true, from: sourcePath, to: destPath };
    } catch (err) {
      return { ok: false, error: 'copy_failed', message: err.message };
    }
  }

  /**
   * 生成跨侧复制的中转临时文件路径（位于 remote 数据目录，工作区之外）
   * @param {string} agentId
   * @returns {string}
   */
  tmpPath(agentId) {
    return path.join(this.dataDir, 'remote', 'tmp', `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  }

  /**
   * 判断远程路径类型（供跨侧复制时对齐本地 copyFile 语义）
   * @param {string} agentId
   * @param {object} remoteConfig
   * @param {string} remotePath
   * @returns {Promise<{type: 'file'|'directory'|'missing', error?: string}>}
   */
  async remotePathType(agentId, remoteConfig, remotePath) {
    const escaped = this._escapeShellArg(remotePath);
    try {
      const result = await this.execCommand(agentId, remoteConfig,
        `test -f ${escaped} && echo __FILE__ || (test -d ${escaped} && echo __DIR__ || echo __MISSING__)`,
        { timeout: 10000 });
      const out = (result.stdout || '').trim();
      if (out === '__DIR__') return { type: 'directory' };
      if (out === '__FILE__') return { type: 'file' };
      return { type: 'missing' };
    } catch (err) {
      // 命令执行失败（连接/channel 问题）≠ 源不存在，必须区分，否则会误报 source_not_found
      return { type: 'error', error: err.message };
    }
  }

  /**
   * 删除远程路径（供 move 跨侧删除源）
   * @param {string} agentId
   * @param {object} remoteConfig
   * @param {string} remotePath
   * @returns {Promise<{ok: boolean, error?: string, message?: string}>}
   */
  async removeRemote(agentId, remoteConfig, remotePath) {
    const escaped = this._escapeShellArg(remotePath);
    try {
      const result = await this.execCommand(agentId, remoteConfig,
        `rm -rf ${escaped}`, { timeout: 10000 });
      if (result.exitCode !== 0) {
        return { ok: false, error: 'delete_failed', message: result.stderr || `exit code: ${result.exitCode}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: 'delete_failed', message: err.message };
    }
  }

  /**
   * sftp 下载远程文件到本地临时路径（纯中转，调用方负责清理临时文件）
   * @param {string} agentId
   * @param {object} remoteConfig
   * @param {string} remotePath - 远程文件路径
   * @param {string} localTmpPath - 本地临时文件路径（工作区外）
   * @returns {Promise<{ok: boolean, error?: string, message?: string}>}
   */
  async sftpDownload(agentId, remoteConfig, remotePath, localTmpPath) {
    let sftp = null;
    try {
      const client = await this.getConnection(agentId, remoteConfig);
      sftp = await new Promise((resolve, reject) => {
        client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
      });
      await fsp.mkdir(path.dirname(localTmpPath), { recursive: true });
      await new Promise((resolve, reject) => {
        sftp.fastGet(remotePath, localTmpPath, (err) => (err ? reject(err) : resolve()));
      });
      return { ok: true };
    } catch (err) {
      this.log.error('[Remote] sftp 下载失败', { agentId, remotePath, error: err.message });
      return { ok: false, error: 'download_failed', message: err.message };
    } finally {
      // 关键：关闭 sftp 通道，否则每次复制泄漏一个 session 通道，
      // 服务器 MaxSessions 满后新 channel 打开失败（Channel open failure: open failed）
      try { sftp?.end(); } catch (_) { /* ignore */ }
    }
  }

  /**
   * sftp 上传本地临时文件到远程（纯中转，调用方负责清理临时文件）
   * @param {string} agentId
   * @param {object} remoteConfig
   * @param {string} localTmpPath - 本地临时文件路径（工作区外）
   * @param {string} remotePath - 远程目标路径
   * @returns {Promise<{ok: boolean, error?: string, message?: string}>}
   */
  async sftpUpload(agentId, remoteConfig, localTmpPath, remotePath) {
    let sftp = null;
    try {
      const client = await this.getConnection(agentId, remoteConfig);
      sftp = await new Promise((resolve, reject) => {
        client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
      });
      // 确保远程目录存在
      await this.execCommand(agentId, remoteConfig,
        `mkdir -p $(dirname ${this._escapeShellArg(remotePath)}) 2>/dev/null`,
        { timeout: 10000 });
      await new Promise((resolve, reject) => {
        sftp.fastPut(localTmpPath, remotePath, (err) => (err ? reject(err) : resolve()));
      });
      return { ok: true };
    } catch (err) {
      this.log.error('[Remote] sftp 上传失败', { agentId, remotePath, error: err.message });
      return { ok: false, error: 'upload_failed', message: err.message };
    } finally {
      // 关键：关闭 sftp 通道，防止 session 通道泄漏占满服务器 MaxSessions
      try { sftp?.end(); } catch (_) { /* ignore */ }
    }
  }

  /**
   * 创建远程目录（对齐 external_file_service.createDirectory 语义）
   * @returns {Promise<{ok: boolean, path?: string, error?: string, message?: string}>}
   */
  async createDirectory(agentId, remoteConfig, dirPath, options = {}) {
    const escapedPath = this._escapeShellArg(dirPath);
    const recursive = options.recursive !== false;

    try {
      const checkCmd = `test -e ${escapedPath} && (test -d ${escapedPath} && echo "__DIR__" || echo "__FILE__") || echo "__MISSING__"`;
      const check = await this.execCommand(agentId, remoteConfig, checkCmd, { timeout: 10000 });
      const checkOut = (check.stdout || '').trim();

      if (checkOut === '__DIR__') {
        return { ok: false, error: 'already_exists', message: '目录已存在' };
      }
      if (checkOut === '__FILE__') {
        return { ok: false, error: 'path_is_file', message: '同路径的文件已存在' };
      }

      const flag = recursive ? '-p' : '';
      const result = await this.execCommand(
        agentId, remoteConfig,
        `mkdir ${flag} ${escapedPath} 2>&1`,
        { timeout: 10000 }
      );
      if (result.exitCode !== 0) {
        return { ok: false, error: 'create_failed', message: (result.stdout || result.stderr).trim() };
      }
      return { ok: true, path: dirPath };
    } catch (err) {
      return { ok: false, error: 'create_failed', message: err.message };
    }
  }

  /**
   * 检查远程路径的读写权限（对齐 file_check_permission 语义）
   * @returns {Promise<{ok: boolean, path?: string, canRead?: boolean, canWrite?: boolean, isDirectory?: boolean, error?: string}>}
   */
  async checkPermission(agentId, remoteConfig, filePath) {
    const escapedPath = this._escapeShellArg(filePath);
    try {
      const cmd = [
        `test -e ${escapedPath} || echo "__MISSING__"`,
        `test -r ${escapedPath} && echo "__READ__" || true`,
        `test -w ${escapedPath} && echo "__WRITE__" || true`,
        `test -d ${escapedPath} && echo "__DIR__" || true`,
      ].join('; ');
      const result = await this.execCommand(agentId, remoteConfig, cmd, { timeout: 10000 });
      const out = result.stdout || '';
      if (out.includes('__MISSING__')) {
        return { ok: false, error: 'path_not_found', message: '路径不存在' };
      }
      return {
        ok: true,
        path: filePath,
        canRead: out.includes('__READ__'),
        canWrite: out.includes('__WRITE__'),
        isDirectory: out.includes('__DIR__'),
      };
    } catch (err) {
      return { ok: false, error: 'permission_check_failed', message: err.message };
    }
  }

  /**
   * 在远程执行 Python 脚本（base64 传递，避免转义问题）
   * @param {string} agentId
   * @param {object} remoteConfig
   * @param {string} script - Python 源码
   * @param {string[]} [args] - 脚本参数（已由调用方转义）
   * @param {object} [options]
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
   */
  async runPython(agentId, remoteConfig, script, args = [], options = {}) {
    const scriptB64 = Buffer.from(script, 'utf8').toString('base64');
    const argStr = args.map((a) => this._escapeShellArg(String(a))).join(' ');
    const cmd = `(python3 -c "$(echo ${this._escapeShellArg(scriptB64)} | base64 -d)" ${argStr} 2>/dev/null || python -c "$(echo ${this._escapeShellArg(scriptB64)} | base64 -d)" ${argStr})`;
    return this.execCommand(agentId, remoteConfig, cmd, { timeout: options.timeout || 30000 });
  }

  /**
   * 在远程文件中搜索（对齐 external_file_service.searchInFile 语义）
   * @returns {Promise<{ok: boolean, matches?: Array<{line: number, col: number, text: string}>, count?: number, pattern?: string, error?: string, message?: string}>}
   */
  async searchInFile(agentId, remoteConfig, filePath, pattern, options = {}) {
    const isRegex = Boolean(options.is_regex);
    const maxResults = options.max_results ?? 100;
    const pyScript = `
import sys, json, re
path = sys.argv[1]
pattern = sys.argv[2]
is_regex = sys.argv[3] == '1'
max_results = int(sys.argv[4])
try:
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()
except Exception as e:
    print(json.dumps({'error': str(e)})); sys.exit(0)
lines = content.split('\\n')
matches = []
if is_regex:
    try:
        rx = re.compile(pattern)
    except Exception as e:
        print(json.dumps({'error': 'invalid_regex: ' + str(e)})); sys.exit(0)
    for i, line in enumerate(lines):
        if len(matches) >= max_results: break
        for m in rx.finditer(line):
            if len(matches) >= max_results: break
            matches.append({'line': i + 1, 'col': m.start() + 1, 'text': line})
else:
    for i, line in enumerate(lines):
        if len(matches) >= max_results: break
        idx = line.find(pattern)
        while idx != -1:
            if len(matches) >= max_results: break
            matches.append({'line': i + 1, 'col': idx + 1, 'text': line})
            idx = line.find(pattern, idx + 1)
print(json.dumps({'ok': True, 'matches': matches, 'count': len(matches), 'pattern': pattern}))
`;
    try {
      const result = await this.runPython(
        agentId, remoteConfig, pyScript,
        [filePath, pattern, isRegex ? '1' : '0', String(maxResults)],
        { timeout: 30000 }
      );
      if (result.exitCode !== 0) {
        return { ok: false, error: 'search_failed', message: result.stderr || `exit code: ${result.exitCode}` };
      }
      const data = JSON.parse(result.stdout.trim().split('\n').pop() || '{}');
      if (data.error) {
        // 文件不存在等情况
        return { ok: false, error: 'search_failed', message: data.error };
      }
      return { ok: true, matches: data.matches, count: data.count, pattern };
    } catch (err) {
      return { ok: false, error: 'search_failed', message: err.message };
    }
  }

  /**
   * 在远程目录中递归搜索文本（对齐 external_file_service.searchText 语义）
   * @returns {Promise<{ok: boolean, results?: Array<{file: string, line: number, col: number}>, error?: string, message?: string}>}
   */
  async searchTextInDir(agentId, remoteConfig, dirPath, text, options = {}) {
    const caseSensitive = Boolean(options.caseSensitive);
    const maxResults = options.maxResults ?? 1000;
    const pyScript = `
import sys, json, os
root = sys.argv[1]
text = sys.argv[2]
case_sensitive = sys.argv[3] == '1'
max_results = int(sys.argv[4])
results = []
if os.path.isfile(root):
    base = os.path.basename(root)
    files = [(root, base)]
else:
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ('.git', 'node_modules', '.io', '.versions', '.meta')]
        for fn in filenames:
            files.append((os.path.join(dirpath, fn), os.path.relpath(os.path.join(dirpath, fn), root)))
search = text if case_sensitive else text.lower()
try:
    for full, rel in files:
        if len(results) >= max_results: break
        try:
            with open(full, 'r', encoding='utf-8', errors='replace') as f:
                for i, line in enumerate(f):
                    if len(results) >= max_results: break
                    hay = line if case_sensitive else line.lower()
                    idx = hay.find(search)
                    while idx != -1:
                        if len(results) >= max_results: break
                        results.append({'file': rel, 'line': i + 1, 'col': idx + 1})
                        idx = hay.find(search, idx + 1)
        except Exception:
            continue
except Exception as e:
    print(json.dumps({'error': str(e)})); sys.exit(0)
print(json.dumps({'ok': True, 'results': results}))
`;
    try {
      const result = await this.runPython(
        agentId, remoteConfig, pyScript,
        [dirPath, text, caseSensitive ? '1' : '0', String(maxResults)],
        { timeout: 60000 }
      );
      if (result.exitCode !== 0) {
        return { ok: false, error: 'search_failed', message: result.stderr || `exit code: ${result.exitCode}` };
      }
      const data = JSON.parse(result.stdout.trim().split('\n').pop() || '{}');
      if (data.error) {
        return { ok: false, error: 'search_failed', message: data.error };
      }
      return { ok: true, results: data.results };
    } catch (err) {
      return { ok: false, error: 'search_failed', message: err.message };
    }
  }

  /**
   * 在远程文件中精确替换文本（对齐 external_file_service.editFile 语义）
   * @returns {Promise<{ok: boolean, path?: string, occurrences?: number, error?: string, message?: string}>}
   */
  async editFile(agentId, remoteConfig, filePath, oldString, newString, options = {}) {
    const replaceAll = Boolean(options.replace_all);
    const pyScript = `
import sys, json
path = sys.argv[1]
old_str = sys.argv[2]
new_str = sys.argv[3]
replace_all = sys.argv[4] == '1'
try:
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()
except Exception as e:
    print(json.dumps({'error': 'file_not_found', 'message': str(e)})); sys.exit(0)
if old_str not in content:
    print(json.dumps({'error': 'text_not_found', 'message': '未找到要替换的文本'})); sys.exit(0)
if replace_all:
    count = content.count(old_str)
    content = content.replace(old_str, new_str)
else:
    count = 1
    content = content.replace(old_str, new_str, 1)
try:
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
except Exception as e:
    print(json.dumps({'error': 'write_failed', 'message': str(e)})); sys.exit(0)
print(json.dumps({'ok': True, 'path': path, 'occurrences': count}))
`;
    try {
      const result = await this.runPython(
        agentId, remoteConfig, pyScript,
        [filePath, oldString, newString, replaceAll ? '1' : '0'],
        { timeout: 30000 }
      );
      if (result.exitCode !== 0) {
        return { ok: false, error: 'edit_failed', message: result.stderr || `exit code: ${result.exitCode}` };
      }
      const data = JSON.parse(result.stdout.trim().split('\n').pop() || '{}');
      if (data.error) {
        return { ok: false, error: data.error, message: data.message };
      }
      return { ok: true, path: filePath, occurrences: data.occurrences };
    } catch (err) {
      return { ok: false, error: 'edit_failed', message: err.message };
    }
  }

  /**
   * 统计远程文件匹配行数（对齐 bigfile_service.stats 语义）
   * @param {string} agentId
   * @param {object} remoteConfig
   * @param {string} filePath
   * @param {Array<{name: string, pattern: string, is_regex?: boolean}>} rules
   * @param {object} [options] - { line_range? }
   * @returns {Promise<{ok: boolean, stats?: Array<{name: string, pattern: string, matching_lines: number}>, total_lines_checked?: number, error?: string}>}
   */
  async statsFile(agentId, remoteConfig, filePath, rules = [], options = {}) {
    const pyScript = `
import sys, json, re
path = sys.argv[1]
rules = json.loads(sys.argv[2])
range_start = int(sys.argv[3])
range_end = int(sys.argv[4])
try:
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()
except Exception as e:
    print(json.dumps({'error': str(e)})); sys.exit(0)
lines = content.split('\\n')
compiled = []
for r in rules:
    rx = None
    err = False
    if r.get('is_regex'):
        try:
            rx = re.compile(r.get('pattern', ''))
        except Exception:
            err = True
    compiled.append({'name': r.get('name', ''), 'pattern': r.get('pattern', ''), 'regex': rx, 'error': err, 'matching_lines': 0})
total_checked = 0
for i, line in enumerate(lines):
    abs_line = i + 1
    if abs_line < range_start: continue
    if abs_line > range_end: break
    total_checked += 1
    for c in compiled:
        if c['error']: continue
        if c['regex']:
            if c['regex'].search(line): c['matching_lines'] += 1
        else:
            if c['pattern'] in line: c['matching_lines'] += 1
stats = [{'name': c['name'], 'pattern': c['pattern'], 'matching_lines': c['matching_lines']} for c in compiled]
print(json.dumps({'ok': True, 'stats': stats, 'total_lines_checked': total_checked}))
`;
    try {
      const rangeStart = options.line_range?.start ?? 0;
      const rangeEnd = options.line_range?.end ?? 2147483647;
      const result = await this.runPython(
        agentId, remoteConfig, pyScript,
        [filePath, JSON.stringify(rules), String(rangeStart), String(rangeEnd)],
        { timeout: 60000 }
      );
      if (result.exitCode !== 0) {
        return { ok: false, error: 'read_error', message: result.stderr || `exit code: ${result.exitCode}` };
      }
      const data = JSON.parse(result.stdout.trim().split('\n').pop() || '{}');
      if (data.error) {
        return { ok: false, error: 'read_error', message: data.error };
      }
      return { ok: true, stats: data.stats, total_lines_checked: data.total_lines_checked };
    } catch (err) {
      return { ok: false, error: 'read_error', message: err.message };
    }
  }

  /**
   * JSON 子树提取（对齐 bigfile_service.jsonTree 语义）
   * @returns {Promise<{ok: boolean, content?: string, truncated?: boolean, original_length?: number, path_expr?: string, max_depth?: number, error?: string, message?: string}>}
   */
  async jsonTree(agentId, remoteConfig, filePath, pathExpr = '', maxDepth = 2) {
    const pyScript = `
import sys, json
path = sys.argv[1]
path_expr = sys.argv[2]
max_depth = int(sys.argv[3])
def extract(node, depth):
    if depth >= max_depth:
        if isinstance(node, dict): return {k: (type(v).__name__ if isinstance(v, (dict, list)) else v) for k, v in list(node.items())[:20]}
        if isinstance(node, list): return [type(v).__name__ if isinstance(v, (dict, list)) else v for v in node[:20]]
        return node
    if isinstance(node, dict):
        return {k: extract(v, depth + 1) for k, v in node.items()}
    if isinstance(node, list):
        return [extract(v, depth + 1) for v in node]
    return node
try:
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        data = json.load(f)
except Exception as e:
    print(json.dumps({'error': 'json_parse_error', 'message': str(e)})); sys.exit(0)
if path_expr and path_expr != '.':
    node = data
    for seg in path_expr.split('.'):
        if isinstance(node, dict) and seg in node:
            node = node[seg]
        elif isinstance(node, list) and seg.isdigit() and int(seg) < len(node):
            node = node[int(seg)]
        else:
            print(json.dumps({'error': 'path_not_found', 'message': 'JSON路径 ' + path_expr + ' 不存在'})); sys.exit(0)
else:
    node = data
content = json.dumps(extract(node, 0), ensure_ascii=False)
print(json.dumps({'ok': True, 'content': content, 'path_expr': path_expr, 'max_depth': max_depth}))
`;
    try {
      const result = await this.runPython(
        agentId, remoteConfig, pyScript,
        [filePath, pathExpr || '', String(maxDepth || 2)],
        { timeout: 60000 }
      );
      if (result.exitCode !== 0) {
        return { ok: false, error: 'json_parse_error', message: result.stderr || `exit code: ${result.exitCode}` };
      }
      const data = JSON.parse(result.stdout.trim().split('\n').pop() || '{}');
      if (data.error) {
        return { ok: false, error: data.error, message: data.message };
      }
      return {
        ok: true,
        content: data.content,
        truncated: false,
        original_length: data.content.length,
        path_expr: data.path_expr,
        max_depth: data.max_depth,
      };
    } catch (err) {
      return { ok: false, error: 'json_parse_error', message: err.message };
    }
  }

  /**
   * JSON 键名探索（对齐 bigfile_service.jsonKeys 语义）
   * @returns {Promise<{ok: boolean, type?: string, keys?: Array<string>, count?: number, truncated?: boolean, error?: string, message?: string}>}
   */
  async jsonKeys(agentId, remoteConfig, filePath, pathExpr = '') {
    const pyScript = `
import sys, json
path = sys.argv[1]
path_expr = sys.argv[2]
try:
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        data = json.load(f)
except Exception as e:
    print(json.dumps({'error': 'json_parse_error', 'message': str(e)})); sys.exit(0)
if path_expr and path_expr != '.':
    node = data
    for seg in path_expr.split('.'):
        if isinstance(node, dict) and seg in node:
            node = node[seg]
        elif isinstance(node, list) and seg.isdigit() and int(seg) < len(node):
            node = node[int(seg)]
        else:
            print(json.dumps({'error': 'path_not_found', 'message': 'JSON路径 ' + path_expr + ' 不存在'})); sys.exit(0)
else:
    node = data
if isinstance(node, dict):
    print(json.dumps({'ok': True, 'type': 'object', 'keys': list(node.keys()), 'count': len(node), 'truncated': False}))
elif isinstance(node, list):
    print(json.dumps({'ok': True, 'type': 'array', 'count': len(node), 'truncated': False}))
else:
    print(json.dumps({'ok': True, 'type': 'scalar', 'value': node, 'count': 1, 'truncated': False}))
`;
    try {
      const result = await this.runPython(
        agentId, remoteConfig, pyScript,
        [filePath, pathExpr || ''],
        { timeout: 60000 }
      );
      if (result.exitCode !== 0) {
        return { ok: false, error: 'json_parse_error', message: result.stderr || `exit code: ${result.exitCode}` };
      }
      const data = JSON.parse(result.stdout.trim().split('\n').pop() || '{}');
      if (data.error) {
        return { ok: false, error: data.error, message: data.message };
      }
      return data;
    } catch (err) {
      return { ok: false, error: 'json_parse_error', message: err.message };
    }
  }

  /**
   * JSONL 过滤（对齐 bigfile_service.jsonlFilter 语义）
   * @returns {Promise<{ok: boolean, records?: Array<string>, count?: number, lines_processed?: number, truncated?: boolean, error?: string, message?: string}>}
   */
  async jsonlFilter(agentId, remoteConfig, filePath, field, pattern, options = {}) {
    const isRegex = Boolean(options.is_regex);
    const maxResults = options.max_results ?? 50;
    const maxCharsPerRecord = options.max_chars_per_record ?? 2000;
    const pyScript = `
import sys, json, re
path = sys.argv[1]
field = sys.argv[2]
pattern = sys.argv[3]
is_regex = sys.argv[4] == '1'
max_results = int(sys.argv[5])
max_chars = int(sys.argv[6])
rx = None
if is_regex:
    try:
        rx = re.compile(pattern)
    except Exception as e:
        print(json.dumps({'error': 'invalid_regex', 'message': '无效的正则表达式: ' + pattern})); sys.exit(0)
def match_field(obj, f, pat):
    if f in obj:
        val = obj[f]
        if isinstance(val, (dict, list)):
            return False
        if rx is not None:
            return rx.search(str(val)) is not None
        return pat in str(val)
    return False
records = []
lines_processed = 0
try:
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            if not line.strip(): continue
            if len(records) >= max_results: break
            lines_processed += 1
            try:
                obj = json.loads(line.strip())
            except Exception:
                continue
            if match_field(obj, field, pattern):
                record_str = json.dumps(obj, ensure_ascii=False)
                display = record_str[:max_chars] if len(record_str) > max_chars else record_str
                records.append(display)
except Exception as e:
    print(json.dumps({'error': str(e)})); sys.exit(0)
print(json.dumps({'ok': True, 'records': records, 'count': len(records), 'lines_processed': lines_processed, 'truncated': False}))
`;
    try {
      const result = await this.runPython(
        agentId, remoteConfig, pyScript,
        [filePath, field, pattern, isRegex ? '1' : '0', String(maxResults), String(maxCharsPerRecord)],
        { timeout: 60000 }
      );
      if (result.exitCode !== 0) {
        return { ok: false, error: 'read_error', message: result.stderr || `exit code: ${result.exitCode}` };
      }
      const data = JSON.parse(result.stdout.trim().split('\n').pop() || '{}');
      if (data.error) {
        return { ok: false, error: data.error, message: data.message };
      }
      return data;
    } catch (err) {
      return { ok: false, error: 'read_error', message: err.message };
    }
  }

  /**
   * 搜索远程文件内容
   */
  async searchText(agentId, remoteConfig, dirPath, pattern, options = {}) {
    const escapedPath = this._escapeShellArg(dirPath);
    const escapedPattern = this._escapeShellArg(pattern);

    let cmd = `grep -rn ${escapedPattern} ${escapedPath} 2>&1`;
    if (options.maxResults) {
      cmd += ` | head -n ${options.maxResults}`;
    }

    try {
      const result = await this.execCommand(agentId, remoteConfig, cmd, { timeout: 30000 });

      if (result.exitCode === 1 && !result.stdout.trim()) {
        // grep returns 1 when no matches
        return { matches: [] };
      }

      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return { matches: [], error: result.stderr || `exit code: ${result.exitCode}` };
      }

      const matches = this._parseGrepOutput(result.stdout);
      return { matches };
    } catch (err) {
      return { matches: [], error: err.message };
    }
  }

  /**
   * 解析 grep -rn 输出
   */
  _parseGrepOutput(output) {
    const lines = output.split('\n').filter(Boolean);
    return lines.map(line => {
      const match = line.match(/^(.+?):(\d+):(.*)$/);
      if (match) {
        return {
          file: match[1],
          line: parseInt(match[2], 10),
          content: match[3],
        };
      }
      return { raw: line };
    });
  }

  /**
   * 获取远程文件行数
   */
  async getLineCount(agentId, remoteConfig, filePath) {
    const escapedPath = this._escapeShellArg(filePath);
    const cmd = `wc -l < ${escapedPath}`;

    try {
      const result = await this.execCommand(agentId, remoteConfig, cmd, { timeout: 10000 });
      const count = parseInt(result.stdout.trim(), 10);
      return { count: Number.isFinite(count) ? count : 0 };
    } catch (err) {
      return { count: 0, error: err.message };
    }
  }

  /**
   * 创建远程目录
   */
  async createDirectory(agentId, remoteConfig, dirPath) {
    const escapedPath = this._escapeShellArg(dirPath);
    const cmd = `mkdir -p ${escapedPath}`;

    try {
      const result = await this.execCommand(agentId, remoteConfig, cmd, { timeout: 5000 });
      if (result.exitCode !== 0) {
        return { error: result.stderr || `exit code: ${result.exitCode}` };
      }
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  }

  /**
   * 检查远程文件是否存在
   */
  async fileExists(agentId, remoteConfig, filePath) {
    const escapedPath = this._escapeShellArg(filePath);
    const cmd = `test -e ${escapedPath} && echo "EXISTS" || echo "NOT_FOUND"`;

    try {
      const result = await this.execCommand(agentId, remoteConfig, cmd, { timeout: 5000 });
      return { exists: result.stdout.trim() === 'EXISTS' };
    } catch (err) {
      return { exists: false, error: err.message };
    }
  }

  /**
   * 编辑远程文件（使用 sed 替换）
   * @param {string} agentId
   * @param {object} remoteConfig
   * @param {string} filePath
   * @param {string} oldText - 要替换的文本
   * @param {string} newText - 新文本
   */
  async editFile(agentId, remoteConfig, filePath, oldText, newText) {
    // 使用 Python 脚本进行可靠的文本替换
    const escapedPath = this._escapeShellArg(filePath);
    const oldB64 = Buffer.from(oldText, 'utf8').toString('base64');
    const newB64 = Buffer.from(newText, 'utf8').toString('base64');

    const script = `
import sys, base64
path = sys.argv[1]
old = base64.b64decode(sys.argv[2]).decode('utf-8')
new = base64.b64decode(sys.argv[3]).decode('utf-8')
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()
if old not in content:
    print('ERROR: old_text not found in file')
    sys.exit(1)
content = content.replace(old, new, 1)
with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print('OK')
`.trim();

    const scriptB64 = Buffer.from(script, 'utf8').toString('base64');
    const cmd = `(python3 -c "$(echo ${this._escapeShellArg(scriptB64)} | base64 -d)" 2>/dev/null || python -c "$(echo ${this._escapeShellArg(scriptB64)} | base64 -d)") ${escapedPath} ${this._escapeShellArg(oldB64)} ${this._escapeShellArg(newB64)}`;

    try {
      const result = await this.execCommand(agentId, remoteConfig, cmd, { timeout: 15000 });
      if (result.exitCode !== 0) {
        return { error: result.stdout.trim() || result.stderr || `exit code: ${result.exitCode}` };
      }
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  }

  /**
   * 关闭所有连接
   */
  async closeAll() {
    for (const [agentId, entry] of this._connections) {
      try {
        entry.client.end();
      } catch (_) { /* ignore */ }
    }
    this._connections.clear();
  }

  /**
   * 关闭指定 Agent 的连接
   */
  closeAgent(agentId) {
    const entry = this._connections.get(agentId);
    if (entry) {
      try { entry.client.end(); } catch (_) { /* ignore */ }
      this._connections.delete(agentId);
    }
  }

  // ========== 远程进程管理（桥接 localcmd_* 工具，完全等价） ==========

  /**
   * 生成远程进程的输出文件路径
   * @param {string} agentId
   * @param {string} processId
   * @returns {string}
   * @private
   */
  _processOutputPath(agentId, processId) {
    return path.join(this.dataDir, 'remote', agentId, `${processId}.log`);
  }

  /**
   * 构造远程 shell 命令（处理 args / cwd / env）
   * @private
   */
  _buildRemoteShellCommand(command, args, cwd, env) {
    const parts = [command, ...(args || [])].map((a) => this._escapeShellArg(String(a)));
    let cmd = parts.join(' ');
    if (env && typeof env === 'object') {
      const envPrefix = Object.entries(env)
        .map(([k, v]) => `${k}=${this._escapeShellArg(String(v))}`)
        .join(' ');
      if (envPrefix) cmd = `${envPrefix} ${cmd}`;
    }
    if (cwd) cmd = `cd ${this._escapeShellArg(String(cwd))} && ${cmd}`;
    return cmd;
  }

  /**
   * 启动远程进程（fire-and-forget，与 localcmd_spawn 完全等价）。
   * 通过 SSH exec 打开 channel，进程保持运行，可交互输入/读取输出/终止。
   * 输出流式写入本地日志文件（格式与 localcmd 一致：[STDOUT]/[STDERR]/[STDIN]/[PROCESS_START]...）。
   * @param {string} agentId
   * @param {object} remoteConfig
   * @param {string} command
   * @param {string[]} [args]
   * @param {string} [cwd]
   * @param {object} [env]
   * @param {boolean} [pushEvents] - 是否向智能体推送进程事件（默认 true）
   * @returns {Promise<{ok: boolean, processId?: string, error?: string}>}
   */
  async spawnRemoteProcess(agentId, remoteConfig, command, args = [], cwd, env, pushEvents = true) {
    this._processCounter += 1;
    const processId = `remote_${Date.now()}_${this._processCounter}`;
    const shellCmd = this._buildRemoteShellCommand(command, args, cwd, env);
    const outputFile = this._processOutputPath(agentId, processId);

    let client;
    try {
      client = await this.getConnection(agentId, remoteConfig);
    } catch (err) {
      this.log.error('[Remote] 远程进程启动失败：SSH 连接失败', { agentId, error: err.message });
      return { ok: false, processId, error: err.message };
    }

    try {
      await fsp.mkdir(path.dirname(outputFile), { recursive: true });
    } catch (_) { /* ignore */ }

    return new Promise((resolve) => {
      client.exec(shellCmd, (err, stream) => {
        if (err) {
          this.log.error('[Remote] 远程进程 exec 失败', { agentId, processId, error: err.message });
          resolve({ ok: false, processId, error: err.message });
          return;
        }

        // 创建输出文件写入流（追加模式，与 localcmd 一致）
        let writeStream;
        try {
          writeStream = fs.createWriteStream(outputFile, { flags: 'a', encoding: 'utf8' });
        } catch (writeErr) {
          resolve({ ok: false, processId, error: `output_file_open_failed: ${writeErr.message}` });
          return;
        }

        const proc = {
          id: processId,
          agentId,
          command,
          args: args || [],
          channel: stream,
          status: 'running',
          exitCode: null,
          pid: null,
          startupError: null,
          outputFile,
          writeStream,
          createdAt: new Date().toISOString(),
          pushEvents,
        };
        this._processes.set(processId, proc);
        this._emitProcessEvent({
          processId,
          agentId,
          pushEvents,
          type: 'started',
          pid: null, // 远程拿不到真实 pid
          command,
          args: args || [],
          ts: Date.now()
        });

        const safeWrite = (data) => {
          if (writeStream.writable && !writeStream.destroyed) {
            writeStream.write(data);
          }
        };

        // 文件头（与 localcmd 格式一致）
        safeWrite(`[PROCESS_START] ${command} ${(args || []).join(' ')}\n`);
        safeWrite(`[START_TIME] ${new Date().toISOString()}\n`);
        safeWrite('-'.repeat(50) + '\n');

        // stdout / stderr 流式写入
        stream.on('data', (data) => {
          const text = `[STDOUT] ${data.toString('utf8')}`;
          safeWrite(text);
          this._emitProcessEvent({ processId, agentId, pushEvents, type: 'log', text, ts: Date.now() });
        });
        stream.stderr.on('data', (data) => {
          const text = `[STDERR] ${data.toString('utf8')}`;
          safeWrite(text);
          this._emitProcessEvent({ processId, agentId, pushEvents, type: 'log', text, ts: Date.now() });
        });

        // 进程结束
        stream.on('close', (code, signal) => {
          if (proc.status !== 'killed') {
            proc.status = code === 0 ? 'completed' : 'error';
          }
          proc.exitCode = code;
          proc.channel = null;

          safeWrite('-'.repeat(50) + '\n');
          safeWrite(`[PROCESS_END] exitCode=${code}, signal=${signal}\n`);
          safeWrite(`[END_TIME] ${new Date().toISOString()}\n`);

          if (writeStream.writable && !writeStream.destroyed) {
            writeStream.end();
          }
          this.log.info('[Remote] 远程进程结束', { agentId, processId, code, signal });
          // error 场景（startupError 已设置）由 error handler 发唯一 exit 事件，此处跳过防双发
          if (!proc.startupError) {
            this._emitProcessEvent({
              processId,
              agentId,
              pushEvents,
              type: 'exit',
              status: proc.status,
              exitCode: code,
              signal,
              ts: Date.now()
            });
          }
        });

        stream.on('error', (streamErr) => {
          proc.status = 'error';
          proc.startupError = streamErr.message;
          safeWrite(`[PROCESS_ERROR] ${streamErr.message}\n`);
          if (writeStream.writable && !writeStream.destroyed) {
            writeStream.end();
          }
          this.log.error('[Remote] 远程进程流错误', { agentId, processId, error: streamErr.message });
          // 远程启动失败的终端事件（close 因 startupError 守卫跳过，此处是唯一 exit 事件源）
          this._emitProcessEvent({
            processId,
            agentId,
            pushEvents,
            type: 'exit',
            status: 'error',
            exitCode: null,
            signal: null,
            error: streamErr.message,
            ts: Date.now()
          });
        });

        this.log.info('[Remote] 远程进程已启动', { agentId, processId, command, outputFile });
        resolve({ ok: true, processId });
      });
    });
  }

  /**
   * 向远程进程发送输入（与 localcmd_send_input 完全等价）
   * @param {string} agentId
   * @param {string} processId
   * @param {string} data
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async sendRemoteProcessInput(agentId, processId, data) {
    const proc = this._processes.get(processId);
    if (!proc || proc.agentId !== agentId) {
      return { ok: false, error: 'process_not_found' };
    }
    if (proc.status !== 'running' || !proc.channel) {
      return { ok: false, error: `process_not_running (status: ${proc.status})` };
    }
    try {
      // 记录输入到文件（与 localcmd 一致）
      proc.writeStream?.write(`[STDIN] ${data}`);
      proc.channel.write(data);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * 读取远程进程输出文件（按字节偏移 seek，与 localcmd_read_output 完全等价）
   * @param {string} agentId
   * @param {string} processId
   * @param {number} [offset]
   * @param {number} [window]
   * @returns {Promise<object>}
   */
  async readRemoteProcessOutput(agentId, processId, offset = 0, window = 5000) {
    const proc = this._processes.get(processId);
    if (!proc || proc.agentId !== agentId) {
      return { ok: false, error: 'process_not_found' };
    }
    if (proc.startupError) {
      return { ok: false, error: 'process_startup_failed', status: proc.status, reason: proc.startupError };
    }

    try {
      let stats;
      try {
        stats = await fsp.stat(proc.outputFile);
      } catch (err) {
        return { ok: false, error: `file_stat_failed: ${err.message}` };
      }

      const totalLength = stats.size;
      const start = Math.max(0, Number(offset) || 0);

      // 如果偏移量超出文件大小，返回空内容
      if (start >= totalLength) {
        return {
          ok: true,
          content: '',
          offset: totalLength,
          nextOffset: totalLength,
          totalLength,
          hasMore: false,
          status: proc.status,
          exitCode: proc.exitCode,
        };
      }

      // 打开文件并读取指定位置（与 localcmd 完全一致的字节语义）
      let fileHandle;
      try {
        fileHandle = await fsp.open(proc.outputFile, 'r');
        const bytesToRead = Math.min(Number(window) || 5000, totalLength - start);
        const buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, start);
        const content = buffer.toString('utf8', 0, bytesRead);
        const nextOffset = start + bytesRead;
        const hasMore = nextOffset < totalLength;
        await fileHandle.close();

        return {
          ok: true,
          content,
          offset: start,
          nextOffset,
          totalLength,
          hasMore,
          status: proc.status,
          exitCode: proc.exitCode,
        };
      } catch (err) {
        if (fileHandle) {
          await fileHandle.close().catch(() => {});
        }
        return { ok: false, error: `read_failed: ${err.message}` };
      }
    } catch (err) {
      this.log.error('[Remote] 读取远程进程输出失败', { processId, error: err?.message });
      return { ok: false, error: `read_failed: ${err?.message}` };
    }
  }

  /**
   * 获取远程进程状态（与 localcmd_get_status 完全等价）
   * @param {string} agentId
   * @param {string} processId
   * @returns {Promise<{ok: boolean, process?: object, error?: string}>}
   */
  async getRemoteProcessStatus(agentId, processId) {
    const proc = this._processes.get(processId);
    if (!proc || proc.agentId !== agentId) {
      return { ok: false, error: 'process_not_found' };
    }
    return {
      ok: true,
      process: {
        id: proc.id,
        command: proc.command,
        args: proc.args,
        createdAt: proc.createdAt,
        status: proc.status,
        exitCode: proc.exitCode,
        pid: proc.pid,
        startupError: proc.startupError,
      },
    };
  }

  /**
   * 列出远程进程（与 localcmd_list 完全等价）
   * @param {string} agentId
   * @returns {Promise<{ok: boolean, processes: Array<object>}>}
   */
  async listRemoteProcesses(agentId) {
    const list = [];
    for (const [id, proc] of this._processes) {
      if (proc.agentId === agentId) {
        list.push({
          id,
          command: proc.command,
          args: proc.args,
          createdAt: proc.createdAt,
          status: proc.status,
          exitCode: proc.exitCode,
          pid: proc.pid,
        });
      }
    }
    return { ok: true, processes: list };
  }

  /**
   * 终止远程进程（与 localcmd_kill 完全等价）
   * @param {string} agentId
   * @param {string} processId
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async killRemoteProcess(agentId, processId) {
    const proc = this._processes.get(processId);
    if (!proc || proc.agentId !== agentId) {
      return { ok: false, error: 'process_not_found' };
    }
    if (proc.status !== 'running' || !proc.channel) {
      return { ok: false, error: `process_not_running (status: ${proc.status})` };
    }
    try {
      proc.status = 'killed';
      // 先发 SIGTERM，再关闭 channel
      try {
        proc.channel.signal('SIGTERM');
      } catch (_) { /* 某些服务端可能不支持 signal */ }
      proc.channel.close();
      this.log.info('[Remote] 远程进程已终止', { agentId, processId });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * 清理某 Agent 的所有远程进程（连接关闭时调用）
   * @param {string} agentId
   */
  cleanupAgentProcesses(agentId) {
    for (const [processId, proc] of this._processes) {
      if (proc.agentId === agentId) {
        try { proc.channel?.close(); } catch (_) { /* ignore */ }
        try { proc.writeStream?.end(); } catch (_) { /* ignore */ }
        this._processes.delete(processId);
      }
    }
  }
}

export default RemoteManager;