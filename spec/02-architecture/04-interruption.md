# 插话机制

## 消息总线设计

消息总线采用"队列+延迟堆"的设计：

**即时消息队列**
每个智能体有一个消息队列（List）。消息到达时直接加入队列，如果智能体空闲，立即触发处理。

**延迟消息堆**
延迟消息存储在最小堆中，按投递时间排序。后台任务定期检查堆顶，到达时间的消息移入对应智能体的即时队列。

## 插话（Interruption）机制

插话是系统的核心特性，允许在智能体等待 LLM 响应时接收新消息，并将新消息合并到对话上下文中处理。

**使用场景**：用户发送指令后补充信息、其他智能体发送紧急消息、用户改变主意需要修改请求。

**触发条件**：目标智能体状态为 `waiting_llm` + 新消息是即时消息（非延迟消息）。

**核心机制**：
- **AgentCancelManager**：为每个智能体维护 epoch（世代号），插话时递增 epoch
- **插话队列**：新消息被添加到 `_interruptionQueues`，而非替换当前处理
- **结果丢弃**：LLM 响应返回时对比 epoch，若已过期则丢弃结果
- **上下文合并**：TurnEngine 在调用 LLM 前将插话消息合并到对话上下文

**处理流程**：
1. MessageBus.send() 检测到目标正在 waiting_llm，触发 onInterruptionNeeded
2. RuntimeMessaging 将新消息添加到插话队列
3. AgentCancelManager.abort() 递增 epoch
4. 当前 LLM 调用返回，ComputeScheduler 检查到 epoch 不匹配，丢弃结果
5. TurnEngine 在 need_llm 阶段获取插话消息，合并到上下文
6. 基于包含插话的上下文重新调用 LLM

**设计考虑**：
- HTTP 请求难以真正取消，服务器仍在处理
- 将插话合并到上下文比取消重试更符合对话连贯性
- epoch 机制可以区分多次连续插话，追踪时间顺序

详见 [核心层设计 - 插话机制](03-core-layer.md#3-插话interruption机制)
