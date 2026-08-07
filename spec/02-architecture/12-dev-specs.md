# 开发规范

## 代码组织

**文件大小限制**
- 单个文件不超过 500 行（不含注释和空行）
- 超过则拆分为多个文件或子模块

**模块划分原则**
- 按职责划分，高内聚低耦合
- 每个模块有明确的接口
- 避免循环依赖

## 命名规范

**Python 代码**
- 类名：PascalCase
- 函数/变量：snake_case
- 常量：UPPER_SNAKE_CASE
- 私有成员：_leading_underscore

**API 设计**
- URL：kebab-case
- JSON 字段：camelCase
- Python 字段：snake_case（通过 Pydantic alias 映射）

## 文档规范

**代码注释**
- 所有公共类和方法必须有文档字符串
- 复杂逻辑需要行内注释
- 文档字符串使用 Google 风格

**设计文档**
- 架构决策需要文档记录
- 复杂功能需要设计文档
- API 变更需要更新接口文档
