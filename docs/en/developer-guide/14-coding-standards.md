# Coding Standards

The project's enforced engineering conventions. The same rules live in root-level `CLAUDE.md` / `AGENTS.md` and apply to human contributors and AI collaborators alike.

## Code Organization

- **Single files ≤ 500 lines** (excluding comments); split by responsibility when exceeded;
- Modular: one responsibility per module, high cohesion low coupling, no circular dependencies;
- Directory depth ≤ 3 levels;
- Separate folders for data, config, source, tests;
- **Every directory has a same-named `.md`** (overview / file list / subdirectory list);
- Test directories mirror source (`src/platform/services/llm/` ↔ `test/platform/services/llm/`).

## Null-Value Discipline (iron rule)

**Injected functional components (services, managers, registries, DI objects) must never be null-tolerated**:

```javascript
// ❌ Wrong: null-tolerating a dependency hides initialization bugs
this._registry = options.lifecycleRegistry ?? null;
if (this._registry) { this._registry.register(...); }

// ✅ Correct: use the dependency directly; a missing one fails loudly
this._registry = options.lifecycleRegistry;
this._registry.register(...);
```

- Null tolerance is **only allowed** for external data: user input, file contents, API responses, config parameters (strings/booleans/numbers/thresholds);
- The test: is it built/injected by the program itself (must have a value), or does it come from outside (tolerance allowed)?

## Exception Handling (iron rule)

1. Every `catch` logs completely: `message` + `stack` + business context (URL, method, parameters);
2. `catch (_err)` and `catch {}` that swallow exceptions are forbidden;
3. Log the original error with `log.error(...)` **before** any fallback;
4. Global handlers exist for uncaughtException / unhandledRejection with the same full logging (see `start-wrapper.mjs` and `start.js`);
5. Handling order: print the raw log first → contain the blast radius → deliver a friendly error to the protocol/UI (readable, no sensitive info, states which feature failed and why).

## Comments

- Every function gets a comment: **why it's designed this way, what need it serves, key constraints, key safeguards** — never a restatement of the code;
- Non-trivial algorithm internals get comments too;
- File headers state the module's responsibility, design intent, and main functions;
- Language: Chinese by default (UTF-8); English where the target runtime doesn't support Chinese comments.

## Interfaces & Design

- Design the workflow first, then the interface; design from the caller's perspective;
- Each module has full authority over its own function — no responsibility leakage: deciding "should I call module X" uses only your own data, let X decide for itself;
- Minimal knowledge between modules; for data-mutating steps, state reference-vs-copy explicitly;
- Reuse by semantics: same semantics + same environment → extend and reuse; different semantics → don't reuse even if the code looks identical;
- A semantic pattern repeated three times warrants refactoring into a design pattern; avoid ifelse/switch piles — correctness comes from structure and flow;
- New features reuse existing mechanisms (messaging, events, files) first — no parallel systems.

## Logging

- Get a module logger via `runtime.loggerRoot.forModule("<module>")`;
- Levels controlled per module through `config/logging.json`;
- Structured logs: `log.info("message", { key: value })` for searchability;
- Key lifecycle events (agent creation/termination, LLM call metrics) have dedicated log methods (`logAgentLifecycleEvent` / `logLlmMetrics`).

## Testing

- Run via `npm test` (bare `node --test` forbidden);
- Every functional change ships with tests covering correctness + robustness (boundaries, exceptions, concurrency);
- Communication protocols follow the "encode → write to file → decode → compare" pattern;
- Test parameters span valid / randomized / invalid / boundary;
- Small steps: finish a module → test it → wire it in and test live → manual verification.

## Git & Process

- **All git operations (commit/push/restore) require human confirmation**; no automation tool executes them on its own;
- After every code change: run `npm test` → stop → report results → wait for explicit permission before continuing;
- Don't move files casually; follow existing style, naming, and conventions — don't start your own.

## Dependency Management

- New dependencies require a stated reason; `package.json` `overrides` manages security-version floors;
- Keep runtime dependencies minimal (current core: hono, ai-sdk family, openai, ssh2, puppeteer-core, etc.);
- `npm audit --production` as a pre-release check (integrated in CI).
