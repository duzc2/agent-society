# Tool Executor 工具执行器

## 1. 职责

Tool Executor 是工具调用的中央处理器：
- 注册和管理工具定义
- 验证工具权限
- 执行工具调用
- 处理工具错误和超时

## 2. 内部工作机制

### 2.1 工具注册表

**工具存储结构**

工具注册表维护两个核心集合：
1. 工具定义映射：工具名称 → 工具定义
2. 工具分组映射：分组名称 → 工具名称列表

**工具定义**

每个工具包含：
- 名称：唯一标识符
- 描述：功能说明（用于LLM理解）
- 参数定义：JSON Schema 格式
- 处理函数：异步执行函数
- 分组：所属工具组（如 org_management）
- 超时时间：可选，默认60秒

**注册流程**

注册工具时：
1. 验证参数 schema 格式合法
2. 检查工具名是否已存在（重复注册报错或覆盖）
3. 存储工具定义
4. 加入对应分组列表

**工具查询**

支持多种查询方式：
- 按名称获取单个工具
- 按分组获取工具列表
- 获取所有已注册工具

### 2.2 工具调用流程

**调用步骤**

当收到工具调用请求时，执行以下步骤：

1. **查找工具**
   根据工具名称在注册表中查找定义
   如果不存在，返回"工具未找到"错误

2. **权限验证**
   检查调用者是否有权限使用该工具
   验证规则：
   - 获取调用者智能体的配置
   - 检查 allowed_tools 列表
   - 如果列表为空，允许所有工具（向后兼容）
   - 如果工具名在列表中，允许使用
   - 如果分组通配符（如 org_management.*）在列表中，允许使用
   
3. **参数验证**
   根据工具定义的 JSON Schema 验证参数：
   - 检查必填参数是否存在
   - 验证参数类型（string, integer, boolean, array, object）
   - 类型转换（如字符串"123"转为整数123）
   - 验证枚举值
   - 返回验证错误详情

4. **上下文构建**
   创建 ToolContext 对象，包含：
   - Runtime 实例引用
   - 调用者智能体ID
   - 当前任务ID（如有）
   - 当前工作空间ID（如有）
   
   Context 提供受控的访问接口，避免工具直接操作 RuntimeState

5. **执行工具**
   调用处理函数，传入验证后的参数和上下文
   使用超时控制防止无限执行
   
6. **结果处理**
   截断过大的结果（默认最大10万字符）
   包装为统一的返回格式
   记录执行时间和日志

### 2.3 超时控制

**超时机制**

每个工具调用都有超时限制：
- 默认60秒
- 可针对单个工具配置
- 超时后强制取消任务

**实现方式**

使用异步任务和超时等待：
1. 创建工具执行的任务
2. 使用 wait_for 等待结果，设置超时
3. 如果超时，取消任务
4. 返回超时错误

### 2.4 参数验证详细规则

**类型转换**

系统尝试自动转换参数类型：

字符串类型：
- 输入已经是字符串：直接使用
- 输入其他类型：转为字符串

整数类型：
- 字符串输入：解析为整数
- 浮点输入：截断为整数
- 其他类型：报错

数字类型：
- 字符串输入：解析为浮点数
- 整数输入：转为浮点数

布尔类型：
- 字符串输入："true"/"1"/"yes"/"on" 转为 true，其他转为 false
- 其他类型：转为布尔值

数组类型：
- 字符串输入：尝试 JSON 解析
- 其他类型：检查是否为列表

对象类型：
- 字符串输入：尝试 JSON 解析
- 其他类型：检查是否为字典

**枚举验证**

如果参数定义包含 enum 字段：
- 验证输入值是否在枚举列表中
- 区分大小写
- 不在列表中时返回错误

### 2.5 结果截断

**截断策略**

工具返回的结果可能很大（如大文件内容、长列表），需要截断：

1. 将结果转为字符串
2. 检查长度是否超过阈值（10万字符）
3. 如果超过，截断并添加提示信息
4. 返回包含截断标记的结构

**截断格式**

```
{
  "truncated": true,
  "original_size": 150000,
  "truncated_size": 100000,
  "content": "前10万字符内容...\n[结果已截断]"
}
```

### 2.6 错误处理

**错误分类**

- 工具未找到：指定的工具名称不存在
- 权限拒绝：调用者没有使用该工具的权限
- 参数验证失败：参数类型错误或缺少必填项
- 执行错误：工具执行过程中抛出异常
- 执行超时：工具执行超过超时时间

**错误响应格式**

所有错误统一格式：
```
{
  "tool_call_id": "call_xxx",
  "status": "error",
  "error": "ErrorType",
  "message": "人类可读的错误描述"
}
```

**成功响应格式**

```
{
  "tool_call_id": "call_xxx",
  "status": "success",
  "result": 工具返回的结果
}
```

### 2.7 工具上下文

**Context 作用**

ToolContext 提供工具执行所需的环境：
- 访问 Runtime 获取其他模块
- 获取当前智能体信息
- 获取工作空间
- 发送消息

**提供的方法**

- get_workspace(): 获取当前工作空间实例
- get_agent(): 获取当前智能体实例
- get_service(name): 获取指定服务
- send_message(to, content): 发送消息给其他智能体

**设计原因**

Context 模式的优势：
- 不暴露 RuntimeState 内部实现
- 工具只能访问允许的方法
- 自动注入当前智能体ID，防止伪造

## 3. 内置工具清单

### 3.1 组织管理工具组（org_management）

| 工具名 | 功能 | 关键参数 |
|-------|------|---------|
| create_role | 创建新岗位 | name, role_prompt, parentRoleId |
| spawn_agent_with_task | 创建智能体并分配任务 | roleId, task, name |
| delete_agent | 删除智能体 | agentId |
| get_agent_info | 获取智能体信息 | agentId |
| get_all_roles | 获取所有岗位 | 无 |
| get_role_agents | 获取岗位下的智能体 | roleId |

### 3.2 工作空间工具组（workspace）

| 工具名 | 功能 | 关键参数 |
|-------|------|---------|
| replace_file | 写入文件 | path, content, encoding |
| read_file | 读取文件 | path, offset, length |
| delete_file | 删除文件 | path |
| create_directory | 创建目录 | path |
| list_directory | 列出目录内容 | path |
| get_workspace_summary | 获取工作空间摘要 | 无 |

### 3.3 代码执行工具组（execution）

| 工具名 | 功能 | 关键参数 |
|-------|------|---------|
| run_javascript | 执行 JavaScript | code, timeout, returnCanvas |
| run_python | 执行 Python | code, timeout, packages |

### 3.4 通信工具组（communication）

| 工具名 | 功能 | 关键参数 |
|-------|------|---------|
| send_message | 发送消息 | to, message, delayMs |

### 3.5 LLM 工具组（llm）

| 工具名 | 功能 | 关键参数 |
|-------|------|---------|
| ask_llm | 向 LLM 提问 | prompt, context, serviceId |

## 4. 工具权限配置

### 4.1 配置格式

智能体配置中的工具权限：
```json
{
  "allowed_tools": [
    "workspace.*",
    "communication.send_message",
    "org_management.get_agent_info"
  ]
}
```

### 4.2 通配符支持

- 精确匹配："workspace.replace_file"
- 分组通配："workspace.*"（允许 workspace 组所有工具）
- 全部允许：空数组或不配置

## 5. 与 LLM 的集成

### 5.1 工具定义转换

将内部工具定义转换为 OpenAI Function Calling 格式：

```json
{
  "type": "function",
  "function": {
    "name": "tool_name",
    "description": "工具描述",
    "parameters": {
      "type": "object",
      "properties": { ... },
      "required": [ ... ]
    }
  }
}
```

### 5.2 工具调用解析

解析 LLM 响应中的 tool_calls：
- 提取工具名称
- 解析参数 JSON
- 调用 ToolExecutor.execute
- 将结果返回给 LLM
