# 消息与调度

本篇解释消息如何流动、如何被调度执行。源码参照：`core/message_bus.js`、`runtime/runtime_messaging.js`、`runtime/turn_engine.js`、`runtime/compute_scheduler.js`、`runtime/agent_cancel_manager.js`。

## MessageBus（消息总线）

`core/message_bus.js`，最小化设计：

- **按收件人隔离队列**：`_queues: Map<agentId, Message[]>`；
- **延迟消息**：`_delayedMessages` 按 `deliverAt` 排序，到期投递，触发 `_deliveryListeners`；
- **等待者机制**：`waitForMessage` / `receiveNext` 支持消费端挂起等待；
- 无持久化——消息是即时性的，跨会话的事实记录由会话历史与工作区承担。

## 消息处理循环（RuntimeMessaging）

`runtime/runtime_messaging.js` 实现生产者-消费者循环：

- `startProcessing()` 启动常驻后台循环（不阻塞调用者）；
- **并发模型**：不同智能体并行处理，同一智能体**串行**（单智能体互斥约束）；
- **插话**：目标智能体正在处理时，新消息进入该智能体的插话队列（`runtime_state.interruptionQueues`），由回合引擎在合适时机注入；
- **异常隔离**：单个智能体的处理异常不影响其他智能体；
- `stopRequested` 标志支持优雅停止。

## TurnEngine（回合引擎）

`runtime/turn_engine.js` 把"处理一条入站消息"抽象为**回合（Turn）**，协程式推进：

```
Turn 生命周期：
enqueue(agentId, ctx, messages)     # 消息入队成回合
  └─ step() ──▶ { action: "need_llm" | "need_tool" | "send" | "done" | "noop" }
       ├─ need_llm：需要 LLM 决策 → 调度器发起异步 LLM 调用
       ├─ need_tool：需要执行工具 → 调度器发起异步工具执行
       ├─ send：发送出站消息（给 user 或其他智能体）
       └─ done：回合结束
```

**设计约束**（源码注释明确要求）：

1. 同一智能体的会话历史（conv）只允许 TurnEngine 写（单写者），避免并发乱序；
2. `step()` 必须无阻塞——不直接 `await` LLM/工具；由外部调度器启动异步操作并在完成后回调。

## ComputeScheduler（计算调度器）

`runtime/compute_scheduler.js` 是系统级调度器：

- 从 MessageBus 拉取消息 → 转成 Turn 入队；
- **round-robin 时间片**：每轮为每个活跃智能体推进最多 1 个原子动作；
- 长操作采用"启动异步 → 完成回调入队"，不占用调度循环；
- 每轮循环让出事件循环，避免饿死其他任务。

这套"协程式状态机 + 时间片调度"让成百上千个智能体并发运转而不互相阻塞。

## LLM 交互循环（RuntimeLlm）

`runtime/runtime_llm.js` 封装回合中的 LLM 步骤：

1. **构建上下文**（ContextBuilder + SystemPromptManager）：系统预置提示词（`config/prompts/compose.txt` 模板组装：BASE + 工作区指南 + 岗位提示词 + 任务）+ 技能总览 + 知识树召回 + 向量记忆召回 + 待办 + 会话历史；
2. 调用 `LlmClient.chat()`（见 [LLM 服务层](04-llm-services.md)）；
3. 解析响应：文本回复 → 出站消息；`tool_calls` → 交 ToolExecutor；
4. 工具结果写回会话历史 → 回合继续 step（循环直到 done 或达到 `maxToolRounds`）；
5. 错误处理：LLM 错误通知智能体自身（自我感知故障），并交 RetryCoordinator 安排重试。

## 取消与中断

- **AgentCancelManager**：按 agentId 取消在途 LLM 请求（界面的 Abort 按钮走这里）；
- **插话注入**：中断消息不会打断当前 LLM 调用，而是在下一个 step 边界注入上下文；
- **terminate 级联**：终止智能体时，LifecycleRegistry 按所属关系清理其持有的资源（浏览器实例、子进程、记忆实例等）。

## 重试协调（RetryCoordinator）

`runtime/retry_coordinator.js` 解决"惊群"问题：多个智能体同时收到 429 后若独立退避，退避周期可能同步，下一轮再次同时打爆服务。协调器用全局槽位（`maxSlots`）错开各智能体的重试时间。

## 相关文档

- [LLM 服务层](04-llm-services.md)
- [核心概念与数据模型](02-concepts.md)
