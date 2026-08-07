# AgentCancelManager 智能体取消管理器

## 1. 职责

为每个 agent 提供取消/停止信号管理：
1. 提供单调递增的 epoch（世代号），用于判定"结果是否过期"
2. 提供 AbortSignal，用于中止 in-flight 的 LLM/HTTP 等异步请求
3. 统一取消语义：递增 epoch + abort 当前 signal

关键约束：
- 任何需要强取消语义的模块，在发起异步请求前应捕获 epoch
- 在 await 返回后校验 epoch，若不一致则丢弃结果

## 2. 内部结构

### 2.1 核心数据结构

**_byAgentId: Map<agentId, {epoch, controller, lastReason, lastAt}>**

每个 agent 的状态：
- epoch: number - 当前世代号，初始为 0
- controller: AbortController - 当前控制器
- lastReason: string|null - 最后一次取消原因
- lastAt: string|null - 最后一次取消时间（ISO格式）

## 3. 核心方法

### 3.1 getEpoch(agentId)

- 如果 agentId 为空，返回 0
- 调用 _ensure(agentId) 确保条目存在
- 返回 entry.epoch

### 3.2 getSignal(agentId)

- 如果 agentId 为空，返回 null
- 调用 _ensure(agentId)
- 返回 entry.controller.signal

### 3.3 getLastAbortInfo(agentId)

- 如果 agentId 为空，返回 { epoch: 0, reason: null, at: null }
- 调用 _ensure(agentId)
- 返回 { epoch: entry.epoch, reason: entry.lastReason, at: entry.lastAt }

用途：区分"插话重试"与"用户中止"

### 3.4 newScope(agentId)

创建一个"运行作用域"，用于一次消息处理或一次 step 推进。

返回对象：
```
{
  agentId,
  epoch,       // 当前 epoch 快照
  signal,      // 当前 signal
  assertActive // 函数：检查是否仍有效
}
```

assertActive 实现：
- 获取当前 epoch
- 如果与捕获时不一致，抛出 AbortError("agent scope cancelled")
- 如果 signal.aborted，抛出 AbortError("agent scope aborted")

调用方必须在 await 返回后用 epoch 校验是否仍有效。

### 3.5 abort(agentId, options)

触发取消的核心方法。

参数：
- options.reason: string（可选，默认为 "abort_requested"）

执行步骤：
1. 如果 agentId 为空，返回 { agentId: "", epoch: 0, reason: null }
2. 调用 _ensure(agentId)
3. 获取 entry
4. 构造 reason 和 timestamp
5. entry.epoch += 1（递增世代号）
6. entry.lastReason = reason
7. entry.lastAt = timestamp
8. 调用 entry.controller.abort()
9. entry.controller = new AbortController()（创建新控制器）
10. 记录日志
11. 返回 { agentId, epoch: entry.epoch, reason }

### 3.6 clear(agentId)

清理指定 agent 的取消状态：
- 从 _byAgentId 删除该 agent 的条目
- 用于终止/删除 agent 时清理

## 4. _ensure 私有方法

确保指定 agent 的条目存在：
- 如果 _byAgentId 已有该 agent，直接返回
- 否则创建新条目：
  ```
  {
    epoch: 0,
    controller: new AbortController(),
    lastReason: null,
    lastAt: null
  }
  ```
- 存入 _byAgentId

## 5. 使用场景

### 5.1 创建 CancelScope

在 ComputeScheduler 的 _runOneStep 中：
```
const cancelScope = runtime._cancelManager.newScope(agentId);
const outcome = await turnEngine.step(agentId, cancelScope);
```

### 5.2 Step 中检查有效性

在 TurnEngine.step 中：
```
try {
  cancelScope?.assertActive?.();
} catch {
  entry.activeTurn = null;
  return { kind: "done" };
}
```

### 5.3 LLM 调用前捕获 epoch

在 ComputeScheduler._startLlm 中：
```
const epoch = cancelScope?.epoch ?? runtime._cancelManager?.getEpoch(agentId) ?? 0;
// 存储 epoch 到 _inFlight
```

### 5.4 LLM 返回后检查 epoch

在 LLM 回调中：
```
const currentEpoch = runtime._cancelManager?.getEpoch(agentId) ?? epoch;
if (currentEpoch !== epoch) {
  // 结果已过期，丢弃
  const reason = runtime._cancelManager?.getLastAbortInfo(agentId)?.reason ?? null;
  if (reason === "message_interruption") {
    turnEngine.onLlmCancelled(...);
  } else {
    turnEngine.onLlmError(...);
  }
  return;
}
```

### 5.5 触发插话中断

在 Runtime 的 onInterruptionNeeded 回调中：
```
runtime._state.addInterruption(agentId, message);
runtime._cancelManager.abort(agentId, { reason: "message_interruption" });
```
