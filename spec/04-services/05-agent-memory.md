# Agent Memory 智能体记忆服务

## 1. 职责

AgentMemoryManager 负责管理所有智能体的 AgentMemory 实例：
- 初始化记忆系统配置
- 为每个智能体创建/获取独立的 AgentMemory 实例
- 管理记忆系统生命周期（关闭、清理）
- 全局错误处理和日志记录

每个智能体拥有独立的 AgentMemory 实例，完全隔离。
数据存储在 {dataDir}/agents/{agentId}/memory/ 目录下。

## 2. 内部结构

### 2.1 核心数据结构

**_memories: Map<agentId, AgentMemory>**
- agentId 到 AgentMemory 实例的映射

**_config: AgentMemoryConfig|null**
- 记忆系统配置
- 如果记忆功能禁用，为 null

### 2.2 配置结构

```
{
  enabled: boolean,        // 是否启用
  maxEntries: number,      // 最大条目数，默认 10000
  llm: object,             // LLM 配置
  embedding: object,       // Embedding 配置
  recall: {
    limit: number,         // 回忆数量限制，默认 5
    minConfidence: number  // 最小置信度，默认 0.7
  }
}
```

## 3. 初始化流程

### 3.1 initialize()

执行步骤：
1. 从 runtime.config?.agentMemory 获取原始配置
2. 如果未启用（enabled 为 false）：
   - _config = null
   - 记录日志"记忆功能已禁用"
   - 返回
3. 设置默认配置：
   - enabled = true
   - maxEntries = rawConfig.maxEntries ?? 10000
   - llm = rawConfig.llm
   - embedding = rawConfig.embedding
   - recall.limit = rawConfig.recall?.limit ?? 5
   - recall.minConfidence = rawConfig.recall?.minConfidence ?? 0.7
4. 记录日志"记忆功能已启用"
5. 如果使用本地 LLM-Modules：
   - 调用 runtime.llmModulesLauncher?.ensureReady()
   - 如果失败，记录错误，记忆功能将不可用

### 3.2 _isUsingLocalLLMModules(config)

检查 embedding.baseUrl 是否指向 localhost/127.0.0.1：
1. 获取 url = config.embedding?.baseUrl ?? ""
2. 解析 URL
3. 如果 hostname 为 "localhost" 或 "127.0.0.1"，返回 true
4. 解析失败返回 false

## 4. 记忆实例管理

### 4.1 getOrCreateMemory(agentId)

获取或创建指定智能体的记忆实例。

执行步骤：
1. 如果 _config?.enabled 为 false，返回 null
2. 获取 agent = runtime._agents.get(agentId)
3. 如果 agent 不存在或 agent._isTerminating，返回 null
4. 如果使用本地 LLM-Modules：
   - 检查 launcher.getState() 是否为 "ready"
   - 如果不是，返回 null
5. 检查缓存：如果 _memories.has(agentId)，返回缓存实例
6. 调用 _createMemory(agentId) 创建新实例
7. 如果创建成功，缓存并返回

### 4.2 _createMemory(agentId)

创建 AgentMemory 实例。

执行步骤：
1. 构造 memoryPath = path.join(runtime.dataDir, "agents", agentId, "memory")
2. 使用 mkdir 确保目录存在（recursive: true）
3. 动态加载 hmemory 模块（如果尚未加载）
4. 调用 AgentMemory.create(memoryPath, agentId, config) 工厂方法
5. 设置全局错误回调，将错误记录到日志
6. 返回创建的实例

## 5. TurnEngine 中的记忆触发

### 5.1 maybeUpdateMemory(agentId, currentMessage)

由 ComputeScheduler 在消息入队后调用（void，不阻塞调度循环）。

执行步骤：
1. 获取 agent
2. 获取对话历史
3. 调用 _getUnprocessedMessages(conversation, agent.lastMemoryMessageId)
4. 阈值 TRIGGER_THRESHOLD = 10
5. 如果未处理消息数量 >= 10：
   - 调用 _updateAgentMemory(agentId, currentMessage)

### 5.2 _getUnprocessedMessages(conversation, lastMemoryMessageId)

获取从 lastMemoryMessageId 之后的所有未处理消息。

执行步骤：
1. 如果没有 lastMemoryMessageId：
   - 返回所有 role !== 'system' 的消息
2. 找到 lastMemoryMessageId 的索引
3. 如果未找到，返回所有非 system 消息
4. 如果已经是最后一条，返回空数组
5. 返回该索引之后的所有消息（map 为 {role, content, id}）

### 5.3 _updateAgentMemory(agentId, currentMessage)

执行步骤：
1. 检查 agent 是否存在且未终止（!agent._isTerminating）
2. 调用 runtime.agentMemoryManager?.getOrCreateMemory(agentId)
3. 如果没有 memory 实例，返回
4. 获取对话历史
5. 获取未处理消息列表
6. 过滤掉空内容消息
7. 如果为空，返回
8. 分批处理（每批最多 50 条）
9. 调用 memory.processConversation(batch) 处理每批
10. 更新 agent.lastMemoryMessageId 为最后处理的消息 ID
11. 持久化到 org.json：runtime.org?.setAgentLastMemoryMessageId

## 6. 记忆回忆

在 RuntimeLlm 构建 System Prompt 时：
1. 调用 runtime.agentMemoryManager?.getOrCreateMemory(agentId)
2. 如果 memory 存在，调用 memory.recall(context, { limit })
3. 将回忆结果格式化后附加到 system prompt

回忆格式：
```
【相关记忆】
1. [相关度: 85%] 记忆内容...
2. [相关度: 72%] 记忆内容...
```
