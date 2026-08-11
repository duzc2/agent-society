/**
 * ComputeScheduler - 系统级计算调度器（协程式时间片）
 *
 * 职责：
 * - 从 MessageBus 拉取消息，转换成 TurnEngine 的 Turn 入队；
 * - 用 round-robin 策略调度 agent 的 step（每次最多推进 1 个原子动作）；
 * - 对 LLM/tool 这类长操作采用"启动异步→完成回调入队"的方式，避免 await 占用调度循环。
 *
 * 设计约束：
 * - 不直接解析 LLM/tool 业务数据；由 TurnEngine 决定下一步动作。
 * - 不在调度器中持久占用 CPU：每轮循环需要让出事件循环。
 */
/** 工具名 -> 中文标签映射，供前端显示 */
const TOOL_LABEL_MAP = {
  file_read_lines: "按行读取文件",
  file_search: "搜索文件内容",
  file_line_count: "获取文件行数",
  edit_file: "编辑文件",
  replace_file: "写入文件",
  append_file: "追加文件",
  list_files: "浏览目录",
  delete_file: "删除文件",
  move_file: "移动文件",
  run_javascript: "执行 JavaScript",
  http_request: "发送 HTTP 请求",
  send_message: "发送消息",
  spawn_agent_with_task: "创建子智能体",
  execute_python: "执行 Python",
  search_file: "搜索文件",
  search_content: "搜索内容",
  web_search: "网页搜索",
  web_fetch: "获取网页",
};

export class ComputeScheduler {
  /**
   * @param {any} runtime
   * @param {any} turnEngine
   */
  constructor(runtime, turnEngine) {
    this.runtime = runtime;
    this.turnEngine = turnEngine;
    // 注意：这里不能缓存 runtime.log，因为 Runtime 在 init() 后会替换 this.log
    // 使用 getter 动态获取最新的 logger

    this._running = false;
    this._stopRequested = false;
    this._loopPromise = null;

    /** @type {string[]} */
    this._readyQueue = [];
    /** @type {Set<string>} */
    this._readySet = new Set();

    /** @type {Map<string, {kind:'llm'|'tool'|'endpoint', epoch:number, turnId:string|null, stepId:number|null}>} */
    this._inFlight = new Map();

    this._rrCursor = 0;

    // 作为外部引用的 runningPromise getter（供 ShutdownManager 等待循环结束）
    Object.defineProperty(this, 'runningPromise', {
      get() { return this._loopPromise || null; },
      enumerable: true,
      configurable: true,
    });

    // 调度循环错误恢复：连续失败计数器（指数退避用）
    this._loopFailures = 0;

    // LLM 重试配置
    this._maxLlmRetries = 3;        // 最大重试次数
    this._llmRetryBaseMs = 2000;    // 基础退避间隔 (毫秒)
    this._llmRetryMaxBackoffMs = 30000; // 最大退避间隔

    // RetryCoordinator: 复用 runtime 上的全局重试协调器（bootstrap 阶段已创建，必须存在）
    this._retryCoordinator = runtime._retryCoordinator;

  }

  /**
   * 启动常驻调度循环（不阻塞调用方）。
   * 内置错误恢复：若 _loop() 因未处理异常崩溃，自动以指数退避重启。
   * @returns {void}
   */
  start() {
    if (this._loopPromise) return;
    this._running = true;
    this._stopRequested = false;
    this._loopPromise = this._runLoopWithRecovery();
  }

  /**
   * 请求停止调度循环。
   */
  stop() {
    this._stopRequested = true;
  }

  /**
   * 丢弃某个 agent 的 inFlight 占位（用于 stop 后允许新消息立即恢复处理）。
   * @param {string} agentId
   */
  cancelInFlight(agentId) {
    if (!agentId) return;
    this._inFlight.delete(agentId);
  }

  /**
   * 主动唤醒指定智能体进入调度队列。
   * 用于"重新生成最后一条回复"这类不是由 MessageBus 新消息触发的流程。
   * @param {string} agentId
   */
  scheduleAgent(agentId) {
    this._markReady(agentId);
  }

  /**
   * 主动唤醒指定智能体并立即处理其队列中的消息。
   * 用于"生成回复"按钮等场景，需要立即触发处理而不是等待调度循环。
   * @param {string} agentId
   */
  wakeUpAndProcess(agentId) {
    void this.runtime.log.info("[ComputeScheduler] wakeUpAndProcess 调用", {
      agentId,
      readyQueueSize: this._readyQueue.length,
      inFlight: this._inFlight.has(agentId) ? this._inFlight.get(agentId).kind : null,
      timestamp: Date.now(),
      time: new Date().toISOString()
    });
    this._markReady(agentId);

    // 直接调用 _ingestMessagesToTurns 和 _runOneStep 处理该 agent
    // 使用 setImmediate 在下一个事件循环 tick 中调度，避免与主 _loop() 并发执行导致状态竞争
    setImmediate(async () => {
      try {
        await this._ingestMessagesToTurns();
        await this._runOneStep();
      } catch (err) {
        void this.runtime.log.error("[ComputeScheduler.wakeUpAndProcess] 处理失败", {
          agentId,
          error: err?.message ?? String(err),
          stack: err?.stack,
          name: err?.name,
          code: err?.code
        });
      }
    });
  }

  /**
   * 调度循环主体。
   * @private
   */
  async _loop() {
    void this.runtime.log.info("ComputeScheduler 开始运行");

    let loopIteration = 0;
    let lastHeartbeatTime = Date.now();

    while (!this._stopRequested) {
      loopIteration++;
      const loopStart = Date.now();
      const sinceLastHeartbeat = loopStart - lastHeartbeatTime;
      lastHeartbeatTime = loopStart;

      // 心跳日志：每 100 轮或间隔超过 1 秒时打印
      const shouldHeartbeat = loopIteration % 100 === 0 || sinceLastHeartbeat > 1000;

      if (shouldHeartbeat) {
        void this.runtime.log.debug("[ComputeScheduler] 调度循环心跳", {
          iteration: loopIteration,
          readyCount: this._readyQueue.length,
          inFlightCount: this._inFlight.size,
          delayedCount: this.runtime.bus.getDelayedCount(),
          pendingCount: this.runtime.bus.getPendingCount(),
          sinceLastHeartbeatMs: sinceLastHeartbeat,
          timestamp: loopStart,
          time: new Date(loopStart).toISOString()
        });
      }

      this.runtime.bus.deliverDueMessages();

      await this._ingestMessagesToTurns();

      const progressed = await this._runOneStep();

      // 每周期摘要日志（debug 级别，追踪调度状态）
      void this.runtime.log.debug("[ComputeScheduler] 周期完成", {
        iteration: loopIteration,
        progressed,
        readyCount: this._readyQueue.length,
        inFlightCount: this._inFlight.size,
        inFlightAgents: [...this._inFlight.entries()].map(([id, inf]) => ({
          agentId: id,
          kind: inf.kind,
          epoch: inf.epoch
        })),
        pendingCount: this.runtime.bus.getPendingCount(),
        delayedCount: this.runtime.bus.getDelayedCount(),
        cycleMs: Date.now() - loopStart,
        timestamp: Date.now()
      });

      if (!progressed && !this.runtime.bus.hasPending() && this._inFlight.size === 0) {
        await this.runtime.bus.waitForMessage({ timeoutMs: 100 });
      } else if (!progressed) {
        await new Promise((r) => { const t = setTimeout(r, 5); t?.unref?.(); });
      }

      await new Promise((r) => setImmediate(r));
    }

    this._running = false;
    void this.runtime.log.info("ComputeScheduler 已停止");
  }

  /**
   * 调度循环的错误恢复包装器。
   * 当 _loop() 因未处理异常崩溃时，清理污染状态并以指数退避重启。
   * 正常停止 (_stopRequested=true) 时不触发恢复逻辑。
   * @private
   */
  async _runLoopWithRecovery() {
    const MAX_BACKOFF_MS = 30000; // 最大退避 30 秒

    while (!this._stopRequested) {
      try {
        this._loopFailures = 0;
        await this._loop();
      } catch (err) {
        this._loopFailures++;

        // 指数退避：1s -> 2s -> 4s -> 8s -> 16s -> 30s (封顶)
        const backoffMs = Math.min(
          1000 * Math.pow(2, Math.min(this._loopFailures - 1, 5)),
          MAX_BACKOFF_MS
        );

        void this.runtime.log.error("[ComputeScheduler] 调度循环异常崩溃，将清理状态并重启", {
          failureCount: this._loopFailures,
          backoffMs,
          error: err?.message ?? String(err),
          stack: err?.stack?.substring(0, 500)
        });

        // 清理崩溃可能污染的状态，确保重启时从干净状态开始
        // inFlight 清理是安全的：已注册的回调仍会执行，仅按 epoch 做静默忽略
        this._inFlight.clear();
        this._readyQueue.length = 0;
        this._readySet.clear();
        this._rrCursor = 0;

        if (this._stopRequested) break;

        await new Promise(r => setTimeout(r, backoffMs));

        if (this._stopRequested) break;

        void this.runtime.log.info("[ComputeScheduler] 调度循环重启", {
          failureCount: this._loopFailures
        });
      }
    }

    this._loopFailures = 0;
    this._loopPromise = null;
    this._running = false;
    void this.runtime.log.info("[ComputeScheduler] 调度循环已退出");
  }

  /**
   * 从 MessageBus 拉取消息，转换为 Turn 入队，并把 agent 加入 ready 队列。
   * @private
   */
  async _ingestMessagesToTurns() {
    const agentIds = [...this.runtime._agents.keys()];
    if (agentIds.length === 0) {
      this.runtime.log.debug('[ComputeScheduler] agentIds 为空，直接返回');
      return;
    }

    for (let i = 0; i < agentIds.length; i += 1) {
      const idx = (this._rrCursor + i) % agentIds.length;
      const agentId = agentIds[idx];
      this.runtime.log.debug('[ComputeScheduler] 处理 agent', { agentId, idx, i });

      if (this._stopRequested) {
        this.runtime.log.debug('[ComputeScheduler] stopRequested，跳出循环');
        break;
      }
      // 【关键】即使 agent 正在 LLM/tool 调用中，仍需要 drainAll 捕获新消息
      // 并追加到活跃 Turn 的 conv 中，防止消息在 FIFO 队列中积压。
      let existingInflight = this._inFlight.get(agentId);
      // 自愈：清理 stale "turning"（agent 无排队/活跃 Turn 时自动清除）
      if (existingInflight?.kind === 'turning' && !this.turnEngine.hasRunnable(agentId)) {
        void this.runtime.log.info("[ComputeScheduler] 清理 stale turning inFlight", {
          agentId,
          timestamp: Date.now()
        });
        this._inFlight.delete(agentId);
        existingInflight = null;
      }
      if (existingInflight) {
        // 【关键】agent 已有 Turn 在处理中（无论 kind），新消息应通过中断追加
        const queueDepth = this.runtime.bus.getQueueDepth(agentId);
        if (queueDepth > 0) {
          this.runtime.log.info('[ComputeScheduler] inFlight agent 队列有消息，尝试 drainAll', {
            agentId,
            kind: existingInflight.kind,
            queueDepth,
            timestamp: Date.now(),
            time: new Date().toISOString()
          });
        }
        const turnEntry = this.turnEngine._byAgentId.get(agentId);
        // 优先取 activeTurn，若无则取队列中第一个 Turn（刚创建、尚未成为 active）
        const targetTurn = turnEntry?.activeTurn ?? turnEntry?.queue?.[0] ?? null;
        if (targetTurn) {
          const hadMessages = await this._checkAndApplyInterruptions(agentId, targetTurn);
          if (hadMessages) {
            this.runtime.log.info('[ComputeScheduler] inFlight 期间 drainAll 捕获新消息完成', {
              agentId,
              kind: existingInflight.kind,
              turnId: targetTurn.turnId,
              timestamp: Date.now()
            });
            this._markReady(agentId);
          }
        }
        continue;
      }

      // 【关键】inFlight 为空，但 agent 已有排队 Turn（enqueueMessageTurn 已创建但 _runOneStep 尚未 pickup）。
      // 此时新到达的消息必须追加到已有 Turn，否则会创建重复 Turn 导致消息顺序错乱。
      if (!existingInflight && this.turnEngine.hasRunnable(agentId)) {
        const queueDepth = this.runtime.bus.getQueueDepth(agentId);
        if (queueDepth > 0) {
          this.runtime.log.info('[ComputeScheduler] hasRunnable 但无 inFlight，队列有消息，追加到已有 Turn', {
            agentId,
            queueDepth,
            timestamp: Date.now(),
            time: new Date().toISOString()
          });
          const turnEntry = this.turnEngine._byAgentId.get(agentId);
          const targetTurn = turnEntry?.activeTurn ?? turnEntry?.queue?.[0] ?? null;
          if (targetTurn) {
            const hadMessages = await this._checkAndApplyInterruptions(agentId, targetTurn);
            if (hadMessages) {
              this.runtime.log.info('[ComputeScheduler] hasRunnable 消息已追加到已有 Turn', {
                agentId,
                turnId: targetTurn.turnId,
                activeTurn: !!turnEntry?.activeTurn,
                timestamp: Date.now()
              });
              this._markReady(agentId);
            }
          }
        }
        continue;
      }

      const status = this.runtime._state.getAgentComputeStatus(agentId);
      if (status === "stopping" || status === "terminating") {
        this.runtime.log.debug('[ComputeScheduler] agent 状态为 stopping/terminating，跳过', { agentId, status });
        continue;
      }

      // 使用 drainAll 原子排空：一次性取走所有消息，合并为单个 Turn
      const messages = this.runtime.bus.drainAll(agentId);
      if (messages.length === 0) {
        continue;
      }

      const primaryMessage = messages[messages.length - 1]; // 最新消息作为主要消息
      const messageIds = messages.map(m => {
        const payloadPreview = typeof m.payload === 'object' && m.payload !== null
          ? (m.payload.text ?? JSON.stringify(m.payload).substring(0, 150))
          : String(m.payload ?? '').substring(0, 150);
        return { id: m.id, from: m.from, taskId: m.taskId ?? null, payloadPreview };
      });

      this.runtime.log.info('[ComputeScheduler] _ingestMessagesToTurns drainAll 获取消息', {
        agentId,
        count: messages.length,
        primaryMessageId: primaryMessage?.id,
        messages: messageIds,
        inFlight: this._inFlight.has(agentId) ? this._inFlight.get(agentId).kind : null,
        timestamp: Date.now(),
        time: new Date().toISOString()
      });

      const agent = this.runtime._agents.get(agentId);
      if (!agent) {
        this.runtime.log.debug('[ComputeScheduler] agent 对象不存在，跳过', { agentId });
        continue;
      }

      const ctx = this.runtime._buildAgentContext(agent);
      ctx.currentMessage = primaryMessage;

      if (agentId === "user" || agent?.roleName === "user" || agent?.roleId === "user") {
        this.runtime.log.debug('[ComputeScheduler] user agent，使用 _dispatchEndpointMessage', { agentId });
        this._dispatchEndpointMessage(agentId, agent, ctx, primaryMessage);
      } else {
        this.runtime.log.debug('[ComputeScheduler] 普通 agent，准备 enqueueMessageTurn（批量）', { agentId, count: messages.length });
        if (status === "stopped") {
          this.runtime._state.setAgentComputeStatus(agentId, "idle");
        }
        // 【关键】消息到达时立即设置 computeStatus，让前端立即显示停止按钮
        if (status !== "processing" && status !== "waiting_llm") {
          this.runtime._state.setAgentComputeStatus(agentId, "processing");
          this.runtime._state.setAgentComputePhase(agentId, "正在准备...");
        }
        // 标记为活跃处理（并发控制）
        this.runtime._state.markAgentAsActivelyProcessing(agentId);

        // 传递批量消息给 TurnEngine，init 阶段会格式化所有消息
        await this.turnEngine.enqueueMessageTurn(agentId, ctx, messages);

        // 【触发记忆】智能体收到消息后，检查是否累积10条需要处理
        this.runtime.log.info('[ComputeScheduler] 准备调用 maybeUpdateMemory', { agentId });

        // 为记忆处理创建独立的 cancelScope
        const memoryCancelScope = this.runtime._cancelManager.newScope(agentId) ?? null;

        (async () => {
          try {
            await new Promise(resolve => setTimeout(resolve, 0));
            this.runtime._state.setAgentComputePhase(agentId, "正在加载记忆...");
            try {
              await this.turnEngine.maybeUpdateMemory(agentId, primaryMessage, memoryCancelScope);
            } catch (err) {
              if (err?.name === 'AbortError' || memoryCancelScope?.signal?.aborted) {
                this.runtime.log.info('[ComputeScheduler] maybeUpdateMemory 被取消', { agentId });
                return;
              }
              this.runtime.log.error('[ComputeScheduler] maybeUpdateMemory 异常', {
                agentId,
                error: err?.message || String(err),
                stack: err?.stack,
                name: err?.name,
                code: err?.code
              });
            } finally {
              this.runtime._state.setAgentComputePhase(agentId, "正在准备...");
            }
          } catch (outerErr) {
            this.runtime.log.error('[ComputeScheduler] 记忆处理外层异常', {
              agentId,
              error: outerErr?.message || String(outerErr),
              stack: outerErr?.stack,
              name: outerErr?.name,
              code: outerErr?.code
            });
          }
        })();

        this._markReady(agentId);
      }
    }

    this._rrCursor = (this._rrCursor + 1) % agentIds.length;
    this.runtime.log.debug('[ComputeScheduler] _ingestMessagesToTurns 执行完成');
  }

  /**
   * 将消息直接投递到 endpoint 智能体（例如 user 端点），不走 LLM/TurnEngine。
   * @param {string} agentId
   * @param {any} agent
   * @param {any} ctx
   * @param {any} msg
   * @private
   */
  _dispatchEndpointMessage(agentId, agent, ctx, msg) {
    const epoch = this.runtime._cancelManager.getEpoch(agentId) ?? 0;
    this._inFlight.set(agentId, { kind: "endpoint", epoch, turnId: null, stepId: null });

    Promise.resolve()
      .then(async () => {
        if (typeof agent?.onMessage !== "function") return;
        await agent.onMessage(ctx, msg);
      })
      .catch((err) => {
        void this.runtime.log.warn("endpoint 消息处理失败", {
          agentId,
          message: err?.message ?? String(err ?? "unknown endpoint error"),
          stack: err?.stack,
          name: err?.name,
          code: err?.code
        });
      })
      .finally(() => {
        const inflight = this._inFlight.get(agentId);
        if (inflight && inflight.kind === "endpoint" && inflight.epoch === epoch) {
          this._inFlight.delete(agentId);
        }
      });
  }

  /**
   * 推进一个 agent 的一个 step。
   * @returns {Promise<boolean>} 是否推进成功
   * @private
   */
  async _runOneStep() {
    const agentId = this._takeReady();
    if (!agentId) return false;

    const stepEntryInFlight = this._inFlight.get(agentId);
    void this.runtime.log.info("[ComputeScheduler] _runOneStep 取出 agent", {
      agentId,
      inFlightKind: stepEntryInFlight?.kind ?? null,
      inFlightEpoch: stepEntryInFlight?.epoch ?? null,
      computeStatus: this.runtime._state.getAgentComputeStatus(agentId),
      readyQueueRemaining: this._readyQueue.length,
      hasRunnable: this.turnEngine.hasRunnable(agentId),
      queueDepth: this.runtime.bus.getQueueDepth(agentId),
      turnDetails: (() => {
        const entry = this.turnEngine._byAgentId.get(agentId);
        return {
          hasActiveTurn: !!entry?.activeTurn,
          activeTurnId: entry?.activeTurn?.turnId ?? null,
          activeTurnPhase: entry?.activeTurn?.phase ?? null,
          queueLength: entry?.queue?.length ?? 0
        };
      })(),
      timestamp: Date.now(),
      time: new Date().toISOString()
    });

    if (!this.runtime._agents.has(agentId)) {
      const entry = this._inFlight.get(agentId);
      this._inFlight.delete(agentId);
      this.turnEngine.clearAgent?.(agentId);
      this.runtime._state.unmarkAgentAsActivelyProcessing(agentId);
      this.runtime._state.setAgentComputeStatus(agentId, "idle");
      return false;
    }

    // 【关键】检查是否有正在进行的 LLM 或工具调用
    // memory 类型的 inFlight 不应该阻塞正常的消息处理
    const inflight = this._inFlight.get(agentId);
    if (inflight && (inflight.kind === 'llm' || inflight.kind === 'tool')) {
      return false;
    }

    const status = this.runtime._state.getAgentComputeStatus(agentId);
    if (status === "stopped" || status === "stopping" || status === "terminating") {
      return false;
    }

    const cancelScope = this.runtime._cancelManager.newScope(agentId) ?? null;

    // 【关键】在 step() 之前标记 inFlight，关闭 ~4ms 竞态窗口。
    // 此时 Turn 已入队但尚未 active。step() 会设置 activeTurn 并执行 init/first phase。
    // 并发 _ingestMessagesToTurns 看到 "turning" 后，会将新消息追加到
    // 首个排队 Turn 的 conv（而不是创建独立 Turn）。
    this._inFlight.set(agentId, {
      kind: "turning",
      epoch: 0,
      turnId: null,
      stepId: null
    });

    this.runtime.log.info("[ComputeScheduler] turning inFlight 已设置", {
      agentId,
      timestamp: Date.now(),
      time: new Date().toISOString()
    });

    const outcome = await this.turnEngine.step(agentId, cancelScope);

    // 如果 step() 不需要 LLM/tool（即 done/send/noop），清理 turning inFlight。
    // 如果 step() 返回 need_llm/need_tool，_startLlm/_startTool 会升级 turning → llm/tool。
    if (outcome && outcome.kind !== 'need_llm' && outcome.kind !== 'need_tool') {
      const inf = this._inFlight.get(agentId);
      if (inf && inf.kind === 'turning') {
        this._inFlight.delete(agentId);
        this.runtime.log.info("[ComputeScheduler] turning inFlight 已清理（非 LLM/tool 结果）", {
          agentId,
          outcomeKind: outcome.kind,
          timestamp: Date.now()
        });
      }
    }

    if (!outcome || outcome.kind === "noop") {
      if (this.turnEngine.hasRunnable(agentId)) {
        this._markReady(agentId);
      } else {
        this._maybeSetIdle(agentId);
      }
      return false;
    }

    if (outcome.kind === "done") {
      if (this.turnEngine.hasRunnable(agentId)) {
        this._markReady(agentId);
      } else {
        this._maybeSetIdle(agentId);
      }
      return true;
    }

    if (outcome.kind === "send") {
      this.runtime.bus.send(outcome.message);
      if (this.turnEngine.hasRunnable(agentId)) {
        this._markReady(agentId);
      } else {
        this._maybeSetIdle(agentId);
      }
      return true;
    }

    if (outcome.kind === "need_llm") {
      await this._startLlm(agentId, outcome, cancelScope);
      return true;
    }

    if (outcome.kind === "need_tool") {
      this._startTool(agentId, outcome, cancelScope);
      return true;
    }

    return false;
  }

  /**
   * 发起 LLM 请求并注册完成回调。
   * @param {string} agentId
   * @param {any} outcome
   * @param {{epoch:number, signal:AbortSignal, assertActive:() => void}|null} cancelScope
   * @private
   */
  async _startLlm(agentId, outcome, cancelScope) {
    // 【关键】必须在 await 之前设置 inFlight，关闭 ~4ms 竞态窗口。
    // 否则在 getLlmClientForAgent / _ensureInitialized 的 await 间隙中，
    // _ingestMessagesToTurns 可能为新到达的消息创建独立的第二个 Turn，
    // 导致该消息从主 Turn 的 conv 中"脱落"，到达顺序错乱。
    const epoch = cancelScope?.epoch ?? this.runtime._cancelManager.getEpoch(agentId) ?? 0;
    this._inFlight.set(agentId, {
      kind: "llm",
      epoch,
      turnId: outcome.turnId,
      stepId: outcome.stepId
    });

    void this.runtime.log.info("[ComputeScheduler] _startLlm inFlight 已设置（pre-await）", {
      agentId,
      turnId: outcome.turnId,
      epoch,
      timestamp: Date.now(),
      time: new Date().toISOString()
    });

    const llmClient = await this.runtime.getLlmClientForAgent(agentId);
    if (!llmClient) {
      // 清理已设置的 inFlight
      this._inFlight.delete(agentId);
      this.turnEngine.onLlmError(agentId, {
        turnId: outcome.turnId,
        stepId: outcome.stepId,
        error: new Error("missing_llm_client")
      });
      this._markReady(agentId);
      return;
    }

    // 确保 LlmClient 已初始化，配置已加载
    await llmClient._ensureInitialized();

    // 检查模型是否支持工具调用
    const supportsToolCalling = this.runtime._llm._checkToolCallingSupport(llmClient);
    // 将支持信息存入 outcome，供 TurnEngine 在 send_text 阶段使用
    outcome.supportsToolCalling = supportsToolCalling;
    if (outcome.request?.meta) {
      outcome.request.meta.supportsToolCalling = supportsToolCalling;
    }

    // 【关键】重新构建 system prompt，以捕获 systemPromptAppendix 等动态变化
    // 传入 llmClient 以判断是否支持工具调用，从而决定是否包含 tool_rules.txt 内容
    const messages = outcome.request?.messages ?? [];
    const newSystemBase = await this.runtime._buildSystemPromptForAgent(outcome.ctx, llmClient);
    // contextStatus 临时注入 system prompt（不持久化到 conv）
    const contextStatusPrompt = await this.runtime._conversationManager.buildContextStatusPrompt(agentId);
    const contextStatusPart = contextStatusPrompt ?? "";
    outcome.request.system = `${newSystemBase}${contextStatusPart}`;

    // 临时注入 ephemeral memory + knowledge 到 messages 副本（conv 不动）
    const activeTurnForMem = this.turnEngine._byAgentId.get(agentId)?.activeTurn ?? null;
    const ephemeralMemoryContext = activeTurnForMem?.ephemeralMemoryContext;
    const ephemeralKnowledgeContext = activeTurnForMem?._ephemeralKnowledgeContext;
    const combinedEphemeral = [ephemeralMemoryContext, ephemeralKnowledgeContext].filter(Boolean).join('\n\n');
    const { messages: enhancedMessages, injectionIndex } = this.runtime._llm.appendEphemeralToMessages(messages, combinedEphemeral);
    // 替换 outcome.request.messages（仅用于本次 LLM 调用，turn.conv 不变）
    outcome.request.messages = enhancedMessages;

    // 清除上一轮残留的缓存断点，防止跨轮次累积超过 4 个断点限制
    this._clearAllCacheControl(enhancedMessages);

    // 在记忆注入前的最后一条稳定消息上设置缓存断点
    const stableCacheIdx = this._findStableMessageCacheIndex(enhancedMessages, injectionIndex);
    if (stableCacheIdx >= 0) {
      enhancedMessages[stableCacheIdx] = this._applyCacheControlToLastContentBlock(enhancedMessages[stableCacheIdx]);
    }

    // 构造消息摘要：使用增强后的消息（已注入 ephemeral memory）
    const outgoingMessages = outcome.request.messages;
    const firstMsg = outgoingMessages.length > 0 ? outgoingMessages[0] : null;
    const lastMsg = outgoingMessages.length > 0 ? outgoingMessages[outgoingMessages.length - 1] : null;
    if(typeof firstMsg.content !== 'string' ){
      void this.runtime.log.error("[ComputeScheduler] LLM 消息首条内容非文本", {
        // 业务信息：哪个 agent 在哪个回合/步骤出现了异常消息
        agentId,
        turnId: outcome.turnId,
        stepId: outcome.stepId,
        firstMsgRole: firstMsg.role,
        firstMsgType: typeof firstMsg.content,
        messageCount: outgoingMessages.length,
        // 技术信息：非文本内容本身的摘要
        contentPreview: String(firstMsg.content).substring(0, 200)
      });
    }
    const firstMsgSummary = firstMsg ? {
      role: firstMsg.role,
      contentPreview: typeof firstMsg.content === 'string' 
        ? firstMsg
        : '[非文本内容]'
    } : null;
    const lastMsgSummary = lastMsg ? {
      role: lastMsg.role,
      contentPreview: typeof lastMsg.content === 'string' 
        ? lastMsg.content.slice(0, 200) + (lastMsg.content.length > 200 ? '...' : '')
        : '[非文本内容]'
    } : null;

    const logData = {
      agentId,
      turnId: outcome.turnId,
      stepId: outcome.stepId,
      messageCount: outgoingMessages.length,
      messageRoles: outgoingMessages.map((message) => message?.role ?? "unknown"),
      firstMessage: firstMsgSummary,
      lastMessage: lastMsgSummary,
      ephemeralMemoryInjected: !!ephemeralMemoryContext,
      ephemeralKnowledgeInjected: !!ephemeralKnowledgeContext,
      contextStatusInSystem: !!contextStatusPrompt
    };
    void this.runtime.log.info("[ComputeScheduler] 准备调用 LLM", logData);

    // 【注意】inFlight 已在函数开头设置（pre-await），此处无需重复

    this.runtime._state.setAgentComputeStatus(agentId, "waiting_llm");
    this.runtime._state.setAgentComputePhase(agentId, "正在生成回复...");
    this.runtime._state.markAgentAsActivelyProcessing(agentId);

    // Pre-LLM: drainAll 检查，将 LLM 调用前到达的消息追加到 conv
    const activeTurnEntry = this.turnEngine._byAgentId.get(agentId);
    const activeTurn = activeTurnEntry?.activeTurn ?? null;
    if (activeTurn && activeTurn.turnId === outcome.turnId) {
      await this._checkAndApplyInterruptions(agentId, activeTurn);
    }

    llmClient
      .chat(outcome.request)
      .then(async (msg) => {
        const currentEpoch = this.runtime._cancelManager.getEpoch(agentId) ?? epoch;
        if (currentEpoch !== epoch) {
          const reason = this.runtime._cancelManager.getLastAbortInfo(agentId)?.reason ?? null;
          if (reason === "message_interruption") {
            this.turnEngine.onLlmCancelled(agentId, { turnId: outcome.turnId, stepId: outcome.stepId });
          } else {
            this.turnEngine.onLlmError(agentId, { turnId: outcome.turnId, stepId: outcome.stepId, error: new Error("llm_result_discarded") });
          }
          return;
        }
        if (!this.runtime._agents.has(agentId)) return;
        this.turnEngine.onLlmResult(agentId, {
          turnId: outcome.turnId,
          stepId: outcome.stepId,
          msg,
          supportsToolCalling: outcome.supportsToolCalling
        });
        this.runtime._state.setAgentComputeStatus(agentId, "processing");
        this.runtime._state.setAgentComputePhase(agentId, "正在处理...");

        // Post-LLM: drainAll 检查，将 LLM 执行期间到达的消息追加到 conv
        const postTurn = activeTurnEntry?.activeTurn ?? null;
        if (postTurn && postTurn.turnId === outcome.turnId) {
          const hadMessages = await this._checkAndApplyInterruptions(agentId, postTurn);
          if (hadMessages) {
            void this.runtime.log.info("[ComputeScheduler] post-LLM 中断：新消息已追加，重新进入 need_llm", {
              agentId,
              turnId: outcome.turnId
            });
          }
        }

        // 标记 agent 为 ready，让调度器继续处理 turn
        this._markReady(agentId);
      })
      .catch(async (err) => {
        const currentEpoch = this.runtime._cancelManager.getEpoch(agentId) ?? epoch;
        if (currentEpoch !== epoch) {
          const reason = this.runtime._cancelManager.getLastAbortInfo(agentId)?.reason ?? null;
          if (reason === "message_interruption") {
            this.turnEngine.onLlmCancelled(agentId, { turnId: outcome.turnId, stepId: outcome.stepId });
          } else {
            this.turnEngine.onLlmError(agentId, { turnId: outcome.turnId, stepId: outcome.stepId, error: err });
          }
          return;
        }
        if (!this.runtime._agents.has(agentId)) return;

        const errCategory = this._classifyLlmError(err);
        if (this._isRetryableError(errCategory)) {
          // 进入重试流程（异步等待，.finally() 将在重试结束后执行）
          await this._retryLlmCall(agentId, outcome, cancelScope, llmClient, 1, err);
          return;
        }

        this.turnEngine.onLlmError(agentId, { turnId: outcome.turnId, stepId: outcome.stepId, error: err });
        this.runtime._state.setAgentComputeStatus(agentId, "idle");
        this.runtime._state.setAgentComputePhase(agentId, null);
        this._markReady(agentId);
      })
      .finally(() => {
        const inflight = this._inFlight.get(agentId);
        if (inflight && inflight.epoch === epoch) {
          this._inFlight.delete(agentId);
        }
        this.runtime._state.setAgentComputePhase(agentId, "正在保存对话...");
        void this.runtime._conversationManager.persistConversation?.(agentId);
        this.runtime._state.unmarkAgentAsActivelyProcessing(agentId);
        if (!this.runtime._agents.has(agentId)) return;
        const status = this.runtime._state.getAgentComputeStatus(agentId);
        if (status === "stopping" || status === "stopped" || status === "terminating") return;
        if (this.turnEngine.hasRunnable(agentId)) {
          this._markReady(agentId);
        } else {
          this._maybeSetIdle(agentId);
        }
      });
  }

  /**
   * 找到应在其中放置缓存断点的"稳定消息"索引。
   * 稳定消息是记忆注入前最后一条不会被下一轮删除的消息。
   * @param {any[]} messages - 已注入临时记忆的消息数组
   * @param {number} injectionIndex - appendEphemeralToMessages 返回的注入位置（-1 表示未注入）
   * @returns {number} 应缓存的最后一条消息索引，-1 表示无足够稳定消息
   * @private
   */
  _findStableMessageCacheIndex(messages, injectionIndex) {
    if (!Array.isArray(messages) || messages.length < 2) return -1;
    // 记忆注入：记忆消息在 injectionIndex，最后一条 user 在 injectionIndex+1
    // 缓存断点放在记忆消息之前的最后一条稳定消息上
    if (injectionIndex >= 0 && injectionIndex < messages.length) {
      return injectionIndex - 1 >= 0 ? injectionIndex - 1 : -1;
    }
    // 未注入记忆：缓存倒数第二条消息
    return messages.length - 2;
  }

  /**
   * 清除所有消息上的旧缓存断点，防止跨轮次累积超过 Anthropic 的 4 个断点限制。
   * 同时清除消息级别和内容块级别的 cacheControl。
   * @param {any[]|undefined} messages
   * @private
   */
  _clearAllCacheControl(messages) {
    if (!Array.isArray(messages)) return;
    for (const msg of messages) {
      if (!msg) continue;
      // 消息级别的 cacheControl
      if (msg.providerOptions?.anthropic?.cacheControl) {
        delete msg.providerOptions.anthropic.cacheControl;
      }
      // 内容块级别的 cacheControl
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block?.providerOptions?.anthropic?.cacheControl) {
          delete block.providerOptions.anthropic.cacheControl;
        }
      }
    }
  }

  /**
   * 在消息的最后一个内容块上设置 ephemeral 缓存断点。
   * 将字符串 content 转换为 content block 数组以支持 providerOptions。
   * 返回深拷贝，避免 mutation 泄露到 turn.conv 中的原始消息对象。
   * @param {any} message
   * @returns {any} 深拷贝后的新消息对象
   * @private
   */
  _applyCacheControlToLastContentBlock(message) {
    if (!message) return message;
    // 深拷贝，防止 mutation 泄露到 turn.conv
    const copy = structuredClone(message);
    if (typeof copy.content === "string") {
      copy.content = [{ type: "text", text: copy.content }];
    }
    if (!Array.isArray(copy.content) || copy.content.length === 0) return copy;
    const lastBlock = copy.content[copy.content.length - 1];
    if (typeof lastBlock === "object" && lastBlock !== null) {
      lastBlock.providerOptions = {
        ...(lastBlock.providerOptions || {}),
        anthropic: {
          ...(lastBlock.providerOptions?.anthropic || {}),
          cacheControl: { type: "ephemeral" }
        }
      };
    }
    return copy;
  }

  /**
   * 对 LLM 调用错误进行分类，用于判断是否可重试。
   * @param {Error|any} err
   * @returns {'network'|'rate_limit'|'server'|'auth'|'content'|'context_length'|'not_found'|'cancel'|'unknown'}
   * @private
   */
  _classifyLlmError(err) {
    const message = (err?.message ?? String(err ?? '')).toLowerCase();
    const status = err?.status ?? err?.statusCode ?? err?.responseStatus ?? null;

    // 取消/中止类错误（用户主动停止）
    if (err?.name === 'AbortError' || err?.name === 'CancelError' || this._matchAny(message, ['abort', 'cancel', 'aborted', 'cancelled'])) {
      return 'cancel';
    }

    // 认证/授权错误
    if (status === 401 || status === 403 || this._matchAny(message, ['unauthorized', 'forbidden', 'invalid api key', 'incorrect api key', 'authentication', 'not authenticated'])) {
      return 'auth';
    }

    // 内容策略/审核错误
    if (status === 400 && this._matchAny(message, ['content', 'moderation', 'safety', 'policy', 'inappropriate', 'harmful'])) {
      return 'content';
    }

    // 上下文长度超限
    if (status === 400 && this._matchAny(message, ['context length', 'token limit', 'too long', 'maximum context', 'reduce the length', 'max_tokens', 'context_length_exceeded'])) {
      return 'context_length';
    }

    // 模型/资源不存在
    if (status === 404 || this._matchAny(message, ['not found', 'does not exist', 'no such model', 'model not found'])) {
      return 'not_found';
    }

    // 速率限制
    if (status === 429 || this._matchAny(message, ['rate limit', 'too many requests', 'throttl', 'quota'])) {
      return 'rate_limit';
    }

    // 服务器错误 (5xx)
    if (status !== null && status >= 500 && status < 600) {
      return 'server';
    }

    // 网络错误
    if (this._matchAny(message, ['fetch failed', 'network', 'timeout', 'econnrefused', 'econnreset', 'enotfound', 'etimedout', 'socket', 'dns', 'connection', 'connect error', 'tls', 'ssl', 'certificate'])) {
      return 'network';
    }

    // 空响应 / 流中断
    if (this._matchAny(message, ['no response', 'empty response', 'stream', 'unexpected end', 'incomplete'])) {
      return 'network';
    }

    return 'unknown';
  }

  /**
   * 判断错误类型是否可重试。
   * @param {string} errCategory
   * @returns {boolean}
   * @private
   */
  _isRetryableError(errCategory) {
    return errCategory === 'network' || errCategory === 'server' || errCategory === 'rate_limit';
  }

  /**
   * 对消息进行多关键词匹配。
   * @param {string} message
   * @param {string[]} keywords
   * @returns {boolean}
   * @private
   */
  _matchAny(message, keywords) {
    for (let i = 0; i < keywords.length; i++) {
      if (message.includes(keywords[i])) return true;
    }
    return false;
  }

  /**
   * LLM 调用重试循环（指数退避 + 停止检测）。
   * 重试期间 agent 状态为 "retrying"，用户可通过停止按钮中断。
   * @param {string} agentId
   * @param {any} outcome
   * @param {{epoch:number}|null} cancelScope
   * @param {any} llmClient
   * @param {number} retryCount 当前是第几次重试（1-based）
   * @param {Error|any} lastError
   * @returns {Promise<void>}
   * @private
   */
  async _retryLlmCall(agentId, outcome, cancelScope, llmClient, retryCount, lastError) {
    const epoch = cancelScope?.epoch ?? this.runtime._cancelManager.getEpoch(agentId) ?? 0;

    // 设置重试状态
    this.runtime._state.setAgentComputeStatus(agentId, "retrying");
    this.runtime._state.setAgentComputePhase(agentId, `正在重试 (${retryCount}/${this._maxLlmRetries})...`);

    void this.runtime.log.warn("[ComputeScheduler] LLM 调用失败，准备重试", {
      agentId,
      retryCount,
      maxRetries: this._maxLlmRetries,
      error: lastError?.message ?? String(lastError ?? ''),
      stack: lastError?.stack,
      name: lastError?.name,
      code: lastError?.code
    });

    // 使用 RetryCoordinator 计算槽位错开的退避时间，避免惊群效应
    const backoffMs = this._retryCoordinator.scheduleRetry(agentId, retryCount);
    await new Promise(r => setTimeout(r, backoffMs));

    // 退避后检查是否被停止
    const afterWaitEpoch = this.runtime._cancelManager.getEpoch(agentId) ?? epoch;
    if (afterWaitEpoch !== epoch) {
      void this.runtime.log.info("[ComputeScheduler] 重试被用户停止", { agentId, retryCount });
      return;
    }
    if (!this.runtime._agents.has(agentId)) return;

    // 执行重试
    try {
      const msg = await llmClient.chat(outcome.request);

      // 重试成功，检查 epoch
      const afterLlmEpoch = this.runtime._cancelManager.getEpoch(agentId) ?? epoch;
      if (afterLlmEpoch !== epoch) {
        void this.runtime.log.info("[ComputeScheduler] 重试期间被停止，丢弃结果", { agentId, retryCount });
        return;
      }
      if (!this.runtime._agents.has(agentId)) return;

      void this.runtime.log.info("[ComputeScheduler] LLM 重试成功", { agentId, retryCount });
      this.turnEngine.onLlmResult(agentId, {
        turnId: outcome.turnId,
        stepId: outcome.stepId,
        msg,
        supportsToolCalling: outcome.supportsToolCalling
      });
      this.runtime._state.setAgentComputeStatus(agentId, "processing");
      this.runtime._state.setAgentComputePhase(agentId, "正在处理...");
      this._markReady(agentId);
    } catch (err) {
      // 重试也失败了，检查 epoch
      const afterErrEpoch = this.runtime._cancelManager.getEpoch(agentId) ?? epoch;
      if (afterErrEpoch !== epoch) {
        void this.runtime.log.info("[ComputeScheduler] 重试期间被停止", { agentId, retryCount });
        return;
      }
      if (!this.runtime._agents.has(agentId)) return;

      const errCategory = this._classifyLlmError(err);

      if (retryCount < this._maxLlmRetries && this._isRetryableError(errCategory)) {
        // 继续重试
        await this._retryLlmCall(agentId, outcome, cancelScope, llmClient, retryCount + 1, err);
      } else {
        // 重试耗尽或遇到不可重试错误
        void this.runtime.log.warn("[ComputeScheduler] LLM 重试耗尽", {
          agentId,
          totalAttempts: retryCount + 1,
          errorCategory: errCategory,
          error: err?.message ?? String(err ?? ''),
          stack: err?.stack,
          name: err?.name,
          code: err?.code
        });
        this.turnEngine.onLlmError(agentId, {
          turnId: outcome.turnId,
          stepId: outcome.stepId,
          error: err
        });
        this.runtime._state.setAgentComputeStatus(agentId, "idle");
        this.runtime._state.setAgentComputePhase(agentId, null);
        this._markReady(agentId);
      }
    }
  }

  /**
   * 发起工具执行并注册完成回调。
   * @param {string} agentId
   * @param {any} outcome
   * @param {{epoch:number, signal:AbortSignal, assertActive:() => void}|null} cancelScope
   * @private
   */
  _startTool(agentId, outcome, cancelScope) {
    const epoch = cancelScope?.epoch ?? this.runtime._cancelManager.getEpoch(agentId) ?? 0;
    this._inFlight.set(agentId, {
      kind: "tool",
      epoch,
      turnId: outcome.turnId,
      stepId: outcome.stepId
    });

    const rawToolName = outcome?.call?.toolName ?? "unknown_tool";
    const toolLabel = TOOL_LABEL_MAP[rawToolName] || rawToolName;
    this.runtime._state.setAgentComputeStatus(agentId, "processing");
    this.runtime._state.setAgentComputePhase(agentId, `正在执行工具: ${toolLabel}`);
    this.runtime._state.markAgentAsActivelyProcessing(agentId);

    // 【关键】在工具执行前发出通知，让前端显示"正在执行"状态
    // 移至此处确保状态已设为 processing，避免前端 UI 闪烁
    try {
      this.runtime._emitToolCall({
        agentId,
        toolName: outcome.call.toolName,
        args: outcome.call.args,
        result: null, // 尚未有结果
        taskId: outcome.ctx.currentMessage?.taskId ?? null,
        callId: outcome.call.callId,
        timestamp: new Date().toISOString(),
        reasoningContent: outcome.reasoningContent ?? null,
        usage: null // 尚未消耗 token
      });
    } catch (err) {
      this.runtime.log.warn('[ComputeScheduler] 发送工具开始通知失败', {
        agentId,
        error: err.message,
        stack: err.stack,
        name: err?.name,
        code: err?.code
      });
    }

    // 【调试日志】打印工具调用的原始参数
    const debugToolName = outcome?.call?.toolName ?? null;
    const debugCallId = outcome?.call?.callId ?? null;
    const debugArgs = outcome?.call?.args ?? {};
    void this.runtime.log.info("[TOOL_CALL_RAW] 工具调用原始参数", {
      agentId,
      toolName: debugToolName,
      callId: debugCallId,
      argsType: typeof debugArgs,
      argsKeys: debugArgs ? Object.keys(debugArgs) : [],
      argsRaw: JSON.stringify(debugArgs),
      turnId: outcome.turnId,
      stepId: outcome.stepId
    });

    Promise.resolve()
      .then(async () => {
        const toolName = outcome?.call?.toolName ?? null;
        const callId = outcome?.call?.callId ?? null;
        const args = outcome?.call?.args ?? {};
        if (!toolName || !callId) {
          throw new Error("invalid_tool_call");
        }
        return await this.runtime.executeToolCall(outcome.ctx, toolName, args);
      })
      .then((result) => {
        const currentEpoch = this.runtime._cancelManager.getEpoch(agentId) ?? epoch;
        if (currentEpoch !== epoch) return;
        if (!this.runtime._agents.has(agentId)) return;
        this.turnEngine.onToolResult(agentId, {
          turnId: outcome.turnId,
          stepId: outcome.stepId,
          callId: outcome.call.callId,
          result
        });
      })
      .catch((err) => {
        const currentEpoch = this.runtime._cancelManager.getEpoch(agentId) ?? epoch;
        if (currentEpoch !== epoch) return;
        if (!this.runtime._agents.has(agentId)) return;
        this.turnEngine.onToolError(agentId, {
          turnId: outcome.turnId,
          stepId: outcome.stepId,
          callId: outcome?.call?.callId ?? "",
          error: err
        });
        this.runtime._state.setAgentComputeStatus(agentId, "idle");
        this.runtime._state.setAgentComputePhase(agentId, null);
      })
      .finally(async () => {
        const inflight = this._inFlight.get(agentId);
        if (inflight && inflight.epoch === epoch) {
          this._inFlight.delete(agentId);
        }
        this.runtime._state.setAgentComputePhase(agentId, "正在保存对话...");
        void this.runtime._conversationManager.persistConversation?.(agentId);
        this.runtime._state.unmarkAgentAsActivelyProcessing(agentId);
        if (!this.runtime._agents.has(agentId)) return;
        const status = this.runtime._state.getAgentComputeStatus(agentId);
        if (status === "stopping" || status === "stopped" || status === "terminating") return;

        // Post-tool: drainAll 检查，将工具执行期间到达的消息追加到 conv
        const postToolTurn = this.turnEngine._byAgentId.get(agentId)?.activeTurn ?? null;
        if (postToolTurn) {
          await this._checkAndApplyInterruptions(agentId, postToolTurn);
        }

        if (this.turnEngine.hasRunnable(agentId)) {
          this._markReady(agentId);
        } else {
          this._maybeSetIdle(agentId);
        }
      });
  }

  /**
   * 检查并应用中断消息：drainAll → 格式化 → 追加到 conv。
   * @param {string} agentId
   * @param {any} turn - 活跃的 Turn 对象
   * @returns {Promise<boolean>} 是否有新消息被追加
   * @private
   */
  async _checkAndApplyInterruptions(agentId, turn) {
    // 【关键】如果 Turn 仍在 init 阶段（init 未运行），先运行 init：
    // 将 turn.batchMessages / turn.message 格式化后推入 conv。
    // 否则 step() 看到 phase="need_llm" 会跳过 init，导致首条消息丢失。
    if (turn.phase === "init") {
      void this.runtime.log.info("[ComputeScheduler] _checkAndApplyInterruptions 先运行未完成的 init 阶段", {
        agentId,
        turnId: turn.turnId,
        convLengthBefore: turn.conv.length,
        timestamp: Date.now()
      });
      const batchMessages = Array.isArray(turn.batchMessages) ? turn.batchMessages : (turn.message ? [turn.message] : []);
      for (let i = 0; i < batchMessages.length; i++) {
        try {
          const msg = batchMessages[i];
          const formatted = await this.runtime._formatMessageForLlm(turn.ctx, msg);
          turn.conv.push({ role: "user", content: formatted, id: msg.id });
        } catch (err) {
          void this.runtime.log.error("[ComputeScheduler] init 阶段格式化 batchMessage 失败", {
            agentId,
            turnId: turn.turnId,
            messageId: batchMessages[i]?.id ?? null,
            error: err?.message ?? String(err),
            stack: err?.stack
          });
        }
      }
      // 构建临时记忆上下文（不持久化到 conv）
      if (batchMessages.length > 0) {
        turn.ephemeralMemoryContext = await this.runtime._llm.buildEphemeralContexts(turn.ctx, batchMessages[batchMessages.length - 1]);
      }
      // 手动运行 init 后，必须将 phase 推进到 need_llm，防止 step() 再次执行 init 导致重复
      turn.phase = "need_llm";
      void this.runtime.log.info("[ComputeScheduler] init 阶段完成", {
        agentId,
        turnId: turn.turnId,
        batchCount: batchMessages.length,
        convLengthAfter: turn.conv.length,
        newPhase: turn.phase,
        timestamp: Date.now()
      });
    }

    const messages = this.runtime.bus.drainAll(agentId);
    if (messages.length === 0) return false;

    void this.runtime.log.info("[ComputeScheduler] _checkAndApplyInterruptions 开始处理中断", {
      agentId,
      turnId: turn.turnId,
      count: messages.length,
      convLengthBefore: turn.conv.length,
      timestamp: Date.now(),
      time: new Date().toISOString()
    });

    for (const msg of messages) {
      try {
        const payloadPreview = typeof msg.payload === 'object' && msg.payload !== null
          ? (msg.payload.text ?? JSON.stringify(msg.payload).substring(0, 200))
          : String(msg.payload ?? '').substring(0, 200);
        const formatted = await this.runtime._formatMessageForLlm(turn.ctx, msg);
        turn.conv.push({ role: "user", content: formatted, id: msg.id });
        void this.runtime.log.info("[ComputeScheduler] 中断消息已追加到 conv", {
          agentId,
          turnId: turn.turnId,
          messageId: msg.id,
          from: msg.from,
          taskId: msg.taskId ?? null,
          payloadPreview,
          convLengthAfter: turn.conv.length,
          timestamp: Date.now()
        });
      } catch (err) {
        void this.runtime.log.error("[ComputeScheduler] 中断消息格式化失败", {
          agentId,
          messageId: msg?.id ?? null,
          error: err?.message ?? String(err),
          stack: err?.stack,
          name: err?.name,
          code: err?.code
        });
      }
    }
    turn.phase = "need_llm";
    void this.runtime.log.info("[ComputeScheduler] _checkAndApplyInterruptions 完成", {
      agentId,
      turnId: turn.turnId,
      count: messages.length,
      convLengthAfter: turn.conv.length,
      phase: turn.phase,
      timestamp: Date.now()
    });
    return true;
  }

  /**
   * 将空闲智能体的 computeStatus 收敛为 idle，避免 UI 长期显示"处理中/等待"。
   * @param {string} agentId
   * @private
   */
  _maybeSetIdle(agentId) {
    if (!agentId) return;
    if (this._inFlight.has(agentId)) return;
    if (this.turnEngine.hasRunnable(agentId)) return;
    const queueDepth = this.runtime.bus.getQueueDepth(agentId) ?? 0;
    if (queueDepth > 0) {
      // 【关键】队列中有待处理消息时，将 agent 重新加入就绪队列，
      // 保持"有工作就应在 readyQueue 中"的不变量。
      // 否则 agent 会被遗忘，直到 _ingestMessagesToTurns() 在下一轮循环中重新发现它，
      // 而中间可能因状态变化（stopping/terminating 或 inFlight）导致永久阻塞。
      this._markReady(agentId);
      return;
    }

    const status = this.runtime._state.getAgentComputeStatus(agentId);
    if (status === "stopping" || status === "stopped" || status === "terminating") return;
    if (status === "retrying") return;
    if (!status || status === "idle") return;
    
    // [DEBUG] 记录为何设置为 idle
    // this.runtime.log.debug(`[ComputeScheduler] 设置 agent ${agentId} 为 idle`, {
    //   inFlight: this._inFlight.has(agentId),
    //   hasRunnable: this.turnEngine.hasRunnable(agentId),
    //   queueDepth
    // });
    
    this.runtime._state.setAgentComputeStatus(agentId, "idle");
    this.runtime._state.setAgentComputePhase(agentId, null);

    // 检查岗位设置是否启用了知识树
    const agent = this.runtime._agents.get(agentId);
    let knowledgeTreeEnabled = true;
    if (agent) {
      if (agent.roleId === "root") {
        knowledgeTreeEnabled = false;
      } else {
        const role = this.runtime.org.getRole(agent.roleId);
        if (role?.knowledgeTreeEnabled === false) {
          knowledgeTreeEnabled = false;
        }
      }
    }

    // 对话回合结束后检查是否需要自动提取知识（后台任务，不改变 phase）
    if (knowledgeTreeEnabled) {
      this.runtime.knowledgeTree?.checkAndExtract(agentId).catch(err => {
        this.runtime.log.warn("[ComputeScheduler] 知识树提取检查失败", {
          agentId,
          error: err.message,
          stack: err.stack,
          name: err?.name,
          code: err?.code
        });
      });
      // 知识树维护：独立于提取的存量整理过程，有自己的触发阈值和状态游标
      this.runtime.knowledgeTree?.checkAndMaintain(agentId).catch(err => {
        this.runtime.log.warn("[ComputeScheduler] 知识树维护检查失败", {
          agentId,
          error: err.message,
          stack: err.stack,
          name: err?.name,
          code: err?.code
        });
      });
    }
  }

  /**
   * 将 agent 标记为可运行（加入 ready 队列，去重）。
   * @param {string} agentId
   * @private
   */
  _markReady(agentId) {
    if (!agentId) return;
    if (this._readySet.has(agentId)) {
      void this.runtime.log.debug("[ComputeScheduler] _markReady 跳过（已在队列中）", {
        agentId,
        readyQueueSize: this._readyQueue.length,
        timestamp: Date.now()
      });
      return;
    }
    this._readySet.add(agentId);
    this._readyQueue.push(agentId);
    void this.runtime.log.info("[ComputeScheduler] _markReady agent 加入就绪队列", {
      agentId,
      readyQueueSize: this._readyQueue.length,
      inFlightKind: this._inFlight.get(agentId)?.kind ?? null,
      timestamp: Date.now(),
      time: new Date().toISOString()
    });
  }

  /**
   * 取出一个 ready agent。
   * @returns {string|null}
   * @private
   */
  _takeReady() {
    while (this._readyQueue.length > 0) {
      const agentId = this._readyQueue.shift();
      this._readySet.delete(agentId);
      if (!agentId) continue;
      return agentId;
    }
    return null;
  }

}
