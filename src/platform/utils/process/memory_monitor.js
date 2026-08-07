/**
 * 内存监控模块
 * 
 * 监控系统内存使用情况，防止 OOM 导致进程突然退出
 * 
 * 【功能】
 * 1. 监控堆内存使用率（V8 heap）
 * 2. 监控 RSS（物理内存）使用率
 * 3. 当内存超过阈值时触发警告
 * 4. 尝试执行强制垃圾回收
 */

import v8 from "node:v8";
import process from "node:process";

export class MemoryMonitor {
  constructor(options = {}) {
    this.warningThreshold = options.warningThreshold || 0.8;  // 80% 警告
    this.criticalThreshold = options.criticalThreshold || 0.9; // 90% 严重
    this.intervalMs = options.intervalMs || 30000; // 30秒检查一次
    this.logger = options.logger || console;
    
    // RSS 限制（默认 2GB）
    this.rssLimit = options.rssLimit || 2 * 1024 * 1024 * 1024;
    this.rssWarningThreshold = options.rssWarningThreshold || 2; // 200%
    this.rssCriticalThreshold = options.rssCriticalThreshold || 3; // 300%
    
    this._interval = null;
    this._maxHeapUsed = 0;
    this._maxRss = 0;
    
    // 强制 GC 间隔（默认 5 分钟）
    this._gcIntervalMs = options.gcIntervalMs || 300000;
    this._lastGC = 0;
  }

  start() {
    if (this._interval) return;
    
    this.logger.info('[MemoryMonitor] 启动内存监控', {
      rssLimit: this._formatBytes(this.rssLimit),
      gcIntervalMs: this._gcIntervalMs,
      globalGcAvailable: !!global.gc
    });
    
    this._interval = setInterval(() => {
      this._checkMemory();
    }, this.intervalMs).unref();
    
    // 立即检查一次
    this._checkMemory();
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
      this.logger.info('[MemoryMonitor] 停止内存监控');
    }
  }

  _checkMemory() {
    try {
      const heapStats = v8.getHeapStatistics();
      const memUsage = process.memoryUsage();
      
      const heapUsed = heapStats.used_heap_size;
      const heapTotal = heapStats.heap_size_limit;
      const heapPercent = heapUsed / heapTotal;
      
      const rss = memUsage.rss;
      this._maxHeapUsed = Math.max(this._maxHeapUsed, heapUsed);
      this._maxRss = Math.max(this._maxRss, rss);
      
      const stats = {
        heapUsed: this._formatBytes(heapUsed),
        heapTotal: this._formatBytes(heapTotal),
        heapPercent: (heapPercent * 100).toFixed(1) + '%',
        rss: this._formatBytes(rss),
        rssLimit: this._formatBytes(this.rssLimit),
        rssPercent: ((rss / this.rssLimit) * 100).toFixed(1) + '%',
        maxHeapUsed: this._formatBytes(this._maxHeapUsed),
        maxRss: this._formatBytes(this._maxRss),
        external: this._formatBytes(memUsage.external || 0),
        arrayBuffers: this._formatBytes(memUsage.arrayBuffers || 0)
      };
      
      // 记录到日志
      // this.logger.info('[MemoryMonitor] 内存状态', stats);
      
      let shouldGC = false;
      let warningLevel = null;
      
      // 检查堆内存
      if (heapPercent > this.criticalThreshold) {
        warningLevel = 'critical';
        this.logger.error('[MemoryMonitor] 堆内存严重不足！', {
          heapPercent: (heapPercent * 100).toFixed(1) + '%',
          ...stats
        });
        shouldGC = true;
      } else if (heapPercent > this.warningThreshold) {
        warningLevel = 'warning';
        this.logger.warn('[MemoryMonitor] 堆内存使用率较高', {
          heapPercent: (heapPercent * 100).toFixed(1) + '%',
          ...stats
        });
      }
      
      // 检查 RSS（关键：V8 不回收的物理内存）
      const rssPercent = rss / this.rssLimit;
      if (rssPercent > this.rssCriticalThreshold) {
        warningLevel = 'critical';
        this.logger.info('[MemoryMonitor] RSS 物理内存严重不足！', {
          rssPercent: (rssPercent * 100).toFixed(1) + '%',
          rss: stats.rss,
          limit: stats.rssLimit,
          ...stats
        });
        shouldGC = true;
      } else if (rssPercent > this.rssWarningThreshold) {
        if (!warningLevel) warningLevel = 'warning';
        this.logger.debug('[MemoryMonitor] RSS 物理内存使用率较高', {
          rssPercent: (rssPercent * 100).toFixed(1) + '%',
          rss: stats.rss,
          limit: stats.rssLimit,
          ...stats
        });
      }
      
      // 定期执行强制 GC（即使内存使用率不高）
      const now = Date.now();
      if (this._gcIntervalMs > 0 && now - this._lastGC > this._gcIntervalMs) {
        // this.logger.info('[MemoryMonitor] 触发定期强制垃圾回收');
        shouldGC = true;
        this._lastGC = now;
      }
      
      // 执行强制 GC
      if (shouldGC && global.gc) {
        const beforeGC = process.memoryUsage();
        this.logger.warn('[MemoryMonitor] 执行强制垃圾回收', {
          reason: warningLevel === 'critical' ? '内存严重不足' : 
                  warningLevel === 'warning' ? '内存使用率较高' : '定期清理'
        });
        
        try {
          global.gc();
          
          // 记录 GC 效果
          setTimeout(() => {
            const afterGC = process.memoryUsage();
            const freed = {
              heap: Math.max(0, beforeGC.heapUsed - afterGC.heapUsed),
              rss: Math.max(0, beforeGC.rss - afterGC.rss)
            };
            this.logger.info('[MemoryMonitor] 垃圾回收完成', {
              heapBefore: this._formatBytes(beforeGC.heapUsed),
              heapAfter: this._formatBytes(afterGC.heapUsed),
              heapFreed: this._formatBytes(freed.heap),
              rssBefore: this._formatBytes(beforeGC.rss),
              rssAfter: this._formatBytes(afterGC.rss),
              rssFreed: this._formatBytes(freed.rss)
            });
          }, 100);
        } catch (gcErr) {
          this.logger.error('[MemoryMonitor] 强制垃圾回收失败', {
            error: gcErr?.message, stack: gcErr?.stack, name: gcErr?.name, code: gcErr?.code
          });
        }
      }
      
    } catch (err) {
      this.logger.error('[MemoryMonitor] 检查内存失败', { error: err.message, stack: err.stack, name: err?.name, code: err?.code });
    }
  }

  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  getStats() {
    const heapStats = v8.getHeapStatistics();
    const memUsage = process.memoryUsage();
    
    return {
      heap: {
        used: heapStats.used_heap_size,
        total: heapStats.heap_size_limit,
        percent: heapStats.used_heap_size / heapStats.heap_size_limit
      },
      rss: {
        used: memUsage.rss,
        limit: this.rssLimit,
        percent: memUsage.rss / this.rssLimit
      },
      maxHeapUsed: this._maxHeapUsed,
      maxRss: this._maxRss
    };
  }
}

// 全局实例
let globalMonitor = null;

export function startGlobalMemoryMonitor(options = {}) {
  if (!globalMonitor) {
    globalMonitor = new MemoryMonitor(options);
  }
  globalMonitor.start();
  return globalMonitor;
}

export function stopGlobalMemoryMonitor() {
  if (globalMonitor) {
    globalMonitor.stop();
  }
}
