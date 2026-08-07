# Message Validator 消息验证器

## 1. 职责

Message Validator 负责验证结构化消息格式的合法性，主要用于智能体间通信的消息格式校验。

支持的验证类型：
- 任务简报（Task Brief）
- 自我介绍请求/响应
- 协作请求/响应
- 状态报告
- 通用消息

## 2. 内部工作机制

### 2.1 消息类型识别

**类型字段**

每条结构化消息必须包含 type 字段，用于识别消息类型：
- TASK_ASSIGNMENT: 任务分配
- INTRODUCTION_REQUEST: 自我介绍请求
- INTRODUCTION_RESPONSE: 自我介绍响应
- COLLABORATION_REQUEST: 协作请求
- COLLABORATION_RESPONSE: 协作响应
- STATUS_REPORT: 状态报告
- GENERAL: 通用消息

**类型分发**

根据 type 字段的值，将消息分发到对应的验证器：
- 如果 type 不存在或未知，返回验证错误
- 如果类型匹配，执行对应的验证规则
- 验证失败返回详细的错误信息

### 2.2 任务简报验证

**必填字段**

任务简报是最严格的消息类型，必须包含：
- objective: 任务目标（字符串）
- constraints: 约束条件（数组）
- inputs: 输入说明（对象）
- outputs: 输出说明（对象）
- completion_criteria: 完成标准（字符串）

**字段类型检查**

每个字段都有严格的类型要求：
- objective 必须是字符串，不能为空
- constraints 必须是数组，可以为空但不能是 null
- inputs 和 outputs 必须是对象，描述输入输出规范
- completion_criteria 必须是字符串

**兼容性处理**

为了兼容不同命名风格，验证器接受两种字段名：
- 驼峰命名: completionCriteria, taskObjective
- 蛇形命名: completion_criteria, task_objective

验证时会尝试两种命名查找字段。

**嵌套验证**

对于复杂的嵌套对象，递归验证每个字段：
- 检查嵌套对象的必填字段
- 验证数组元素的类型一致性
- 限制嵌套深度防止循环引用

### 2.3 自我介绍验证

**请求字段**

自我介绍请求：
- role: 请求者角色（可选）
- purpose: 介绍目的（可选）

**响应字段**

自我介绍响应：
- name: 智能体名称（必需）
- role: 岗位职责（必需）
- capabilities: 能力列表（可选，数组）
- currentTask: 当前任务（可选）

### 2.4 协作消息验证

**请求字段**

协作请求：
- collaborationType: 协作类型（必需）
- description: 协作描述（必需）
- expectedOutcome: 预期结果（可选）
- timeline: 时间线（可选）

**响应字段**

协作响应：
- accepted: 是否接受（布尔值，必需）
- reason: 原因（拒绝时必需）
- counterProposal: 反提案（可选）

### 2.5 状态报告验证

**字段要求**

状态报告：
- status: 状态值（必需）
- progress: 进度百分比（可选，0-100）
- details: 详细信息（可选）
- blockers: 阻塞项（可选，数组）

**状态值枚举**

状态值必须是预定义的枚举之一：
- in_progress: 进行中
- completed: 已完成
- blocked: 被阻塞
- waiting: 等待中
- cancelled: 已取消

### 2.6 通用消息验证

**宽松规则**

通用消息（GENERAL 类型）使用宽松验证：
- 只检查 payload 是否存在
- 不限制 payload 的具体结构
- 允许任意自定义字段

### 2.7 验证流程

**完整流程**

1. **类型检查**
   - 验证消息对象是否包含 type 字段
   - 检查 type 值是否在支持的类型列表中
   - 如果无效，返回"未知消息类型"错误

2. **分发验证**
   - 根据 type 选择对应的验证函数
   - 调用专门的验证器

3. **必填字段检查**
   - 检查所有必需字段是否存在
   - 检查字段值是否为 null 或 undefined
   - 缺失必填字段时返回具体字段名

4. **类型检查**
   - 检查每个字段值的类型
   - 字符串、数字、布尔、数组、对象
   - 类型不匹配时返回错误

5. **格式检查**
   - 检查字符串是否为空（如果要求非空）
   - 检查数值是否在有效范围
   - 检查数组长度（如果要求非空）

6. **嵌套验证**
   - 对对象类型的字段递归验证
   - 对数组类型的元素逐个验证
   - 控制递归深度防止栈溢出

7. **返回结果**
   - 所有检查通过返回成功
   - 任一检查失败返回错误详情

### 2.8 错误处理

**错误类型**

- MISSING_TYPE: 缺少 type 字段
- UNKNOWN_TYPE: 未知的消息类型
- MISSING_FIELD: 缺少必填字段
- TYPE_MISMATCH: 字段类型不匹配
- INVALID_FORMAT: 格式错误（如空字符串）
- INVALID_VALUE: 值不在有效范围内

**错误格式**

```
{
  "valid": false,
  "error": {
    "type": "MISSING_FIELD",
    "field": "objective",
    "message": "Task brief missing required field: objective"
  }
}
```

**多条错误**

可以配置收集所有错误而非遇到第一个就返回：

```
{
  "valid": false,
  "errors": [
    { "type": "MISSING_FIELD", "field": "objective" },
    { "type": "TYPE_MISMATCH", "field": "constraints", "expected": "array" }
  ]
}
```

### 2.9 使用场景

**发送前验证**

智能体调用 send_message 前，验证任务简报格式：
- 确保消息能被接收方正确理解
- 提前发现格式错误
- 提供清晰的错误提示

**接收后验证**

收到结构化消息后验证：
- 确认消息格式符合预期
- 安全地访问字段
- 拒绝格式错误的消息

**API 输入验证**

HTTP API 接收消息时验证：
- 防止恶意输入
- 确保数据完整性
- 返回友好的错误信息

## 3. 配置

```json
{
  "messageValidator": {
    "strictMode": true,
    "collectAllErrors": false,
    "maxNestingDepth": 5,
    "allowedTypes": ["TASK_ASSIGNMENT", "INTRODUCTION_REQUEST", "INTRODUCTION_RESPONSE"]
  }
}
```

### 配置项说明

- strictMode: 严格模式，额外检查警告级别的规则
- collectAllErrors: 是否收集所有错误（而非遇到第一个就返回）
- maxNestingDepth: 最大嵌套验证深度
- allowedTypes: 允许的消息类型列表（空表示允许所有）
