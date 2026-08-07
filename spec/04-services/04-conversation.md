# Conversation Service 对话服务

## 4.1 职责

Conversation Service 负责：
- 存储和查询智能体对话历史
- 构建 LLM 上下文
- 自动压缩和裁剪
- 持久化到文件

## 4.2 对话记录

**存储格式**

对话记录存储为 JSON 数组，每条记录包含：
```json
{
  "role": "system|user|assistant|tool",
  "content": "...",
  "name": "工具名称（仅 tool 角色）",
  "tool_call_id": "工具调用 ID"
}
```

**文件存储**

每个智能体一个文件：`conversations/{agent_id}.json`

## 4.3 上下文构建

**构建流程**

1. 读取 system prompt
2. 读取对话历史
3. 计算 token 数
4. 如果超过阈值，进行压缩
5. 追加当前消息
6. 返回完整消息列表

**Token 计算**

使用 tiktoken 库估算 token 数：
```python
encoding = tiktoken.encoding_for_model(model)
tokens = len(encoding.encode(text))
```

## 4.4 压缩策略

**滑动窗口**

保留最近 N 条消息，删除更早的。

**摘要压缩**

将多条消息摘要为一条（需要 LLM 支持，可选）。

**系统消息保护**

system 消息始终保留，不会被压缩。

## 4.5 持久化

**保存时机**
- 每次 LLM 调用后保存
- 系统关闭时批量保存

**加载时机**
- 智能体恢复时加载
- 首次访问时按需加载
