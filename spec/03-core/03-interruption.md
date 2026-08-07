# Interruption 插话机制

## 1. 设计目标

插话机制允许在智能体等待 LLM 响应时，立即处理新收到的消息，而不必等待当前 LLM 调用完成。

核心约束：
- 使用 epoch（世代号）判定结果是否过期
- 通过 AbortSignal 中止 in-flight 的异步请求
- 统一取消语义：递增 epoch + abort 当前 signal

## 2. Epoch 机制

### 2.1 概念

每个 agent 维护一个单调递增的整数 epoch：
- 初始值为 0
- 每次触发取消时递增
- 用于判定"结果是否过期"

### 2.2 关键判定规则

在 await 返回后校验 epoch：
- 如果当前 epoch 与发起请求时一致：结果有效
- 如果当前 epoch 与发起请求时不一致：结果已过期，必须丢弃

过期的结果：
- 不写入对话历史
- 不触发工具副作用
- 不继续推进回合

## 3. AgentCancelManager

### 3.1 数据结构

使用 Map 存储每个 agent 的状态：
```
_byAgentId: Map<agentId, {
  epoch: number,           // 当前世代号
  controller: AbortController,  // 当前控制器
  lastReason: string|null, // 最后一次取消原因
  lastAt: string|null      // 最后一次取消时间（ISO格式）
}>
```

### 3.2 核心方法

**getEpoch(agentId)**
- 返回当前 epoch
- 不存在则初始化为 0

**getSignal(agentId)**
- 返回当前 AbortSignal
- 用于传入 LLM/HTTP 请求

**getLastAbortInfo(agentId)**
- 返回 { epoch, reason, at }
- 用于区分"插话重试"与"用户中止"

**newScope(agentId)**
- 创建运行作用域
- 返回 { agentId, epoch, signal, assertActive }
- assertActive 用于主动检查是否仍有效

**abort(agentId, options)**
- 触发取消：
  1. epoch 加 1
  2. 记录 reason 和 timestamp
  3. 调用 controller.abort()
  4. 创建新的 AbortController
- 返回 { agentId, epoch, reason }

**clear(agentId)**
- 清理指定 agent 的取消状态
- 用于终止/删除 agent

## 4. 插话触发流程

### 4.1 触发条件（MessageBus）

同时满足：
1. delayMs === 0（非延迟消息）
2. isAgentActivelyProcessing(to) 为 true
3. getAgentComputeStatus(to) === "waiting_llm"

触发动作：
- 调用 onInterruptionNeeded(to, message)

### 4.2 Runtime 处理中断

onInterruptionNeeded 回调执行：
1. 调用 runtime._state.addInterruption(agentId, message)
   - 将消息加入插话队列
2. 调用 runtime._cancelManager.abort(agentId, { reason: "message_interruption" })
   - 递增 epoch
   - abort 当前 LLM 请求的 signal

### 4.3 LLM 结果处理（ComputeScheduler）

_startLlm 中注册回调：

成功回调 .then((msg) => { ... })：
1. 获取当前 epoch
2. 如果 currentEpoch !== epoch（结果过期）：
   - 获取 lastAbortInfo
   - 如果 reason === "message_interruption"：
     - 调用 turnEngine.onLlmCancelled(agentId, { turnId, stepId })
   - 否则：
     - 调用 turnEngine.onLlmError(agentId, { turnId, stepId, error })
3. 如果 epoch 一致：
   - 调用 turnEngine.onLlmResult(agentId, { turnId, stepId, msg })

错误回调 .catch((err) => { ... })：
- 同样的 epoch 检查逻辑
- epoch 不一致时根据 reason 调用 onLlmCancelled 或 onLlmError
- epoch 一致时调用 onLlmError

## 5. TurnEngine 处理取消

### 5.1 onLlmCancelled

约束：只把 waiting_llm 回退到 need_llm，不清理 turn

步骤：
1. 查找 activeTurn
2. 验证 turnId 匹配
3. 验证当前 phase 为 waiting_llm
4. 设置 turn.phase = "need_llm"
5. 下次 step 时会重新构建请求（包含插话消息）

### 5.2 step 中的插话合并

在 need_llm phase：
1. 调用 getAndClearInterruptions(agentId) 获取插话消息
2. 将多条插话格式化为字符串：
   ```
   【插话消息】
   [消息1内容]
   
   [消息2内容]
   ```
3. 作为 user 角色消息加入对话历史（turn.conv.push）
4. 继续构建 LLM 请求

## 6. 状态流转

### 6.1 正常流程

```
init → need_llm → waiting_llm → dispatch_tools/send_text → finished
```

### 6.2 插话流程

```
waiting_llm （收到插话消息）
    ↓（abort，epoch 递增）
waiting_llm 被取消 → onLlmCancelled
    ↓
need_llm（重新构建请求，包含插话）
    ↓
waiting_llm（重新发起 LLM 调用）
```

### 6.3 ComputeStatus 变化

- 正常进入 need_llm：status 保持 processing
- 进入 waiting_llm：setAgentComputeStatus(agentId, "waiting_llm")
- LLM 返回后：setAgentComputeStatus(agentId, "processing")
- 回合结束：通过 _maybeSetIdle 设为 idle
