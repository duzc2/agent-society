# ComputeScheduler 计算调度器

## 1. 职责

系统级计算调度器，协程式时间片调度：
- 从 MessageBus 拉取消息，转换成 TurnEngine 的 Turn 入队
- 用 round-robin 策略调度 agent 的 step（每次最多推进 1 个原子动作）
- 对 LLM/tool 这类长操作采用"启动异步→完成回调入队"的方式，避免 await 占用调度循环

设计约束：
- 不直接解析 LLM/tool 业务数据，由 TurnEngine 决定下一步动作
- 不在调度器中持久占用 CPU，每轮循环让出事件循环

## 2. 内部结构

### 2.1 核心状态

**运行状态**
- _running: boolean - 是否正在运行
- _stopRequested: boolean - 是否请求停止
- _loopPromise: Promise|null - 调度循环的 Promise

**就绪队列**
- _readyQueue: Array<string> - agentId 队列（FIFO）
- _readySet: Set<string> - 用于去重检查
- _rrCursor: number - round-robin 游标

**进行中跟踪**
- _inFlight: Map<agentId, {kind, epoch, turnId, stepId}>
  - kind: 'llm' | 'tool' | 'endpoint'
  - epoch: CancelScope 的 epoch
  - turnId: 关联的 turn ID
  - stepId: 关联的 step ID

## 3. 调度循环

### 3.1 start/stop

**start()**
- 如果 _loopPromise 已存在，直接返回
- 设置 _running = true, _stopRequested = false
- 启动 _loop()，不阻塞调用方

**stop()**
- 设置 _stopRequested = true
- 循环会在下一轮检查并退出

**cancelInFlight(agentId)**
- 删除指定 agent 的 _inFlight 条目
- 用于 stop 后允许新消息立即恢复处理

### 3.2 _loop 主循环

```
while (!_stopRequested):
  1. 投递到期延迟消息：bus.deliverDueMessages()
  2. 摄取消息到 Turn：_ingestMessagesToTurns()
  3. 执行一个 step：_runOneStep()
  4. 空闲等待：
     - 如果没有进展且没有待处理消息且没有 in-flight：等待消息 100ms
     - 如果没有进展但有 in-flight：睡眠 5ms
  5. 让出事件循环：setImmediate
```

## 4. 消息摄取

### 4.1 _ingestMessagesToTurns

流程：
1. 获取所有 agent IDs：runtime._agents.keys()
2. 从 _rrCursor 开始轮询（round-robin）
3. 对于每个 agentId：
   - 如果 _stopRequested，跳出
   - 如果在 _inFlight 中，跳过
   - 如果状态为 stopping/terminating，跳过
   - 从 bus 接收消息：bus.receiveNext(agentId)
   - 如果没有消息，继续
   - 获取 agent 对象
   - 构建上下文：runtime._buildAgentContext(agent)
   - 设置 ctx.currentMessage = msg
   - 如果是 user agent：
     - 调用 _dispatchEndpointMessage（直接投递，不走 TurnEngine）
   - 否则：
     - 如果状态为 stopped，设为 idle
     - 调用 turnEngine.enqueueMessageTurn(agentId, ctx, msg)
     - 触发记忆检查：void turnEngine.maybeUpdateMemory(agentId, msg)（不阻塞）
     - _markReady(agentId)
4. _rrCursor = (_rrCursor + 1) % agentIds.length

### 4.2 _dispatchEndpointMessage

用于 user 端点智能体：
1. 获取当前 epoch
2. 设置 _inFlight：{ kind: "endpoint", epoch, turnId: null, stepId: null }
3. Promise.resolve().then(async () => {
   - 调用 agent.onMessage(ctx, msg)
}).catch(...).finally(() => {
   - 如果 epoch 匹配，删除 _inFlight
})

## 5. Step 执行

### 5.1 _runOneStep

流程：
1. 从就绪队列取出一个 agentId：_takeReady()
2. 如果没有，返回 false
3. 如果 agent 不存在：
   - 清理 _inFlight
   - 清理 TurnEngine
   - 取消活跃处理标记
   - 设置状态为 idle
   - 返回 false
4. 如果在 _inFlight 中，返回 false
5. 如果状态为 stopped/stopping/terminating，返回 false
6. 创建 CancelScope：runtime._cancelManager.newScope(agentId)
7. 调用 turnEngine.step(agentId, cancelScope)
8. 根据 outcome.kind 处理：
   - noop：如果有 runnable，_markReady；否则 _maybeSetIdle
   - done：同上
   - send：调用 bus.send(outcome.message)，然后同上
   - need_llm：调用 _startLlm(agentId, outcome, cancelScope)
   - need_tool：调用 _startTool(agentId, outcome, cancelScope)

### 5.2 _markReady

- 如果已在 _readySet 中，直接返回
- 加入 _readySet
- 推入 _readyQueue

### 5.3 _takeReady

- 从 _readyQueue shift 一个 agentId
- 从 _readySet 删除
- 返回 agentId 或 null

### 5.4 _maybeSetIdle

空闲智能体状态收敛为 idle：
- 如果 agentId 为空，返回
- 如果在 _inFlight 中，返回
- 如果 TurnEngine 有 runnable，返回
- 如果消息队列深度 > 0，返回
- 如果状态已经是 stopping/stopped/terminating，返回
- 如果状态已经是 idle，返回
- 设置状态为 idle

## 6. LLM 执行

### 6.1 _startLlm

流程：
1. 获取 LLM 客户端：runtime.getLlmClientForAgent(agentId)
2. 如果没有客户端：
   - 调用 turnEngine.onLlmError
   - _markReady(agentId)
   - 返回
3. 重新构建 system prompt（捕获动态变化）：
   - 获取 messages = outcome.request?.messages ?? []
   - 如果 messages[0].role === "system"：
     - 调用 runtime._buildSystemPromptForAgent(outcome.ctx) 获取新 system prompt
     - 如果与 messages[0].content 不同，更新之
     - 记录 debug 日志（新旧长度）
4. 构造消息摘要用于日志：
   - 获取 firstMsg = messages[0]
   - 获取 lastMsg = messages[messages.length - 1]
   - 如果 firstMsg.content 不是字符串，记录错误日志
   - 构造 firstMsgSummary: { role, contentPreview }
   - 构造 lastMsgSummary: { role, contentPreview（截断200字符）}
5. 记录 info 日志：{ agentId, turnId, stepId, messageCount, firstMessage, lastMessage }
6. 获取 epoch = cancelScope?.epoch ?? runtime._cancelManager?.getEpoch(agentId) ?? 0
7. 设置 _inFlight：{ kind: "llm", epoch, turnId, stepId }
8. 设置状态：waiting_llm，标记活跃处理
9. 调用 llmClient.chat(outcome.request)

回调处理：

.then((msg) => {
  - 检查 epoch 是否一致
  - 不一致时根据 reason 调用 onLlmCancelled 或 onLlmError
  - 一致时调用 onLlmResult，设置状态为 processing
})

.catch((err) => {
  - 同样的 epoch 检查
  - 一致时调用 onLlmError，设置状态为 idle
})

.finally(() => {
  - 如果 epoch 匹配，删除 _inFlight
  - 持久化对话
  - 取消活跃处理标记
  - 如果有 runnable，_markReady；否则 _maybeSetIdle
})

## 7. 工具执行

### 7.1 _startTool

流程：
1. 获取 epoch
2. 设置 _inFlight：{ kind: "tool", epoch, turnId, stepId }
3. 设置状态：processing，标记活跃处理
4. Promise.resolve().then(async () => {
   - 提取 toolName, callId, args
   - 调用 runtime.executeToolCall(ctx, toolName, args)
}).then((result) => {
  - 检查 epoch
  - 调用 turnEngine.onToolResult
}).catch((err) => {
  - 检查 epoch
  - 调用 turnEngine.onToolError
  - 设置状态为 idle
}).finally(() => {
  - 同 LLM 的 finally
})

## 8. 记忆触发

在 _ingestMessagesToTurns 中，消息入队后：
- 调用 turnEngine.maybeUpdateMemory(agentId, msg)
- 使用 void 不阻塞调度循环
- 使用 .catch 捕获异常
