# Testing & Quality

## Running Tests

```bash
npm test              # Full suite (node --test + module-mocks)
npm run test:coverage # With coverage
npm run test:ci       # c8 coverage + lcov report
npm run test:live     # Live tests against real LLMs (needs a working service)
npm run lint          # eslint (src + test)
npm run typecheck     # tsc --noEmit
```

> Project rule: **always `npm test`**, never bare `node --test` — the package.json glob excludes manual test files.

CI (`.github/workflows/test.yml`): Windows runner, Node 22, triggered on push/PR to main/develop; runs tests, coverage checks, and dependency audits.

## Test Directory Layout

```
test/
├── agents/                 # Agent instances (skill cache, memory)
├── platform/               # Platform layer
│   ├── core/               #   runtime.test.js
│   ├── runtime/            #   turn engine, tool execution, lifecycle, events…
│   ├── services/           #   per service domain: llm/ conversation/ group_chat/ …
│   └── extensions/         #   module_loader
├── modules/                # Modules: chrome / ssh / ui_page / document / sandbox…
│   └── *.manual.js         #   manual tests needing real environments (not in npm test)
├── web/                    # Frontend logic unit tests (pure functions: filters, converters…)
├── sdk/                    # proc_client protocol tests
├── unit/                   # config / skill_learning / bug_fixes (regression)
├── live/                   # Live tests (real LLMs, run separately)
├── helpers/                # Test utilities
├── e2e.test.js             # End-to-end
├── packaging.test.js       # Packaging verification
└── start.test.js           # Startup scripts
```

Test directories mirror source: change `src/platform/services/llm/xxx.js` → its test lives in `test/platform/services/llm/`.

## Writing Tests

### Structure

Use the standard node:test API:

```javascript
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

describe("MyService", () => {
  test("should return an error structure on invalid input", async () => {
    const svc = new MyService({ /* minimal deps */ });
    const result = await svc.doWork(null);
    assert.equal(result.error, "invalid_input");
  });
});
```

### Dependency Substitution

Prefer module-level mocks via `--experimental-test-module-mocks` (enabled by npm test); for object-level dependencies, inject fakes directly. Reference: `test/platform/runtime/runtime_tools.*.test.js`.

### Coverage Requirements

1. **Correctness**: reasonable inputs → correct outputs (with structural assertions, not just "doesn't throw");
2. **Robustness**: invalid inputs, boundary values, concurrent operations — malicious/abnormal input must be rejected, not crash or produce dirty data;
3. **Parameter variety**: valid, randomized (fast-check is in devDependencies), wrong, and boundary parameters;
4. **Protocol testing**: multi-party communication tests the protocol — the sender's encoded data goes to a file, the receiver decodes and compares against the original (the proc protocol tests follow this pattern).

### Naming & Organization

- File name `<subject>.test.js`; manual tests use the `.manual.js` suffix;
- Regression tests go to `test/unit/bug_fixes/`, named after the fixed issue;
- One test, one concern; group with describe; keep assertion messages readable.

## Debugging

- Single file: `node --test --experimental-test-module-mocks test/platform/runtime/turn_engine.history.test.js`;
- Live tests (real LLM): `npm run test:live:only`, requires a configured LLM service;
- Timeouts: defaults come from node:test; live cases use `--test-timeout=120000 --test-force-exit`;
- Startup issues: read `agent-society-data/logs/boot.log` and `exit-cause.log`.

## Packaging Verification

`test/packaging.test.js` verifies the release directory structure; the packaging flow is in [Build & Release](12-build-release.md).
