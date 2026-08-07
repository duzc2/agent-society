/**
 * Shell会话管理器
 * 
 * 职责：
 * - 创建和管理交互式shell会话
 * - 异步接收会话输出并保存到本地文件
 * - 提供文件偏移读取功能（窗口大小5000字符）
 * - 处理并发读写，避免冲突
 * - 会话生命周期管理
 * 
 * 设计说明：
 * - 使用Map存储会话池，key为shellId，value为会话对象
 * - 输出文件存储在{dataDir}/ssh/目录
 * - 文件命名格式：YYYYMMDD-HHmmss-hostname.log
 * - 持续监听shell输出流，追加到文件
 * - 读取使用独立的文件描述符，避免与写入冲突
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Shell会话管理器类
 */
class ShellManager {
  /**
   * 构造函数
   * @param {Object} connectionManager - 连接管理器实例
   * @param {Object} runtime - 运行时实例
   * @param {Object} log - 日志对象
   */
  constructor(connectionManager, runtime, log) {
    this.connectionManager = connectionManager;
    this.runtime = runtime;
    this.log = log;
    this.shells = new Map(); // shellId -> shell对象
    this.windowSize = 5000; // 窗口大小（字符）
    this.shellCounter = 0; // 会话计数器，用于生成会话ID
  }

  /**
   * 生成唯一的会话ID
   * @returns {string} 会话ID，格式：shell_时间戳_计数器
   * @private
   */
  _generateShellId() {
    this.shellCounter++;
    return `shell_${Date.now()}_${this.shellCounter}`;
  }

  /**
   * 生成输出文件路径
   * @param {string} hostName - 主机名称
   * @param {string} agentId - 智能体ID
   * @returns {string} 输出文件路径
   * @private
   */
  _generateOutputFilePath(hostName,agentId) {
    if (hostName.includes("/") || hostName.includes("\\") || hostName.includes("..")) {
      throw new Error(`Invalid hostName: "${hostName}"`);
    }
    const timestamp = new Date().toISOString()
      .replace(/:/g, '')
      .replace(/\..+/, '')
      .replace('T', '-');
    const fileName = `${timestamp}-${hostName}.log`;
    return path.join(this.runtime.dataDir,'agents',agentId,'ssh', fileName);
  }

  /**
   * 通过主机名直接创建shell会话（自动管理连接）
   * 
   * 设计说明：
   * - 优先复用已有的连接到该主机的连接
   * - 如果没有可用连接，自动创建新连接
   * - 连接由系统自动管理，用户无需关心connectionId
   * - 记录创建者agentId，用于后续列表过滤
   * 
   * @param {string} hostName - 主机名称
   * @param {string} agentId - 创建者智能体ID
   * @returns {Promise<Object>} {shellId, hostName} 或 {error, message}
   */
  async createShellByHost(hostName, agentId) {
    try {
      this.log.debug('[ShellManager] 开始通过主机名创建shell', { hostName });

      // 1. 尝试复用已有连接
      let connectionId = null;
      const connectionsResult = this.connectionManager.listConnections();
      if (connectionsResult.ok) {
        const existingConn = connectionsResult.connections.find(
          c => c.hostName === hostName && c.status === 'connected'
        );
        if (existingConn) {
          connectionId = existingConn.connectionId;
          this.log.debug('[ShellManager] 复用已有连接', { connectionId, hostName });
        }
      }

      // 2. 没有可用连接，创建新连接
      if (!connectionId) {
        this.log.debug('[ShellManager] 没有可用连接，创建新连接', { hostName });
        const connectResult = await this.connectionManager.connect(hostName);
        if (connectResult.error) {
          return connectResult;
        }
        connectionId = connectResult.connectionId;
      }

      // 3. 用连接创建shell
      const shellResult = await this.createShell(connectionId, agentId);
      if (shellResult.error) {
        return shellResult;
      }

      // 4. 记录shell与hostName的映射，用于关闭时清理
      const shell = this.shells.get(shellResult.shellId);
      if (shell) {
        shell.hostName = hostName;
        shell.autoManaged = true; // 标记为自动管理的连接
      }

      this.log.info('[ShellManager] 通过主机名创建shell成功', {
        shellId: shellResult.shellId,
        hostName,
        connectionId
      });

      return {
        shellId: shellResult.shellId,
        hostName,
        outputFile: shellResult.outputFile
      };

    } catch (error) {
      this.log.error('[ShellManager] 通过主机名创建shell失败', {
        hostName,
        error: error.message,
        stack: error.stack
      });
      return {
        error: 'create_shell_by_host_failed',
        message: `创建shell失败: ${error.message}`
      };
    }
  }

  /**
   * 创建shell会话（内部方法，通过connectionId）
   * 
   * 设计说明：
   * - 从ConnectionManager获取连接实例
   * - 创建shell流
   * - 生成输出文件路径
   * - 启动后台监听，持续接收输出并追加到文件
   * - 记录创建者agentId
   * - 返回会话ID
   * 
   * @param {string} connectionId - 连接ID
   * @param {string} agentId - 创建者智能体ID
   * @returns {Promise<Object>} {shellId} 或 {error, message}
   */
  async createShell(connectionId, agentId) {
    if(!agentId){
      throw new Error('agentId is required to create a shell session');
    }
    try {
      this.log.debug('[ShellManager] 开始创建shell会话', { connectionId });

      // 1. 获取连接实例
      const connResult = this.connectionManager.getConnection(connectionId);
      if (connResult.error) {
        return connResult;
      }

      const connection = connResult.connection;
      const client = connection.client;

      // 2. 生成会话ID和输出文件路径
      const shellId = this._generateShellId();
      const outputFile = this._generateOutputFilePath(connection.hostName,agentId);

      // 3. 创建shell流
      const shellPromise = new Promise((resolve, reject) => {
        client.shell((err, stream) => {
          if (err) {
            this.log.error('[ShellManager] 创建shell流失败', {
              connectionId,
              error: err.message
            });
            reject(err);
            return;
          }
          resolve(stream);
        });
      });

      let stream;
      try {
        stream = await shellPromise;
      } catch (error) {
        return {
          error: 'shell_creation_failed',
          message: `创建Shell会话失败: ${error.message}`
        };
      }

      // 验证stream是否有效
      if (!stream) {
        this.log.error('[ShellManager] 创建的shell流为null', { connectionId });
        return {
          error: 'shell_creation_failed',
          message: '创建Shell会话失败: 返回的流为null'
        };
      }

      // 4. 确保输出文件所在目录存在
      const outputDir = path.dirname(outputFile);
      try {
        await fsp.mkdir(outputDir, { recursive: true });
      } catch (mkdirError) {
        this.log.error('[ShellManager] 创建输出目录失败', {
          outputDir,
          error: mkdirError.message
        });
        return {
          error: 'mkdir_failed',
          message: `创建输出目录失败: ${mkdirError.message}`
        };
      }

      // 5. 创建输出文件的写入流
      const writeStream = fs.createWriteStream(outputFile, {
        flags: 'a', // 追加模式
        encoding: 'utf8'
      });

      // 6. 定义事件处理函数（保存引用以便后续清理）
      const onData = (data) => {
        try {
          // 检查写入流是否仍然有效
          if (writeStream && !writeStream.destroyed) {
            writeStream.write(data.toString('utf8'));
          }
        } catch (e) {
          // 写入失败，可能是流已关闭，忽略错误
          this.log.debug('[ShellManager] 写入输出数据失败', { shellId, error: e.message, stack: e.stack });
        }
        // 更新连接的最后使用时间，防止被空闲清理机制断开
        this.connectionManager.updateLastUsed(connectionId);
      };

      const onStreamClose = () => {
        this.log.debug('[ShellManager] Shell流已关闭', { shellId });
        try {
          // 清理事件监听器
          stream.removeListener('data', onData);
          stream.removeListener('error', onStreamError);
          // 安全地关闭写入流
          if (writeStream && !writeStream.destroyed) {
            writeStream.end();
          }
        } catch (e) {
          this.log.warn('[ShellManager] 清理stream关闭事件监听器时出错', { shellId, error: e.message, stack: e.stack });
        }

        const shell = this.shells.get(shellId);
        if (shell) {
          shell.isActive = false;
        }
      };

      const onStreamError = (error) => {
        this.log.error('[ShellManager] Shell流发生错误', {
          shellId,
          error: error.message
        });
        try {
          // 清理事件监听器
          stream.removeListener('data', onData);
          stream.removeListener('close', onStreamClose);
          // 安全地关闭写入流
          if (writeStream && !writeStream.destroyed) {
            writeStream.end();
          }
        } catch (e) {
          this.log.warn('[ShellManager] 清理stream错误事件监听器时出错', { shellId, error: e.message, stack: e.stack });
        }

        const shell = this.shells.get(shellId);
        if (shell) {
          shell.isActive = false;
        }
      };

      // 7. 监听shell输出并写入文件
      stream.on('data', onData);
      stream.once('close', onStreamClose);
      stream.once('error', onStreamError);

      // 8. 保存会话到会话池（包含事件处理函数引用以便后续清理）
      const shell = {
        shellId,
        connectionId,
        agentId, // 记录创建者智能体ID
        stream,
        outputFile,
        writeStream,
        isActive: true,
        createdAt: new Date(),
        // 保存事件处理函数引用，用于关闭时清理
        _eventHandlers: { onData, onStreamClose, onStreamError }
      };

      this.shells.set(shellId, shell);

      // 9. 注册连接断开回调，连接断开时自动清理shell
      this.connectionManager.onDisconnect(connectionId, () => {
        this.log.debug('[ShellManager] 连接断开，自动清理shell', { shellId, connectionId });
        // 使用 void 忽略异步返回值，避免未处理的 promise
        void this._cleanupShell(shellId);
      });

      this.log.info('[ShellManager] Shell会话已创建', {
        shellId,
        connectionId,
        outputFile,
        totalShells: this.shells.size
      });

      // 10. 返回会话信息
      return {
        shellId,
        outputFile
      };

    } catch (error) {
      this.log.error('[ShellManager] 创建shell会话时发生未预期错误', {
        connectionId,
        error: error.message,
        stack: error.stack
      });

      return {
        error: 'unknown_error',
        message: `未知错误: ${error.message}`
      };
    }
  }

  /**
   * 发送命令到会话（异步，立即返回）
   * 
   * 设计说明：
   * - 检查会话是否存在且有效
   * - 写入命令到shell流
   * - 立即返回，不等待命令完成
   * 
   * @param {string} shellId - 会话ID
   * @param {string} command - 命令
   * @returns {Promise<Object>} {ok: true} 或 {error, message}
   */
  async sendCommand(shellId, command) {
    try {
      this.log.debug('[ShellManager] 发送命令', { shellId, command });

      // 1. 获取会话
      const shell = this.shells.get(shellId);
      
      if (!shell) {
        this.log.warn('[ShellManager] Shell会话不存在', { shellId });
        return {
          error: 'shell_not_found',
          message: `Shell会话不存在：${shellId}`
        };
      }

      if (!shell.isActive) {
        this.log.warn('[ShellManager] Shell会话已关闭', { shellId });
        return {
          error: 'shell_closed',
          message: `Shell会话已关闭：${shellId}`
        };
      }

      // 2. 检查流是否有效
      if (!shell.stream) {
        this.log.warn('[ShellManager] Shell流不存在', { shellId });
        return {
          error: 'shell_stream_invalid',
          message: `Shell流不存在：${shellId}`
        };
      }

      // 检查流是否可写
      if (shell.stream.writable === false) {
        this.log.warn('[ShellManager] Shell流已不可写', { shellId });
        shell.isActive = false;
        return {
          error: 'shell_stream_closed',
          message: `Shell流已关闭：${shellId}`
        };
      }

      // 3. 写入命令到shell流
      // 确保命令以换行符结尾
      const commandToSend = command.endsWith('\n') ? command : command + '\n';
      
      // 使用 try-catch 包裹 write 操作，防止底层ssh2库抛出未捕获异常
      try {
        const writeResult = shell.stream.write(commandToSend);
        this.log.debug('[ShellManager] 命令已发送', { shellId, writeResult });
      } catch (writeError) {
        this.log.error('[ShellManager] 写入命令到流失败', {
          shellId,
          error: writeError.message
        });
        shell.isActive = false;
        return {
          error: 'shell_write_failed',
          message: `写入命令失败: ${writeError.message}`
        };
      }

      return {
        ok: true
      };

    } catch (error) {
      this.log.error('[ShellManager] 发送命令失败', {
        shellId,
        command,
        error: error.message,
        stack: error.stack
      });

      return {
        error: 'send_command_failed',
        message: `发送命令失败: ${error.message}`
      };
    }
  }

  /**
   * 读取指定偏移的窗口内容
   * 
   * 设计说明：
   * - 检查会话是否存在
   * - 使用fs.open() + fs.read()从指定偏移位置读取
   * - 读取最多windowSize个字符
   * - 返回output、offset、totalLength
   * 
   * @param {string} shellId - 会话ID
   * @param {number} offset - 文件偏移位置（字节数）
   * @returns {Promise<Object>} {output, offset, totalLength} 或 {error, message}
   */
  async readOutput(shellId, offset) {
    try {
      this.log.debug('[ShellManager] 读取输出', { shellId, offset });

      // 1. 获取会话
      const shell = this.shells.get(shellId);
      
      if (!shell) {
        this.log.warn('[ShellManager] Shell会话不存在', { shellId });
        return {
          error: 'shell_not_found',
          message: `Shell会话不存在：${shellId}`
        };
      }

      // 2. 获取文件状态
      let stats;
      try {
        stats = await fsp.stat(shell.outputFile);
      } catch (error) {
        this.log.error('[ShellManager] 读取文件状态失败', {
          shellId,
          outputFile: shell.outputFile,
          error: error.message
        });
        return {
          error: 'file_read_failed',
          message: `读取文件状态失败: ${error.message}`
        };
      }

      const totalLength = stats.size;

      // 3. 如果偏移量超出文件大小，返回空内容
      if (offset >= totalLength) {
        return {
          output: '',
          offset: totalLength,
          totalLength
        };
      }

      // 4. 打开文件并读取指定窗口
      let fileHandle;
      try {
        fileHandle = await fsp.open(shell.outputFile, 'r');
        
        // 计算要读取的字节数（最多windowSize）
        const bytesToRead = Math.min(this.windowSize, totalLength - offset);
        const buffer = Buffer.alloc(bytesToRead);
        
        // 从指定偏移位置读取
        const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, offset);
        
        // 转换为字符串
        const output = buffer.toString('utf8', 0, bytesRead);
        
        this.log.debug('[ShellManager] 输出已读取', {
          shellId,
          offset,
          bytesRead,
          totalLength
        });

        return {
          output,
          offset: offset,
          totalLength
        };

      } finally {
        // 确保关闭文件句柄
        if (fileHandle) {
          await fileHandle.close();
        }
      }

    } catch (error) {
      this.log.error('[ShellManager] 读取输出失败', {
        shellId,
        offset,
        error: error.message,
        stack: error.stack
      });

      return {
        error: 'read_output_failed',
        message: `读取输出失败: ${error.message}`
      };
    }
  }

  /**
   * 内部方法：清理shell（连接断开时使用）
   * 
   * 设计说明：
   * - 当连接断开时自动调用，不尝试关闭底层连接
   * - 仅清理本地资源（流、文件句柄、事件监听器）
   * - 不返回结果，不抛异常，确保清理过程不中断
   * 
   * @param {string} shellId - 会话ID
   * @private
   */
  async _cleanupShell(shellId) {
    try {
      const shell = this.shells.get(shellId);
      if (!shell) return;

      this.log.debug('[ShellManager] 清理shell会话（连接已断开）', { shellId });

      // 清理shell流的事件监听器
      if (shell._eventHandlers) {
        shell.stream?.removeListener('data', shell._eventHandlers.onData);
        shell.stream?.removeListener('close', shell._eventHandlers.onStreamClose);
        shell.stream?.removeListener('error', shell._eventHandlers.onStreamError);
      }

      // 关闭shell流（不等待，因为连接已断开）
      if (shell.stream && shell.isActive) {
        try {
          shell.stream.close();
        } catch (e) {
          this.log.warn('[ShellManager] 关闭shell流时出错', { shellId, error: e.message, stack: e.stack });
        }
      }

      // 关闭写入流
      if (shell.writeStream) {
        try {
          shell.writeStream.end();
          shell.writeStream.destroy?.();
        } catch (e) {
          this.log.warn('[ShellManager] 关闭写入流时出错', { shellId, error: e.message, stack: e.stack });
        }
      }

      // 更新会话状态
      shell.isActive = false;

      // 从会话池中移除
      this.shells.delete(shellId);

      this.log.info('[ShellManager] Shell会话已清理（连接已断开）', {
        shellId,
        remainingShells: this.shells.size
      });
    } catch (e) {
      this.log.warn('[ShellManager] 清理shell会话时出错', { shellId, error: e.message, stack: e.stack });
    }
  }

  /**
   * 关闭会话
   * 
   * 设计说明：
   * - 检查会话是否存在
   * - 关闭shell流
   * - 关闭写入流
   * - 从会话池中移除
   * - 保留输出文件供后续查看
   * 
   * @param {string} shellId - 会话ID
   * @returns {Promise<Object>} {ok: true} 或 {error, message}
   */
  async closeShell(shellId) {
    try {
      this.log.debug('[ShellManager] 开始关闭shell会话', { shellId });

      const shell = this.shells.get(shellId);
      
      if (!shell) {
        this.log.warn('[ShellManager] Shell会话不存在', { shellId });
        return {
          error: 'shell_not_found',
          message: `Shell会话不存在：${shellId}`
        };
      }

      // 清理shell流的事件监听器
      if (shell._eventHandlers) {
        shell.stream?.removeListener('data', shell._eventHandlers.onData);
        shell.stream?.removeListener('close', shell._eventHandlers.onStreamClose);
        shell.stream?.removeListener('error', shell._eventHandlers.onStreamError);
      }

      // 关闭shell流
      if (shell.stream && shell.isActive) {
        try {
          shell.stream.end();
          this.log.debug('[ShellManager] Shell流已关闭', { shellId });
        } catch (e) {
          this.log.warn('[ShellManager] 关闭Shell流时出错', { shellId, error: e.message, stack: e.stack });
        }
      }

      // 关闭写入流
      if (shell.writeStream) {
        try {
          if (!shell.writeStream.destroyed) {
            shell.writeStream.end();
            shell.writeStream.destroy?.(); // 强制销毁流，释放资源
          }
          this.log.debug('[ShellManager] 写入流已关闭', { shellId });
        } catch (e) {
          this.log.warn('[ShellManager] 关闭写入流时出错', { shellId, error: e.message, stack: e.stack });
        }
      }

      // 更新会话状态
      shell.isActive = false;

      // 从会话池中移除
      this.shells.delete(shellId);

      // 如果是自动管理的连接，检查是否还有其他shell使用，没有则断开
      if (shell.autoManaged && shell.connectionId) {
        const hasOtherShells = Array.from(this.shells.values()).some(
          s => s.connectionId === shell.connectionId
        );
        if (!hasOtherShells) {
          this.log.debug('[ShellManager] 自动断开空闲连接', { 
            connectionId: shell.connectionId,
            hostName: shell.hostName 
          });
          // 使用 void 忽略返回值，连接可能已经断开
          void this.connectionManager.disconnect(shell.connectionId);
        }
      }

      this.log.info('[ShellManager] Shell会话已关闭并移除', {
        shellId,
        remainingShells: this.shells.size
      });

      return {
        ok: true
      };

    } catch (error) {
      this.log.error('[ShellManager] 关闭shell会话失败', {
        shellId,
        error: error.message,
        stack: error.stack
      });

      return {
        error: 'close_shell_failed',
        message: `关闭Shell会话失败: ${error.message}`
      };
    }
  }

  /**
   * 列出指定智能体创建的Shell会话
   * 
   * 设计说明：
   * - 返回指定智能体创建的所有shell会话列表
   * - 包含会话ID、主机名、状态、创建时间等信息
   * - 不包含敏感信息（如输出文件完整路径）
   * - 用于智能体查看自己已创建的shell会话
   * 
   * @param {string} agentId - 智能体ID
   * @returns {Object} {ok: true, shells: Array} 或 {error, message}
   */
  listShells(agentId) {
    try {
      this.log.debug('[ShellManager] 列出智能体的shell会话', { agentId, totalShells: this.shells.size });

      // 过滤出指定智能体创建的shell
      const shells = Array.from(this.shells.values())
        .filter(shell => shell.agentId === agentId)
        .map(shell => ({
          shellId: shell.shellId,
          hostName: shell.hostName || 'unknown',
          connectionId: shell.connectionId,
          isActive: shell.isActive,
          createdAt: shell.createdAt instanceof Date ? shell.createdAt.toISOString() : null
        }));

      return {
        ok: true,
        shells
      };
    } catch (error) {
      this.log.error('[ShellManager] 列出shell会话失败', {
        agentId,
        error: error.message,
        stack: error.stack
      });

      return {
        error: 'list_shells_failed',
        message: `列出shell会话失败: ${error.message}`
      };
    }
  }

  /**
   * 清理所有会话
   * 
   * 设计说明：
   * - 遍历所有会话并逐个关闭
   * - 清空会话池
   * - 用于模块关闭时的资源清理
   * 
   * @returns {Promise<void>}
   */
  async cleanup() {
    try {
      this.log.info('[ShellManager] 开始清理所有shell会话', {
        count: this.shells.size
      });

      const shellIds = Array.from(this.shells.keys());
      
      for (const shellId of shellIds) {
        await this.closeShell(shellId);
      }

      this.log.info('[ShellManager] 所有shell会话已清理');

    } catch (error) {
      this.log.error('[ShellManager] 清理shell会话时发生错误', {
        error: error.message,
        stack: error.stack
      });
    }
  }
}

export default ShellManager;
