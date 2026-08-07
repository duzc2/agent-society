# Agent Society 持久化设计

## 1. 概述

持久化层负责将系统状态保存到文件系统，确保系统重启后可以恢复。持久化的设计原则是：可靠、高效、可恢复。

### 1.1 持久化范围

需要持久化的数据：
- **智能体元数据**：ID、岗位、父智能体、创建时间等
- **组织关系**：岗位定义、智能体层级关系
- **消息历史**：所有发送过的消息
- **对话历史**：智能体与 LLM 的对话记录
- **自定义名称**：用户为智能体设置的名称
- **Token 使用**：LLM 调用统计

### 1.2 设计原则

**即时持久化**
关键数据（消息、组织关系）在变更时立即持久化，最大限度减少数据丢失。

**批量持久化**
非关键数据（token 统计）可以批量或定期持久化。

**向前兼容**
数据格式变更时，提供迁移机制，确保旧数据可以加载。

**人类可读**
配置文件使用 JSON/Markdown，便于调试和手动修复。

---

## 2. 存储目录结构

### 2.1 数据目录布局

```
agent-society-data/
├── agents/                 # 智能体数据
│   ├── org.json           # 组织关系和岗位定义
│   └── {agentId}/         # 各智能体目录
│       ├── agent.json     # 智能体元数据
│       ├── messages.ndjson # 消息历史（JSON Lines）
│       └── custom-name.txt # 自定义名称
├── conversations/          # 对话历史
│   └── {agentId}.json     # 各智能体对话记录
├── workspaces/            # 工作空间
│   └── {workspaceId}/     # 各工作空间目录
├── config/                # 配置文件
│   ├── app.json          # 基础配置
│   └── app.local.json    # 本地覆盖配置
└── logs/                 # 日志文件
    └── {date}.log
```

### 2.2 目录说明

**agents/ 目录**

存储智能体相关数据。每个智能体一个子目录，按 agent_id 命名。

**org.json 文件**

存储整个系统的组织关系和岗位定义。这是系统的核心数据结构。

**messages.ndjson 文件**

使用 JSON Lines 格式（每行一个 JSON 对象），便于追加写入和按行读取。

**conversations/ 目录**

存储智能体与 LLM 的对话历史，用于上下文构建。

**config/ 目录**

配置文件，支持分层配置（基础配置 + 本地覆盖）。

---

## 3. 数据格式

### 3.1 组织关系（org.json）

```json
{
  "roles": {
    "role-root": {
      "id": "role-root",
      "name": "Root",
      "prompt": "...",
      "toolGroups": ["org_management"],
      "parentId": null,
      "llmService": "default"
    },
    "developer": {
      "id": "developer",
      "name": "Developer",
      "prompt": "...",
      "toolGroups": ["workspace", "execution"],
      "parentId": "role-root",
      "llmService": "default"
    }
  },
  "agents": {
    "agent-xxx": {
      "id": "agent-xxx",
      "roleId": "role-root",
      "parentId": null,
      "workspaceId": "ws-yyy",
      "createdAt": "2024-01-01T00:00:00Z",
      "status": "running"
    }
  },
  "relationships": {
    "agent-xxx": ["agent-yyy", "agent-zzz"]
  }
}
```

**字段说明**

- `roles`：岗位定义映射，key 为 role_id
- `agents`：智能体元数据映射，key 为 agent_id
- `relationships`：父子关系映射，key 为父 agent_id，value 为子 agent_id 列表

### 3.2 消息历史（messages.ndjson）

每行一个 JSON 对象：

```json
{"id":"msg-1","type":"text","from":"user-1","to":"agent-1","taskId":"task-1","payload":{"text":"Hello"},"createdAt":"2024-01-01T00:00:00Z"}
{"id":"msg-2","type":"text","from":"agent-1","to":"user-1","taskId":"task-1","payload":{"text":"Hi there"},"createdAt":"2024-01-01T00:00:01Z"}
```

**为什么用 JSON Lines？**

- **追加写入**：无需读取整个文件，直接追加到末尾
- **逐行读取**：可以流式处理大文件
- **容错性**：某行损坏不影响其他行
- **日志友好**：类似日志格式，易于查看

### 3.3 对话历史（{agentId}.json）

```json
[
  {
    "role": "system",
    "content": "You are a helpful assistant."
  },
  {
    "role": "user",
    "content": "Hello"
  },
  {
    "role": "assistant",
    "content": "Hi there!",
    "usage": {
      "promptTokens": 20,
      "completionTokens": 10
    }
  }
]
```

### 3.4 智能体元数据（agent.json）

```json
{
  "id": "agent-xxx",
  "roleId": "role-root",
  "parentId": null,
  "workspaceId": "ws-yyy",
  "createdAt": "2024-01-01T00:00:00Z",
  "status": "running",
  "customName": "My Assistant"
}
```

### 3.5 配置文件（app.json / app.local.json）

```json
{
  "llm": {
    "baseURL": "https://api.openai.com/v1",
    "model": "gpt-4o",
    "apiKey": "sk-...",
    "timeout": 60
  },
  "log": {
    "level": "info",
    "output": "console"
  },
  "runtime": {
    "maxConcurrentAgents": 50,
    "maxLlmConcurrency": 2
  }
}
```

---

## 4. 持久化操作

### 4.1 消息持久化

**追加写入**

新消息到达时，追加到 NDJSON 文件：

```python
async def append_message(agent_id: str, message: Message) -> None:
    file_path = get_messages_path(agent_id)
    async with aiofiles.open(file_path, 'a') as f:
        await f.write(json.dumps(message.to_dict()) + '\n')
```

**为什么用 'a' 模式？**

- 原子追加，无需锁定
- 高效，O(1) 时间复杂度
- 不会损坏已有数据

**读取消息**

从文件读取所有消息：

```python
async def load_messages(agent_id: str) -> List[Message]:
    file_path = get_messages_path(agent_id)
    messages = []
    async with aiofiles.open(file_path, 'r') as f:
        async for line in f:
            if line.strip():
                messages.append(Message.from_dict(json.loads(line)))
    return messages
```

### 4.2 组织关系持久化

**原子写入**

JSON 文件写入需要原子性，防止写入过程中崩溃导致文件损坏：

```python
async def save_org(org_data: dict) -> None:
    file_path = get_org_path()
    temp_path = file_path.with_suffix('.tmp')
    
    # 写入临时文件
    async with aiofiles.open(temp_path, 'w') as f:
        await f.write(json.dumps(org_data, indent=2))
    
    # 原子替换
    os.replace(temp_path, file_path)
```

**为什么用临时文件 + 替换？**

- 写入是原子的（os.replace 是原子操作）
- 写入失败时原文件不受影响
- 防止半写文件

### 4.3 对话历史持久化

**批量保存**

对话历史可以在以下时机保存：
- 每次 LLM 调用后
- 系统关闭时
- 定期（如每 5 分钟）

**增量更新**

如果文件已存在，只追加新消息：

```python
async def save_conversation(agent_id: str, messages: List[dict]) -> None:
    file_path = get_conversation_path(agent_id)
    
    # 读取已有消息
    existing = await load_conversation(agent_id)
    existing_ids = {m.get('id') for m in existing}
    
    # 过滤新消息
    new_messages = [m for m in messages if m.get('id') not in existing_ids]
    
    # 追加写入
    async with aiofiles.open(file_path, 'a') as f:
        for msg in new_messages:
            await f.write(json.dumps(msg) + '\n')
```

### 4.4 配置持久化

**分层写入**

配置保存到本地覆盖文件，不影响基础配置：

```python
async def save_config_local(filename: str, key: str, value: any) -> None:
    local_path = get_config_path(filename + '.local')
    
    # 加载现有配置
    config = await load_json(local_path) if local_path.exists() else {}
    
    # 更新配置
    set_nested_value(config, key, value)
    
    # 保存
    await atomic_write_json(local_path, config)
```

---

## 5. 状态恢复

### 5.1 启动恢复流程

系统启动时的状态恢复：

1. **加载配置**
   - 读取 `config/app.json`
   - 读取 `config/app.local.json` 并合并

2. **加载组织关系**
   - 读取 `agents/org.json`
   - 构建岗位定义映射
   - 构建智能体元数据映射
   - 构建父子关系映射

3. **恢复智能体**
   - 遍历 `agents/` 目录下的智能体子目录
   - 读取每个智能体的 `agent.json`
   - 创建 Agent 实例
   - 恢复到 Runtime

4. **恢复消息队列**
   - 读取每个智能体的 `messages.ndjson`
   - 加载到内存队列

5. **恢复对话历史**
   - 读取 `conversations/{agentId}.json`
   - 加载到 ConversationManager

6. **创建 Root 智能体**
   - 如果不存在，创建新的 Root 智能体
   - 创建 User 端点智能体

### 5.2 恢复策略

**部分恢复**

如果某些数据损坏或丢失，系统应该：
- 记录错误日志
- 跳过损坏的数据
- 继续恢复其他数据
- 尽可能保持系统可用

**智能体重建**

如果智能体元数据丢失但组织关系存在：
- 根据组织关系重建智能体
- 使用默认配置
- 记录警告

**消息丢失**

如果消息文件损坏：
- 读取可解析的部分
- 记录损坏的行号
- 继续运行（智能体可能丢失部分上下文）

### 5.3 数据迁移

**版本管理**

数据格式可能随版本变化。每个数据文件包含 `version` 字段：

```json
{
  "version": "2.0",
  "data": { ... }
}
```

**迁移函数**

加载数据时检查版本，如果需要则迁移：

```python
def load_org() -> dict:
    data = load_json(ORG_PATH)
    version = data.get('version', '1.0')
    
    if version == '1.0':
        data = migrate_v1_to_v2(data)
    
    return data['data']
```

---

## 6. 数据清理

### 6.1 自动清理策略

**消息历史**
- 保留最近 N 天的消息（默认 30 天）
- 定期删除过期消息

**工作空间**
- 任务完成后保留一段时间（默认 7 天）
- 可配置保留策略

**日志文件**
- 按日期轮转
- 保留最近 N 个文件（默认 30 个）

### 6.2 手动清理

提供 API 用于手动清理：

```python
# 清理指定智能体的历史消息
runtime.cleanup_messages(agent_id, before_date)

# 清理工作空间
runtime.cleanup_workspace(workspace_id)
```

---

## 7. 备份和恢复

### 7.1 自动备份

**触发时机**
- 系统启动时（如果上次未正常关闭）
- 定期（如每天一次）

**备份内容**
- 完整的 `agent-society-data/` 目录
- 排除日志文件

**备份位置**
- 本地：`agent-society-data/backups/`
- 远程：可配置云存储

### 7.2 手动备份

提供命令行工具：

```bash
python -m agent_society backup --output backup.zip
python -m agent_society restore --input backup.zip
```

### 7.3 数据导出

支持导出特定数据：

```python
# 导出智能体对话
runtime.export_conversation(agent_id, format='json')

# 导出工作空间文件
runtime.export_workspace(workspace_id, output_path)
```

---

## 8. 性能优化

### 8.1 文件缓存

**配置缓存**
- 配置加载后缓存到内存
- 监听文件变化自动刷新
- 提供手动刷新接口

**消息索引**
- 大消息文件建立索引（行号 -> 消息ID）
- 支持快速定位特定消息

### 8.2 批量操作

**批量写入**
- 消息批量追加（每次写入多条）
- 减少磁盘 I/O 次数

**延迟写入**
- 非关键数据延迟写入（如 token 统计）
- 批量保存到文件

### 8.3 压缩存储

**历史数据压缩**
- 旧消息文件 gzip 压缩
- 需要时解压缩读取

**数据库替代（可选）**
- 大消息量时，可选 SQLite 存储
- 提供更好的查询性能
