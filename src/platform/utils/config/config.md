# 配置工具模块

## 概述

配置工具模块负责管理应用程序的所有配置文件，包括读取、写入、验证等操作。本模块提供统一的配置管理接口，支持应用配置、LLM 配置和 LLM 服务配置的完整生命周期管理。

## 设计原则

1. **配置文件优先级**：优先加载 `.local.json` 文件，如果不存在则加载 `.json` 文件
2. **写入策略**：所有写入操作都针对 `.local.json` 文件，保护默认配置不被修改
3. **自动创建**：如果 `.local.json` 不存在，写入时会自动从 `.json` 复制或创建空配置
4. **安全处理**：API Key 在返回时自动掩码，只显示最后 4 个字符
5. **容错设计**：配置文件不存在时返回合理的默认值，避免系统崩溃

## 模块列表

### config.js

- **职责**：统一的配置管理器，提供配置文件的读取、写入、验证等功能
- **核心功能**：
  - **应用配置管理**：
    - 读取应用配置（app.json / app.local.json）
    - 处理日志配置和数据目录
    - 加载 LLM 服务配置
  - **LLM 配置管理**：
    - 获取和保存 LLM 配置
    - 验证 LLM 配置的完整性
  - **LLM 服务管理**：
    - 获取 LLM 服务列表
    - 添加、更新、删除 LLM 服务
    - 验证 LLM 服务配置
  - **工具方法**：
    - API Key 掩码处理
    - 配置文件存在性检查
- **设计约束**：
  - 配置目录路径在构造函数中统一处理（相对路径转绝对路径）
  - 优先加载 .local.json 文件
  - 写入操作总是针对 .local.json 文件
  - 文件不存在时返回合理的默认值
- **依赖关系**：
  - node:fs/promises（文件读写）
  - node:fs（文件存在性检查）
  - node:path（路径处理）

## 使用示例

### 基本使用

```javascript
import { Config } from "./utils/config/config.js";

// 创建配置管理器实例
const config = new Config("config");

// 加载应用配置
const appConfig = await config.loadApp({ dataDir: "./data" });
console.log("应用配置:", appConfig);
```

### 应用配置管理

```javascript
// 加载应用配置（支持自定义数据目录）
const appConfig = await config.loadApp({ 
  dataDir: "./data" 
});

// 配置包含以下字段：
// - promptsDir: 提示词目录
// - artifactsDir: 工件目录
// - runtimeDir: 运行时状态目录
// - maxSteps: 最大步数
// - maxToolRounds: 最大工具调用轮数
// - httpPort: HTTP 端口
// - enableHttp: 是否启用 HTTP 服务
// - llm: LLM 配置
// - logging: 日志配置
// - dataDir: 数据目录
// - modules: 模块配置
// - contextLimit: 上下文限制
// - llmServices: LLM 服务列表
```

### LLM 配置管理

```javascript
// 获取 LLM 配置
const llmResult = await config.getLlm();
console.log("LLM 配置:", llmResult.llm);
console.log("配置来源:", llmResult.source); // "local" 或 "default"

// 保存 LLM 配置
await config.saveLlm({
  baseURL: "http://localhost:8080",
  model: "test-model",
  apiKey: "sk-xxx",
  maxConcurrentRequests: 2,
  maxTokens: 4096,
  capabilities: { input: ["text"], output: ["text"] }
});

// 验证 LLM 配置
const validation = config.validateLlm({
  baseURL: "http://localhost:8080",
  model: "test-model"
});
if (!validation.valid) {
  console.error("配置验证失败:", validation.errors);
}
```

### LLM 服务管理

```javascript
// 获取 LLM 服务列表
const servicesResult = await config.getServices();
console.log("服务列表:", servicesResult.services);
console.log("配置来源:", servicesResult.source); // "local", "default" 或 "none"

// 添加 LLM 服务
const newService = await config.addService({
  id: "my-service",
  name: "My Service",
  baseURL: "http://localhost:8080",
  model: "test-model",
  apiKey: "sk-xxx",
  maxConcurrentRequests: 2,
  maxTokens: 4096,
  capabilityTags: ["chat", "completion"],
  capabilities: { input: ["text"], output: ["text"] },
  description: "My custom LLM service"
});
console.log("添加的服务:", newService); // apiKey 已掩码

// 更新 LLM 服务
const updatedService = await config.updateService("my-service", {
  model: "updated-model",
  maxTokens: 8192
});
console.log("更新后的服务:", updatedService); // apiKey 已掩码

// 删除 LLM 服务
await config.deleteService("my-service");

// 验证 LLM 服务配置
const serviceValidation = config.validateService({
  id: "my-service",
  name: "My Service",
  baseURL: "http://localhost:8080",
  model: "test-model"
});
if (!serviceValidation.valid) {
  console.error("服务配置验证失败:", serviceValidation.errors);
}
```

### 工具方法

```javascript
// API Key 掩码
const masked = config.maskApiKey("sk-1234567890abcdef");
console.log(masked); // ****cdef

// 检查本地配置文件是否存在
const hasLocalApp = config.hasLocalApp();
const hasLocalServices = config.hasLocalServices();
console.log("本地应用配置存在:", hasLocalApp);
console.log("本地服务配置存在:", hasLocalServices);
```

## 依赖关系

- config.js 依赖文件系统（fs/promises）
- config.js 依赖 path 模块

## 注意事项

1. 配置文件优先级：`.local.json` > `.json`
2. 所有写入操作都针对 `.local.json` 文件
3. 如果 `.local.json` 不存在，写入时会自动从 `.json` 复制
4. 配置目录路径在构造函数中统一处理（相对路径转绝对路径）
5. API Key 在返回时会自动掩码，只显示最后 4 个字符

## 配置文件结构

### app.json / app.local.json

应用主配置文件，包含系统的核心配置：

```json
{
  "promptsDir": "config/prompts",
  "artifactsDir": "data/artifacts",
  "runtimeDir": "data/state",
  "maxSteps": 200,
  "maxToolRounds": 200,
  "httpPort": 3000,
  "enableHttp": false,
  "llm": {
    "baseURL": "http://localhost:8080",
    "model": "test-model",
    "apiKey": "sk-xxx",
    "maxConcurrentRequests": 2,
    "maxTokens": 4096,
    "capabilities": {
      "input": ["text"],
      "output": ["text"]
    }
  },
  "loggingConfigPath": "config/logging.json",
  "modules": {},
  "contextLimit": null
}
```

### llmservices.json / llmservices.local.json

LLM 服务配置文件，包含多个 LLM 服务的配置：

```json
{
  "services": [
    {
      "id": "my-service",
      "name": "My Service",
      "baseURL": "http://localhost:8080",
      "model": "test-model",
      "apiKey": "sk-xxx",
      "maxConcurrentRequests": 2,
      "maxTokens": 4096,
      "capabilityTags": ["chat", "completion"],
      "capabilities": {
        "input": ["text"],
        "output": ["text"]
      },
      "description": "My custom LLM service"
    }
  ]
}
```

## API 参考

### Config 类

#### 构造函数

```javascript
constructor(configDir, logger = null)
```

- **参数**：
  - `configDir` (string): 配置目录路径（相对或绝对）
  - `logger` (object, 可选): 日志记录器对象，需包含 debug, info, warn, error 方法

#### 应用配置方法

##### loadApp(options)

加载应用配置。

- **参数**：
  - `options` (object, 可选): 配置选项
    - `dataDir` (string, 可选): 数据目录路径
- **返回值**：Promise<object> - 应用配置对象
- **异常**：配置文件不存在时抛出错误

#### LLM 配置方法

##### getLlm()

获取 LLM 配置。

- **返回值**：Promise<{llm: object, source: string}>
  - `llm`: LLM 配置对象
  - `source`: 配置来源（"local" 或 "default"）
- **异常**：配置文件不存在时抛出错误

##### saveLlm(llmConfig)

保存 LLM 配置。

- **参数**：
  - `llmConfig` (object): LLM 配置对象
    - `baseURL` (string): LLM 服务地址
    - `model` (string): 模型名称
    - `apiKey` (string, 可选): API Key
    - `maxConcurrentRequests` (number, 可选): 最大并发请求数，默认 2
    - `maxTokens` (number, 可选): 最大 token 数
    - `capabilities` (object, 可选): 能力配置
- **返回值**：Promise<void>
- **异常**：app.json 不存在时抛出错误

##### validateLlm(config)

验证 LLM 配置。

- **参数**：
  - `config` (object): LLM 配置对象
- **返回值**：{valid: boolean, errors: object}
  - `valid`: 是否有效
  - `errors`: 错误信息对象

#### LLM 服务方法

##### getServices()

获取 LLM 服务列表。

- **返回值**：Promise<{services: object[], source: string}>
  - `services`: 服务列表
  - `source`: 配置来源（"local", "default" 或 "none"）

##### addService(service)

添加 LLM 服务。

- **参数**：
  - `service` (object): 服务配置对象
    - `id` (string): 服务 ID
    - `name` (string): 服务名称
    - `baseURL` (string): 服务地址
    - `model` (string): 模型名称
    - `apiKey` (string, 可选): API Key
    - `maxConcurrentRequests` (number, 可选): 最大并发请求数，默认 2
    - `maxTokens` (number, 可选): 最大 token 数
    - `capabilityTags` (string[], 可选): 能力标签
    - `capabilities` (object, 可选): 能力配置
    - `description` (string, 可选): 服务描述
- **返回值**：Promise<object> - 添加的服务（apiKey 已掩码）
- **异常**：服务 ID 已存在时抛出错误

##### updateService(serviceId, service)

更新 LLM 服务。

- **参数**：
  - `serviceId` (string): 服务 ID
  - `service` (object): 服务配置对象（字段同 addService）
- **返回值**：Promise<object> - 更新后的服务（apiKey 已掩码）
- **异常**：服务不存在时抛出错误

##### deleteService(serviceId)

删除 LLM 服务。

- **参数**：
  - `serviceId` (string): 服务 ID
- **返回值**：Promise<void>
- **异常**：服务不存在时抛出错误

##### validateService(service)

验证 LLM 服务配置。

- **参数**：
  - `service` (object): 服务配置对象
- **返回值**：{valid: boolean, errors: object}
  - `valid`: 是否有效
  - `errors`: 错误信息对象

#### 工具方法

##### maskApiKey(apiKey)

掩码 API Key，只显示最后 4 个字符。

- **参数**：
  - `apiKey` (string): 原始 API Key
- **返回值**：string - 掩码后的 API Key（格式：****xxxx）

##### hasLocalApp()

检查本地应用配置文件是否存在。

- **返回值**：boolean - 是否存在 app.local.json

##### hasLocalServices()

检查本地 LLM 服务配置文件是否存在。

- **返回值**：boolean - 是否存在 llmservices.local.json

## 内部实现

### 私有方法

- `_loadOptionalJson(absPath)`: 尝试加载 JSON 文件，不存在则返回 null
- `_validateMaxConcurrentRequests(value)`: 验证并返回有效的最大并发请求数
- `_loadLlmServicesConfigInternal()`: 加载 LLM 服务配置（内部使用）
- `_ensureLocalServices()`: 确保本地 LLM 服务配置文件存在

### 错误处理

- 配置文件不存在时抛出明确的错误信息
- 配置文件解析失败时返回空配置或默认值
- 服务 ID 冲突时抛出错误
- 服务不存在时抛出错误

## 测试

配置模块的测试文件位于 `test/platform/config_service.test.js`，包含以下测试场景：

- 配置文件加载（优先级测试）
- LLM 配置的读取和保存
- LLM 服务的增删改查
- 配置验证
- API Key 掩码
- 错误处理

## 历史变更

### 阶段 3：模块合并和拆分（任务 10.1-10.4）

- **任务 10.1-10.2**：分析并整合配置加载逻辑
  - 保留 config.js 作为统一的配置管理器
  - 移除了 config_service.js（功能已整合到 config.js）
  - 职责清晰：config.js 负责所有配置管理功能
- **任务 10.3**：更新配置模块的测试
  - 测试覆盖所有公共接口
  - 确保测试通过
- **任务 10.4**：更新配置模块的文档
  - 更新模块注释
  - 更新目录说明文档（本文档）
