# RuntimeState 运行时状态

## 1. 职责

Runtime 状态管理模块：
- 管理智能体注册表
- 跟踪智能体运算状态
- 管理插话队列
- 管理对话历史引用
- 管理任务工作空间映射
- 提供状态锁机制

设计原则：
- 单一职责：只负责状态的存储和访问
- 低耦合：通过接口与其他模块交互
- 高内聚：所有状态管理逻辑集中在此模块

## 2. 内部结构

### 2.1 核心数据结构

**智能体注册表**
- _agents: Map<agentId, agent> - 智能体实例映射
- _agentMetaById: Map<agentId, meta> - 智能体元数据

**运算状态跟踪**
- _agentComputeStatus: Map<agentId, status> - 运算状态
  - 状态值：'idle' | 'waiting_llm' | 'processing' | 'stopping' | 'stopped' | 'terminating'
- _activeProcessingAgents: Set<agentId> - 正在处理消息的智能体集合

**插话队列管理**
- _interruptionQueues: Map<agentId, Array<Message>> - 插话消息队列

**对话历史**
- _conversations: Map<agentId, Array> - 对话历史（由 ConversationManager 管理，这里只保存引用）

**任务工作空间映射**
- _taskWorkspaces: Map<taskId, workspacePath>
- _agentTaskBriefs: Map<agentId, TaskBrief>

**状态锁**
- _stateLocks: Map<agentId, Promise> - Promise 队列实现简单的互斥锁

**回调**
- _onComputeStatusChange: Function|null - 运算状态变更回调

## 3. 智能体注册表管理

### 3.1 registerAgent(agent)
- _agents.set(agent.id, agent)

### 3.2 getAgent(agentId)
- return _agents.get(agentId)

### 3.3 hasAgent(agentId)
- return _agents.has(agentId)

### 3.4 getAllAgentIds()
- return _agents.keys()

### 3.5 getAgentCount()
- return _agents.size

### 3.6 getAllAgents()
- return Array.from(_agents.values())

### 3.7 setAgentMeta(agentId, meta)
- _agentMetaById.set(agentId, meta)

### 3.8 getAgentMeta(agentId)
- return _agentMetaById.get(agentId)

## 4. 运算状态管理

### 4.1 setAgentComputeStatus(agentId, status)
- _agentComputeStatus.set(agentId, status)
- 触发 _onComputeStatusChange(agentId, status) 回调

### 4.2 getAgentComputeStatus(agentId)
- return _agentComputeStatus.get(agentId) ?? 'idle'

### 4.3 getAllAgentComputeStatus()
- return Object.fromEntries(_agentComputeStatus)

### 4.4 markAgentAsActivelyProcessing(agentId)
- _activeProcessingAgents.add(agentId)

### 4.5 unmarkAgentAsActivelyProcessing(agentId)
- _activeProcessingAgents.delete(agentId)

### 4.6 isAgentActivelyProcessing(agentId)
- return _activeProcessingAgents.has(agentId)

### 4.7 getActiveProcessingCount()
- return _activeProcessingAgents.size

### 4.8 getActiveProcessingAgents()
- return Array.from(_activeProcessingAgents)

## 5. 插话队列管理

### 5.1 addInterruption(agentId, message)
- 如果不存在，创建空数组：_interruptionQueues.set(agentId, [])
- 将消息推入队列
- 记录日志（包含队列长度）

### 5.2 getAndClearInterruptions(agentId)
- 获取队列：_interruptionQueues.get(agentId) ?? []
- 删除队列：_interruptionQueues.delete(agentId)
- 如果有消息，记录日志
- 返回消息数组（FIFO顺序）

### 5.3 hasInterruptions(agentId)
- 获取队列
- return queue && queue.length > 0

### 5.4 getInterruptionCount(agentId)
- 获取队列
- return queue ? queue.length : 0

## 6. 对话历史管理

### 6.1 getConversations()
- return _conversations

### 6.2 getConversation(agentId)
- return _conversations.get(agentId)

## 7. 任务工作空间映射

### 7.1 setTaskWorkspace(taskId, workspacePath)
- _taskWorkspaces.set(taskId, workspacePath)

### 7.2 getTaskWorkspace(taskId)
- return _taskWorkspaces.get(taskId)

### 7.3 setAgentTaskBrief(agentId, taskBrief)
- _agentTaskBriefs.set(agentId, taskBrief)

### 7.4 getAgentTaskBrief(agentId)
- return _agentTaskBriefs.get(agentId)

## 8. 状态锁管理

### 8.1 acquireLock(agentId)

使用 Promise 队列实现简单的互斥锁：
1. 如果不存在，初始化为 resolved Promise：_stateLocks.set(agentId, Promise.resolve())
2. 获取当前锁：currentLock = _stateLocks.get(agentId)
3. 创建新锁：newLock = new Promise(resolve => { releaseFn = resolve })
4. 更新：_stateLocks.set(agentId, currentLock.then(() => newLock))
5. 等待当前锁：await currentLock
6. 返回 releaseFn

### 8.2 releaseLock(releaseFn)
- 如果 releaseFn 存在，调用 releaseFn()

## 9. 状态变更回调

构造时传入 options.onComputeStatusChange：
- 当 setAgentComputeStatus 被调用时触发
- 参数：(agentId, status)
