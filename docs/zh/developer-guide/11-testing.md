# 测试指南

## 运行测试

```bash
npm test              # 全量单测（node --test + module-mocks）
npm run test:coverage # 带覆盖率
npm run test:ci       # c8 覆盖率 + lcov 报告
npm run test:live     # 真实 LLM 的 live 测试（需要可用服务）
npm run lint          # eslint（src + test）
npm run typecheck     # tsc --noEmit
```

> 项目约定：**永远用 `npm test`**，不要裸 `node --test`——package.json 的 glob 配置排除了 manual 测试文件。

CI（`.github/workflows/test.yml`）：Windows runner，Node 22，push/PR 到 main/develop 触发，含测试、覆盖率检查与依赖审计。

## 测试目录结构

```
test/
├── agents/                 # Agent 实例（skill 缓存、记忆）
├── platform/               # 平台层
│   ├── core/               #   runtime.test.js
│   ├── runtime/            #   回合引擎、工具执行、生命周期、事件…
│   ├── services/           #   按服务域：llm/ conversation/ group_chat/ …
│   └── extensions/         #   module_loader
├── modules/                # 模块：chrome / ssh / ui_page / document / sandbox…
│   └── *.manual.js         #   需要真实环境的手工测试（不进 npm test）
├── web/                    # 前端逻辑单测（纯函数：过滤器、转换器…）
├── sdk/                    # proc_client 协议测试
├── unit/                   # config / skill_learning / bug_fixes（回归）
├── live/                   # live 测试（真实 LLM，单独运行）
├── helpers/                # 测试工具
├── e2e.test.js             # 端到端
├── packaging.test.js       # 打包验证
└── start.test.js           # 启动脚本
```

测试与源码目录镜像对应：改 `src/platform/services/llm/xxx.js` → 测试在 `test/platform/services/llm/`。

## 测试编写规范

### 结构

使用 node:test 标准 API：

```javascript
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

describe("MyService", () => {
  test("应该在输入非法时返回 error 结构", async () => {
    const svc = new MyService({ /* 最小依赖 */ });
    const result = await svc.doWork(null);
    assert.equal(result.error, "invalid_input");
  });
});
```

### 依赖替换

优先用 `--experimental-test-module-mocks`（npm test 已启用）做模块级 mock；对象级依赖直接注入替身。参考 `test/platform/runtime/runtime_tools.*.test.js`。

### 覆盖要求

1. **正确性**：合理输入 → 正确输出（含结构断言，不只是"不报错"）；
2. **鲁棒性**：非法输入、边界值、并发操作——恶意/异常输入要被拒绝而不是崩溃或产生脏数据；
3. **参数多样性**：合理参数、随机参数（可用 fast-check，已在 devDependencies）、错误参数、边界参数；
4. **协议测试**：多端通信要测协议——发送方编码的数据流存文件，接收方解码后与原始数据比对（proc 协议测试即此模式）。

### 命名与组织

- 文件名 `<被测对象>.test.js`；手工测试用 `.manual.js` 后缀；
- 回归测试进 `test/unit/bug_fixes/`，文件名体现修复的问题；
- 一个测试一个关注点；describe 分组；断言信息可读。

## 调试技巧

- 单文件运行：`node --test --experimental-test-module-mocks test/platform/runtime/turn_engine.history.test.js`；
- live 测试（真实 LLM）：`npm run test:live:only`，需先配好可用的 LLM 服务；
- 测试超时：默认继承 node:test 设置；live 用例用 `--test-timeout=120000 --test-force-exit`；
- 启动类问题：看 `agent-society-data/logs/boot.log` 与 `exit-cause.log`。

## 打包验证

`test/packaging.test.js` 验证发布目录结构；打包流程见 [构建与发布](12-build-release.md)。
