# Agent Society 测试体系文档

## 测试概览

本项目采用 Node.js 内置测试框架，支持单元测试、集成测试和端到端测试。

### 测试统计

- **总测试数**: 645+
- **通过**: 623+
- **跳过**: 2
- **失败**: 20 (主要为浏览器环境相关测试)

## 测试目录结构

```
test/
├── agents/                    # Agent 相关测试
│   └── agent.skill_cache.test.js
├── integration/               # 集成测试
├── modules/                   # 模块测试
│   ├── chrome.test.js         # Chrome 浏览器模块
│   ├── chrome_devtools.test.js
│   ├── chrome_selector_sanitization.test.js

│   ├── ssh.test.js            # SSH 模块
│   ├── ui_page.test.js        # UI 页面模块
│   └── ...
├── platform/                  # 平台核心测试
│   ├── runtime_full.test.js   # Runtime 核心功能
│   ├── org_primitives_full.test.js # OrgPrimitives 功能
│   ├── browser_javascript_executor.test.js # 浏览器 JS 执行器
│   └── ...
├── web/                       # Web 前端测试
│   ├── agent-list.test.js
│   ├── message.test.js
│   └── ...
├── e2e.test.js               # 端到端测试
├── packaging.test.js         # 打包测试
└── start.test.js             # 启动脚本测试
```

## 测试类型

### 1. 单元测试 (Unit Tests)

测试单个模块或函数的功能，不依赖外部服务。

**示例**:
- `test/modules/chrome.test.js` - Chrome 模块接口测试
- `test/platform/config_full.test.js` - 配置管理测试

### 2. 集成测试 (Integration Tests)

测试多个模块之间的协作。

**示例**:
- `test/e2e.test.js` - 系统端到端测试

### 3. 属性测试 (Property Tests)

使用 fast-check 进行基于属性的测试。

**示例**:
- `test/packaging.test.js` - 打包脚本属性测试
- `test/platform/browser_javascript_executor.test.js` - JS 执行器属性测试

## 运行测试

### 运行所有测试

```bash
node --test
```

### 运行特定测试文件

```bash
node --test test/platform/runtime_full.test.js
```

### 运行特定测试组

```bash
node --test --test-name-pattern "Runtime Core"
```

### 覆盖率报告

```bash
node --test --experimental-test-coverage
```

## 测试环境要求

### 必需环境

- **Node.js**: JavaScript 运行时和测试框架

### 可选环境

- **Chrome**: 浏览器相关测试需要安装 Chrome

- **PowerShell**: Windows 自动化测试需要 PowerShell

## 测试辅助工具

### Mock 和 Stub

使用 `node:test` 提供的 mock 功能:

```javascript
import { mock } from "node:test";

const fetchMock = mock.fn(async (url, options) => {
  return { ok: true, json: async () => ({}) };
});
```

### 测试生命周期

```javascript
import { beforeEach, afterEach } from "node:test";

beforeEach(async () => {
  // 测试前准备
});

afterEach(async () => {
  // 测试后清理
});
```

### 临时目录

测试使用 `test/.tmp/` 目录存放临时文件:

```javascript
const TEST_DIR = "test/.tmp/my_test";
```

## 已知问题和限制

### 浏览器相关测试

`BrowserJavaScriptExecutor` 相关测试需要 Chrome 浏览器环境。在无头环境或未安装 Chrome 的环境中会失败。

**跳过的测试**:
- Canvas 功能测试
- Promise 解析测试
- 页面隔离测试

### SSH 测试

SSH 模块测试使用模拟连接，不涉及真实 SSH 服务器。

### 自动化测试

Windows 自动化测试（`automation_*.test.js`）需要:
- PowerShell
- Windows UIAutomation 框架
- 微信客户端（微信自动化测试）

## 添加新测试

### 1. 创建测试文件

命名规范: `{模块名}.test.js`

位置: 放在相应的测试目录中

### 2. 编写测试

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MyModule } from "../../src/my_module.js";

describe("MyModule", () => {
  it("应执行某个功能", async () => {
    const result = await MyModule.doSomething();
    assert.strictEqual(result, "expected");
  });
});
```

### 3. 运行测试

```bash
node --test test/path/to/my_module.test.js
```

## 最佳实践

1. **独立性**: 每个测试应该独立运行，不依赖其他测试的状态
2. **清理**: 使用 `afterEach` 清理临时文件和资源
3. **超时**: 长时间运行的测试应设置超时
4. **Mock**: 使用 mock 隔离外部依赖
5. **描述性**: 测试名称应清晰描述测试内容

## 持续集成

测试应在以下场景运行:

1. 每次代码提交前
2. Pull Request 创建时
3. 发布前

## 未来改进

1. **增加覆盖率**: 目标 80%+ 代码覆盖率
2. **并行测试**: 优化测试并行执行
3. **可视化测试**: 添加 UI 测试截图对比
4. **性能基准**: 建立性能测试基准
