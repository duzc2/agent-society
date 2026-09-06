# 会话与上下文

会话服务管理每个智能体的 LLM 对话历史：维护、统计、压缩、持久化。源码目录：`src/platform/services/conversation/`（有 `conversation.md` 自述）。

## ConversationManager

`conversation_manager.js` 是会话核心：

- **会话容器**：按智能体维护消息列表（OpenAI messages 格式：system/user/assistant/tool）；
- **token 统计**：跟踪每次调用的用量，估算上下文占用率；
- **上下文状态机**：`normal / warning / critical / exceeded`，阈值来自 `app.json` 的 `contextLimit`；
- **持久化**：会话历史按防抖策略写入 `<dataDir>/runtime/state/`，启动时 `loadAllConversations()` 恢复；带一致性验证（`history_persistence_compatibility.test.js` 覆盖兼容性）。

## 自动压缩（AutoCompressionManager）

`auto_compression_manager.js`——零配置，始终启用：

1. 上下文占用达到 `criticalThreshold`（默认 0.7）时触发；
2. 用默认 LLM 对旧历史生成**结构化摘要**；
3. 直接修改消息数组：摘要替换被压缩区间，保留 system 与最近消息；
4. 压缩行为与阈值状态通过 `config/prompts/context_warning.txt`、`context_critical.txt`、`context_exceeded.txt`、`context_status.txt` 提示词注入给智能体，让智能体感知自己的上下文状况。

## 工具调用对压缩器（ToolCallPairCompressor）

`tool_call_pair_compressor.js`——不调用 LLM 的零成本压缩：

- 策略：保留最近 N 轮不动，更早轮次中所有 tool 消息的结果截断为紧凑摘要；
- 处理"工具调用对"（assistant 的 tool_call + 对应 tool 结果）保持消息结构合法（OpenAI 格式要求成对）。

## 压缩决策流程

```
上下文占用率
  ├─ < warningThreshold(0.6)      → normal，不处理
  ├─ ≥ warningThreshold           → warning：提示注入（智能体自行节流）
  ├─ ≥ criticalThreshold(0.7)     → critical：触发 LLM 摘要压缩
  └─ ≥ hardLimitThreshold(0.8)    → exceeded：强制压缩 + 更强提示
```

## 与其他层的协作

- **TurnEngine 单写者**：只有回合引擎写会话历史，压缩器在回合边界运行，避免竞态；
- **llm 层的老化服务**：`tool_result_aging_service.js` 在请求前把老工具结果降级，是压缩之外的第二道缩减手段；
- **记忆系统**：被压缩掉的内容若值得长期保留，由 agent_memory / knowledge_tree 负责吸收（压缩与记忆互补，前者管窗口，后者管沉淀）。

## 开发注意

1. 直接操作会话数组的代码必须维持 OpenAI message 结构合法性（tool 消息必须有对应的 tool_call_id）；
2. 新增持久化字段需向后兼容旧状态文件（参考 `history_persistence_compatibility` 测试的做法）；
3. 不要在压缩器里做业务判断——压缩只看占用率与轮次，语义取舍交给摘要 LLM。
