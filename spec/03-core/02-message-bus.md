# MessageBus 消息总线

## 1. 职责

MessageBus 是系统的通信中枢，负责：
- 按收件人队列缓存消息
- 支持延迟消息投递
- 检测插话条件并触发中断

## 2. 内部结构

### 2.1 核心数据结构

**消息队列映射 `_queues`**
- 类型：Map<string, Array>
- 键：agentId（收件人ID）
- 值：该收件人的消息数组（FIFO队列）

**延迟消息队列 `_delayedMessages`**
- 类型：Array
- 按 deliverAt（投递时间戳）排序
- 元素包含消息完整字段 + deliverAt

**等待者集合 `_waiters`**
- 类型：Set<Function>
- 当有新消息入队时唤醒
- 用于调度循环的等待/通知机制

**延迟消息投递监听器 `_deliveryListeners`**
- 类型：Set<Function>
- 延迟消息实际投递时触发
- 用于通知前端消息已送达

## 3. 消息发送流程

### 3.1 send 方法

**输入参数**
- to: 收件人ID（必需）
- from: 发件人ID（必需）
- payload: 消息内容（必需）
- taskId: 关联任务ID（可选）
- delayMs: 延迟毫秒数（可选，默认0）

**执行步骤**

1. **检查目标智能体状态**
   - 如果状态为 'terminating'，拒绝发送
   - 返回 { messageId: '', rejected: true, reason: 'agent_terminating' }

2. **解析延迟时间**
   - 将 delayMs 转为数字
   - 无效值默认为0
   - 负值取0

3. **插话检测**
   触发条件（需同时满足）：
   - delayMs === 0（非延迟消息）
   - _isAgentActivelyProcessing(to) 返回 true（智能体正在活跃处理）
   - toStatus === "waiting_llm"（智能体状态为等待LLM）
   
   触发动作：
   - 设置 interruptionTriggered = true
   - 调用 _onInterruptionNeeded(to, message) 回调
   - 回调由 Runtime 在构造时注入

4. **生成消息ID**
   - 使用 randomUUID() 生成唯一ID

5. **构造消息信封**
   包含字段：
   - id: 消息ID
   - createdAt: 创建时间（本地时间格式化）
   - to: 收件人
   - from: 发件人
   - payload: 内容
   - taskId: 任务ID（如有）

6. **延迟消息处理**
   如果 delayMs > 0：
   - 计算 deliverAt = now + delayMs
   - 将消息加入 _delayedMessages
   - 按 deliverAt 排序（保持时间升序）
   - 返回 { messageId, scheduledDeliveryTime }

7. **立即投递**
   如果 delayMs === 0：
   - 获取或创建收件人队列
   - 将消息推入队列
   - 唤醒所有等待者（_waiters）
   - 返回 { messageId, interruptionTriggered（如有）}

### 3.2 延迟消息投递

**deliverDueMessages 方法**

执行时机：由调度循环定期调用

处理流程：
1. 获取当前时间 now = Date.now()
2. 遍历 _delayedMessages（按时间排序）
3. 对于每个 deliverAt <= now 的消息：
   - 从延迟队列移除
   - 投递到立即队列（_queues）
   - 触发 _emitDelayedDelivery 事件
   - 记录投递日志（包含漂移时间 drift）
4. 如果有消息被投递，唤醒等待者
5. 返回投递的消息数量

**forceDeliverAllDelayed 方法**

用于系统关闭时：
- 将所有延迟消息立即投递
- 清空延迟队列
- 返回投递的数量

## 4. 消息接收

### 4.1 receiveNext 方法

输入：agentId
输出：下一条消息或 null

流程：
1. 获取该 agentId 的队列
2. 如果队列不存在或为空，返回 null
3. 使用 shift() 取出第一条消息（FIFO）
4. 记录接收日志（包含队列长度变化）
5. 返回消息

### 4.2 等待消息

**waitForMessage 方法**

用于调度循环阻塞等待：
- 如果 hasPending() 为 true，立即返回 true
- 否则创建 Promise，加入 _waiters
- 支持 timeoutMs 参数（0表示无超时）
- 超时返回 false，收到消息返回 true

## 5. 延迟消息监听

### 5.1 onDelayedDelivery(listener)

注册延迟消息投递监听器。

- 参数 listener: 函数，接收消息对象
- 将 listener 加入 _deliveryListeners 集合
- 用于前端通知等场景

### 5.2 _emitDelayedDelivery(message)

触发延迟消息投递事件。

- 遍历 _deliveryListeners 中的所有监听器
- 逐个调用 listener(message)
- 使用 try-catch 包裹，防止监听器异常影响主流程
- 异常时记录警告日志

## 6. 查询方法

**hasPending()**
- 检查所有队列是否有待处理消息
- 返回 boolean

**getQueueDepth(agentId)**
- 获取指定智能体的队列深度
- 不存在返回 0

**getPendingCount()**
- 获取所有待处理消息总数
- 遍历所有队列累加

**getDelayedCount(recipientId?)**
- 获取延迟消息数量
- 可指定收件人过滤

**clearQueue(agentId)**
- 清空指定智能体的队列
- 返回被清空的消息列表

## 6. 与 Runtime 的集成

### 6.1 构造时注入的回调

**getAgentStatus**
- 用于检查目标智能体状态
- 如果返回 'terminating'，拒绝发送

**isAgentActivelyProcessing**
- 用于检查智能体是否正在活跃处理
- 是插话检测的条件之一

**onInterruptionNeeded**
- 当检测到需要插话时调用
- 参数：(agentId, message)
- 由 Runtime 处理实际的中断逻辑

### 6.2 使用场景

智能体 A 发送消息给智能体 B：
1. Runtime 调用 bus.send({ to: B, from: A, payload })
2. MessageBus 检查 B 的状态
3. 如果 B 正在 waiting_llm，触发 onInterruptionNeeded
4. 消息加入 B 的队列
5. 调度循环被唤醒，处理 B 的消息
