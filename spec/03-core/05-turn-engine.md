# TurnEngine 回合引擎

## 1. 职责

- 将"处理一条入站消息"抽象为 Turn（回合），并以 step 的方式推进
- 一个 step 只返回一个原子动作：need_llm / need_tool / send / done / noop

设计约束：
- 同一 agent 的对话历史只允许 TurnEngine 写（单写者）
- step() 必须无阻塞，不能直接 await LLM/tool

## 2. 内部结构

### 2.1 核心数据结构

**_byAgentId: Map<agentId, {queue, activeTurn}>**
- queue: Turn 队列（数组）
- activeTurn: 当前活跃的 Turn 或 null

### 2.2 Turn 结构

```
{
  turnId: string,          // UUID
  agentId: string,
  ctx: object,             // AgentContext
  message: object,         // 原始消息
  conv: Array,             // 对话历史（OpenAI格式数组）
  phase: string,           // 当前阶段
  round: number,           // 当前轮次
  llmMsg: object|null,     // LLM 返回的消息
  pendingToolCalls: Array, // 待执行的工具调用
  executingToolCall: object|null, // 当前执行的工具调用
  lastStepId: number       // 最后 step ID
}
```

### 2.3 Phase 定义

- init: 初始阶段
- need_llm: 需要调用 LLM
- waiting_llm: 等待 LLM 响应
- dispatch_tools: 分发工具调用
- send_text: 发送文本回复
- finished: 回合结束

## 3. 回合管理

### 3.1 hasRunnable(agentId)

判断某个 agent 是否存在可运行的回合。

- 获取 entry = _byAgentId.get(agentId)
- 如果 entry 不存在，返回 false
- 返回 !!(entry.activeTurn || entry.queue.length > 0)

### 3.2 clearAgent(agentId)

清理某个 agent 的回合队列与活跃回合。

- 用于终止/删除 agent 时清理
- 调用 _byAgentId.delete(agentId)

### 3.3 enqueueMessageTurn

流程：
1. 确保该 agent 的 entry 存在（_ensureEntry）
2. 生成 turnId = randomUUID()
3. 构建 system prompt：runtime._buildSystemPromptForAgent(ctx)
4. 确保对话存在：runtime._ensureConversation(agentId, systemPrompt)
5. 构造 Turn 对象：
   - phase = "init"
   - round = 1
   - llmMsg = null
   - pendingToolCalls = []
   - executingToolCall = null
   - lastStepId = 0
6. 推入队列
7. 返回 turnId

## 4. Step 推进

### 4.1 step 方法

输入：agentId, cancelScope
输出：outcome 对象

流程：
1. 确保 entry 存在
2. 获取 turn：activeTurn ?? queue.shift()
3. 如果没有 turn，返回 { kind: "noop" }
4. 设置 activeTurn = turn
5. 调用 cancelScope.assertActive()，如果失败返回 { kind: "done" }

Phase 处理：

**init phase：**
- lastStepId++
- 构建 contextStatusPrompt：runtime._conversationManager.buildContextStatusPrompt(agentId)
- 格式化消息：runtime._formatMessageForLlm(ctx, message)
- userContent = formatted + contextStatusPrompt
- conv.push({ role: "user", content: userContent })
- phase = "need_llm"

**need_llm phase：**
- lastStepId++
- 获取插话消息：runtime._state.getAndClearInterruptions(agentId)
- 如果有插话消息：
  - 格式化每条插话
  - 合并为字符串：`【插话消息】\n[内容1]\n\n[内容2]`
  - conv.push({ role: "user", content: 合并内容 })
- 获取工具定义：runtime.getToolDefinitions()
- phase = "waiting_llm"
- 构造 llmMeta（包含 agentId, roleId, messageId, round, turnId, stepId, cancelEpoch）
- 返回 { kind: "need_llm", agentId, turnId, stepId, ctx, request: { messages: conv, tools, meta: llmMeta } }

**dispatch_tools phase：**
- 如果 executingToolCall 存在，返回 { kind: "noop" }
- 如果 pendingToolCalls 为空：
  - round++
  - phase = "need_llm"
  - 返回 { kind: "done" }
- 取出第一个 tool call
- 解析 toolName, callId, args
- 如果解析失败，添加错误到 conv，返回 { kind: "done" }
- executingToolCall = { toolName, callId, args }
- lastStepId++
- 返回 { kind: "need_tool", agentId, turnId, stepId, ctx, call: { toolName, callId, args } }

**send_text phase：**
- 获取 content = llmMsg?.content
- 如果 content 非空：
  - lastStepId++
  - phase = "finished"
  - 提取 usage = llmMsg?._usage
  - 返回 { kind: "send", agentId, turnId, stepId, message: { to: "user", from: agentId, taskId, payload: { text, usage } } }
- 否则 phase = "finished"，返回 { kind: "done" }

**finished phase：**
- activeTurn = null
- 返回 { kind: "done" }

## 5. 回调处理

### 5.1 onLlmResult

输入：agentId, { turnId, stepId, msg }

流程：
1. 查找 activeTurn
2. 验证 turnId 匹配
3. 验证 phase 为 waiting_llm
4. llmMsg = msg
5. conv.push(llmMsg)
6. 更新 token 使用统计
7. 提取 tool_calls
8. 如果有 tool_calls：
   - pendingToolCalls = tool_calls
   - executingToolCall = null
   - phase = "dispatch_tools"
9. 否则 phase = "send_text"

### 5.2 onLlmError

输入：agentId, { turnId, stepId, error }

流程：
1. 查找 activeTurn
2. 验证 turnId 匹配
3. activeTurn = null（结束回合）

### 5.3 onLlmCancelled

约束：只把 waiting_llm 回退到 need_llm，不清理 turn

流程：
1. 查找 activeTurn
2. 验证 turnId 匹配
3. 验证 phase 为 waiting_llm
4. phase = "need_llm"

### 5.4 onToolResult

输入：agentId, { turnId, stepId, callId, result }

流程：
1. 查找 activeTurn
2. 验证 turnId 匹配
3. 验证 phase 为 dispatch_tools
4. 验证 executingToolCall.callId 匹配
5. 触发 tool_call 事件：runtime._emitToolCall
6. conv.push({ role: "tool", tool_call_id: callId, content: JSON.stringify(result) })
7. executingToolCall = null

### 5.5 onToolError

输入：agentId, { turnId, stepId, callId, error }

流程：
1. 查找 activeTurn
2. 验证 turnId 匹配
3. 验证 phase 为 dispatch_tools
4. 构造错误结果：{ error: "工具执行失败", toolName, message, args }
5. 调用 onToolResult（复用逻辑）

## 6. 记忆更新

### 6.1 maybeUpdateMemory

触发时机：ComputeScheduler 在消息入队后调用（void，不阻塞）

流程：
1. 获取 agent
2. 获取对话历史
3. 计算未处理消息数量（_getUnprocessedMessages）
4. 阈值：TRIGGER_THRESHOLD = 10
5. 如果数量 >= 10：
   - 调用 _updateAgentMemory(agentId, currentMessage)

### 6.2 _getUnprocessedMessages

输入：conversation, lastMemoryMessageId

流程：
1. 如果没有 lastMemoryMessageId，返回所有非 system 消息
2. 找到 lastMemoryMessageId 的索引
3. 如果未找到，返回所有非 system 消息
4. 如果是最后一条，返回空数组
5. 返回该索引之后的所有消息

### 6.3 _updateAgentMemory

流程：
1. 记录 info 日志：'_updateAgentMemory 被调用'
2. 检查 agent 是否存在且未终止（!agent._isTerminating）
3. 调用 runtime.agentMemoryManager?.getOrCreateMemory(agentId) 获取 memory 实例
4. 获取对话历史：runtime._conversations.get(agentId)
5. 调用 _getUnprocessedMessages 获取未处理消息列表
6. 【过滤】移除空内容消息：
   - 过滤条件：m.content && typeof m.content === 'string' && m.content.trim().length > 0
   - 记录 info 日志：过滤后的数量
7. 如果为空，记录 info 后返回
8. 【批量处理】每批最多 50 条：
   - 使用 BATCH_SIZE = 50
   - 将消息分批存入 batches 数组
9. 记录 info 日志：开始记忆批处理（batchCount, totalMessages）
10. 逐批处理：
    - 记录 info 日志：处理第 i 批（batchSize）
    - 调用 memory.processConversation(batch)
    - 记录 lastProcessedMessage = batch[batch.length - 1]
    - 记录 info 日志：该批处理完成
11. 更新 lastMemoryMessageId：
    - 使用 lastProcessedMessage.id 或 `${Date.now()}_${messagesToRemember.length}`
    - 记录 info 日志：更新 lastMemoryMessageId
12. 持久化到 org.json：
    - 调用 runtime.org?.setAgentLastMemoryMessageId?.(agentId, agent.lastMemoryMessageId)
13. 记录 info 日志：记忆处理完成
14. 使用 try-catch 包裹，异常时记录 warn 日志
