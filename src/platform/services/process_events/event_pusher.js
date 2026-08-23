/**
 * 进程事件推送器（平台级服务，localcmd / remote 共用）
 *
 * 订阅 ProcessManager / RemoteManager 的进程事件，按"最小推送间隔"批量聚合后，
 * 通过 runtime.bus.send() 推送给进程所属智能体（from="localcmd"），
 * 使智能体无需轮询 localcmd_get_status / localcmd_read_output 即可感知进程变化。
 *
 * 【推送规则】（对应需求）
 * 1. 同一进程的事件按真实发生顺序聚合，推送文本标注每个事件的真实时间（formatLocalTime）
 * 2. 日志有更新才推送：无事件时不启动定时器、不发送任何数据
 * 3. 最小推送间隔 intervalMs（默认 30 秒）：首个事件到达启动定时器，到点批量推送
 * 4. 进程退出（exit 事件）立即推送，不等节流定时器
 * 5. 日志过多时只推送最新 maxLines（150）行且不超过 maxBytes（2KB），
 *    并告知跳过的行范围（相对进程输出累计行号），便于智能体用 localcmd_read_output 主动查询
 *
 * 【铁律】构造函数与 shutdown() 不触碰 runtime.bus（既有测试的 mockRuntime 无 bus），
 * 仅在 _flush() 内推送时惰性访问 this.runtime.bus。
 */
import { formatLocalTime } from "../../utils/logger/logger.js";

export class ProcessEventPusher {
  /**
   * @param {{runtime: any, log: any, intervalMs?: number, maxLines?: number,
   *          maxBytes?: number, maxBatchEvents?: number}} options
   *  - runtime: 提供 bus（惰性访问，仅 _flush 时使用）
   *  - intervalMs: 最小推送间隔毫秒数，默认 30000
   *  - maxLines: 单次推送最多输出行数，默认 150
   *  - maxBytes: 单次推送"最新输出"内容块字节上限（UTF-8），默认 2048
   *  - maxBatchEvents: 单进程批次内存上限（事件数），超出丢弃最旧行并计入跳过数，默认 1000
   */
  constructor({ runtime, log, intervalMs = 30000, maxLines = 150, maxBytes = 2048, maxBatchEvents = 1000 }) {
    this.runtime = runtime;
    this.log = log;
    this.intervalMs = intervalMs;
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
    this.maxBatchEvents = maxBatchEvents;

    /** @type {Map<string, {agentId: string, events: object[], pendingLine: string, timer: any|null, terminal: boolean, totalLinesSeen: number, droppedCount: number, pushedLines: number}>} */
    this._batches = new Map();
    this._closed = false;
  }

  /**
   * 处理来自进程管理器的事件（ProcessManager/RemoteManager 的监听器入口）。
   * @param {{processId: string, agentId?: string, pushEvents?: boolean, type: string,
   *          text?: string, pid?: number|null, status?: string, exitCode?: number|null,
   *          signal?: string|null, error?: string|null, command?: string, args?: string[], ts: number}} evt
   */
  onEvent(evt) {
    if (this._closed) {
      void this.log.debug("[ProcessEventPusher] 已关闭，忽略事件", { processId: evt?.processId ?? null, type: evt?.type ?? null });
      return;
    }
    // 外部数据过滤：无归属智能体或显式关闭推送（pushEvents=false）的事件不推送
    if (!evt || evt.pushEvents === false || !evt.agentId) {
      void this.log.debug("[ProcessEventPusher] 事件被过滤", {
        processId: evt?.processId ?? null,
        type: evt?.type ?? null,
        pushEvents: evt?.pushEvents,
        agentId: evt?.agentId
      });
      return;
    }

    const { processId } = evt;
    let batch = this._batches.get(processId);
    if (!batch) {
      batch = {
        agentId: evt.agentId,
        events: [],
        pendingLine: "",
        timer: null,
        terminal: false,
        totalLinesSeen: 0,
        droppedCount: 0,
        pushedLines: 0
      };
      this._batches.set(processId, batch);
    } else if (evt.agentId !== batch.agentId) {
      // 异常情形：同一 processId 归属变化（理论不发生），保留先到者
      void this.log.warn("[ProcessEventPusher] 进程归属变化，忽略事件", { processId, from: batch.agentId, to: evt.agentId });
      return;
    }

    if (batch.terminal) {
      void this.log.debug("[ProcessEventPusher] 进程已终止，忽略后续事件", { processId, type: evt.type });
      return;
    }

    if (evt.type === "log") {
      // 按换行切分累积：以换行结尾的段为完整行，否则挂起等待下个数据块拼接
      // （行号与 read_output 文件内容一致；交互式进程的无换行输出在 exit 时补入）
      const text = evt.text ?? "";
      const all = batch.pendingLine + text;
      const parts = all.split("\n");
      if (text.endsWith("\n")) {
        // 末尾空段是行结束标记，不作为一行（中间空行是真实空行，保留）
        parts.pop();
        batch.pendingLine = "";
      } else {
        batch.pendingLine = parts.pop() ?? "";
      }
      for (const line of parts) {
        this._pushLogLine(batch, line, evt.ts);
      }
      this._ensureTimer(processId, batch);
      return;
    }

    if (evt.type === "started") {
      batch.events.push({ type: "started", pid: evt.pid ?? null, ts: evt.ts });
      this._ensureTimer(processId, batch);
      return;
    }

    if (evt.type === "exit") {
      // 进程结束：未以换行结尾的残留行作为最后一行补入
      if (batch.pendingLine !== "") {
        this._pushLogLine(batch, batch.pendingLine, evt.ts);
        batch.pendingLine = "";
      }
      batch.events.push({
        type: "exit",
        status: evt.status ?? "unknown",
        exitCode: evt.exitCode ?? null,
        signal: evt.signal ?? null,
        error: evt.error ?? null,
        ts: evt.ts
      });
      // 需求 4：进程退出立即推送，不等节流定时器
      this._flush(processId);
      return;
    }

    void this.log.warn("[ProcessEventPusher] 未知事件类型", { processId, type: evt.type });
  }

  /**
   * 将一行日志入队（超出内存上限时丢弃最旧行并计数）。
   * @param {object} batch
   * @param {string} line
   * @param {number} ts
   * @private
   */
  _pushLogLine(batch, line, ts) {
    if (batch.events.length >= this.maxBatchEvents) {
      batch.events.shift();
      batch.droppedCount += 1;
    }
    batch.events.push({ type: "log", text: line, ts });
    batch.totalLinesSeen += 1;
  }

  /**
   * 确保批次定时器存在（首次事件到达时启动，到点批量推送；无事件不启动）。
   * @param {string} processId
   * @param {object} batch
   * @private
   */
  _ensureTimer(processId, batch) {
    if (batch.timer !== null) {return;}
    batch.timer = setTimeout(() => {
      const b = this._batches.get(processId);
      if (b) {this._flush(processId);}
    }, this.intervalMs);
    // 定时器不得阻止进程退出（模块 shutdown 在部分路径未接线，unref 兜底）
    batch.timer.unref?.();
  }

  /**
   * 立即推送指定进程的待处理事件（同步执行，幂等）。
   * @param {string} processId
   * @private
   */
  _flush(processId) {
    const batch = this._batches.get(processId);
    if (!batch || batch.events.length === 0) {return;}

    if (batch.timer !== null) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }

    // 快照并清空（同步代码，无竞态；flush 之后到达的事件落入新批次并重新起定时器）
    const events = batch.events.splice(0);
    const dropped = batch.droppedCount;
    batch.droppedCount = 0;

    const terminalNow = events.some(e => e.type === "exit");
    if (terminalNow) {batch.terminal = true;}

    const { text, pushedLines, skippedLines } = this._formatBatch(processId, batch, events, dropped);
    if (!text) {return;}

    try {
      const result = this.runtime.bus.send({ to: batch.agentId, from: "localcmd", payload: { text } });
      if (result && result.ok === false) {
        void this.log.error("[ProcessEventPusher] 消息发送失败", { processId, agentId: batch.agentId, error: result.error });
      }
    } catch (err) {
      void this.log.error("[ProcessEventPusher] 推送失败", {
        processId,
        agentId: batch.agentId,
        error: err?.message ?? String(err),
        stack: err?.stack,
        name: err?.name
      });
    }

    batch.pushedLines += pushedLines;
    void this.log.info("[ProcessEventPusher] 已推送", {
      processId,
      agentId: batch.agentId,
      events: events.length,
      pushedLines,
      skippedLines,
      intervalMs: this.intervalMs,
      terminal: terminalNow
    });
  }

  /**
   * 组装单条推送文本（标题 + 事件时间线 + 截断后的最新输出 + 跳过提示）。
   * @param {string} processId
   * @param {object} batch
   * @param {object[]} events - 本批事件快照（按到达顺序）
   * @param {number} dropped - 本批因内存上限被丢弃的行数
   * @returns {{text: string, pushedLines: number, skippedLines: number}}
   * @private
   */
  _formatBatch(processId, batch, events, dropped) {
    const started = events.find(e => e.type === "started") ?? null;
    const logs = events.filter(e => e.type === "log");
    const exit = events.find(e => e.type === "exit") ?? null;

    const lines = [];
    // 进程 ID 必须完整展示（智能体据此对应日志与调用查询工具）；命令是智能体自己 spawn 的，无需重复
    lines.push(`【localcmd 进程事件推送】进程 ${processId}`);
    lines.push("事件时间线：");
    if (started) {
      lines.push(`- ${formatLocalTime(new Date(started.ts))} 已启动${started.pid ? `（pid ${started.pid}）` : ""}`);
    }
    if (logs.length > 0) {
      lines.push(`- ${formatLocalTime(new Date(logs[0].ts))} ~ ${formatLocalTime(new Date(logs[logs.length - 1].ts))} 新增输出 ${logs.length} 行`);
    }
    if (exit) {
      const exitCodeText = exit.exitCode !== null && exit.exitCode !== undefined
        ? `, exitCode: ${exit.exitCode}`
        : ", exitCode: 未知";
      lines.push(`- ${formatLocalTime(new Date(exit.ts))} 已结束（status: ${exit.status}${exitCodeText}${exit.signal ? `, signal: ${exit.signal}` : ""}${exit.error ? `, 错误: ${exit.error}` : ""}）`);
    }

    // 截断：最新 maxLines 行 且不超过 maxBytes（UTF-8 字节）
    const kept = this._truncate(logs);
    const totalNew = logs.length + dropped;
    const pushed = kept.length;
    const skipped = totalNew - pushed;

    if (pushed > 0) {
      const bytes = Buffer.byteLength(kept.join("\n"), "utf8");
      lines.push(`最新输出（本批最后 ${pushed} 行，约 ${(bytes / 1024).toFixed(1)}KB）：`);
      lines.push(...kept);
    }

    if (skipped > 0) {
      const startLine = batch.totalLinesSeen - totalNew + 1;
      const endLine = batch.totalLinesSeen - pushed;
      lines.push(`【已跳过】本次进程输出新增 ${totalNew} 行，仅推送最后 ${pushed} 行（跳过第 ${startLine}~${endLine} 行）；自启动累计推送 ${batch.pushedLines + pushed} 行。`);
      lines.push(`如需查看被跳过或完整输出，请调用 localcmd_read_output(processId="${processId}", offset=0, window=5000) 从文件开头读取（按返回的 nextOffset 继续），或读取末尾：offset=totalLength-window。`);
    }

    lines.push("（此消息为系统自动推送，仅在需要时采取行动，无需向用户回复）");
    return { text: lines.join("\n"), pushedLines: pushed, skippedLines: skipped };
  }

  /**
   * 截断日志行列表：空行不展示；先按行数取最新 maxLines 行，再按字节从头部删行
   * （保留最新语义）；单行仍超限时取该行尾部并标记（绝不产生空推送）。
   * @param {object[]} logs - log 事件列表
   * @returns {string[]} 保留展示的日志行
   * @private
   */
  _truncate(logs) {
    const visible = logs.filter(l => l.text !== "").map(l => l.text);
    if (visible.length === 0) {return [];}

    const kept = visible.slice(-this.maxLines);
    let bytes = Buffer.byteLength(kept.join("\n"), "utf8");
    while (bytes > this.maxBytes && kept.length > 1) {
      kept.shift();
      bytes = Buffer.byteLength(kept.join("\n"), "utf8");
    }
    if (bytes > this.maxBytes) {
      kept[0] = this._truncateLine(kept[0]);
    }
    return kept;
  }

  /**
   * 截断单行日志到预算内（取尾部），追加截断标记。
   * @param {string} line
   * @returns {string}
   * @private
   */
  _truncateLine(line) {
    const marker = "…[片段过长已截断]";
    const markerBytes = Buffer.byteLength(marker, "utf8");
    const target = Math.max(1, this.maxBytes - markerBytes);
    let s = "";
    for (let i = line.length - 1; i >= 0; i--) {
      const candidate = line[i] + s;
      if (Buffer.byteLength(candidate, "utf8") > target) {break;}
      s = candidate;
    }
    return s + marker;
  }

  /**
   * 关闭推送器：清除所有定时器并尽力推送剩余批次；之后的事件一律忽略。
   */
  shutdown() {
    if (this._closed) {return;}
    this._closed = true;
    const remaining = this._batches.size;
    for (const processId of [...this._batches.keys()]) {
      this._flush(processId);
    }
    void this.log.info("[ProcessEventPusher] 已关闭", { remainingBatches: remaining });
  }
}
