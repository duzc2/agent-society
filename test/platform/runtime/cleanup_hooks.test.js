/**
 * 步骤 13: CleanupHookChain 单元测试
 *
 * 测试场景：
 *   1. 所有阶段按序执行
 *   2. 某个阶段超时后自动进入下一阶段（不卡住）
 *   3. 钩子抛出异常后继续执行后续阶段
 *   4. 注册到不存在的阶段不会崩溃
 *   5. 空钩子阶段被跳过
 *   6. 多个钩子注册到同一阶段
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { CleanupHookChain } from "../../../src/platform/runtime/cleanup_hooks.js";
import { makeTestLogger } from "../../helpers/test_logger.js";

/**
 * 创建一个最小 mock runtime 对象，用于 CleanupHookChain 初始化。
 */
function makeRuntime() {
  return {
    log: makeTestLogger("CleanupHooks")
  };
}

describe("CleanupHookChain", () => {

  it("1. 所有阶段按序执行", async () => {
    const runtime = makeRuntime();
    const chain = new CleanupHookChain(runtime);

    const executionOrder = [];

    chain.register('stop_accepting', () => {
      executionOrder.push('stop_accepting');
    });
    chain.register('drain_inflight', () => {
      executionOrder.push('drain_inflight');
    });
    chain.register('persist_state', () => {
      executionOrder.push('persist_state');
    });
    chain.register('close_resources', () => {
      executionOrder.push('close_resources');
    });
    chain.register('flush_logs', () => {
      executionOrder.push('flush_logs');
    });
    chain.register('exit', () => {
      executionOrder.push('exit');
    });

    await chain.execute();

    assert.deepStrictEqual(executionOrder, [
      'stop_accepting',
      'drain_inflight',
      'persist_state',
      'close_resources',
      'flush_logs',
      'exit'
    ]);
  });

  it("2. 某个阶段超时后自动进入下一阶段 (不卡住)", async () => {
    // 用最小化版本测试超时行为：手动构造一个自定义超时的阶段链
    class TestChain extends CleanupHookChain {
      constructor(runtime) {
        super(runtime);
        // 用短超时替换默认阶段
        this._phases = [
          { name: 'fast_pass', timeoutMs: 50, hooks: [] },
          { name: 'slow_block', timeoutMs: 50, hooks: [] },
          { name: 'after_block', timeoutMs: 100, hooks: [] },
        ];
      }
    }

    const runtime = makeRuntime();
    const chain = new TestChain(runtime);

    const executionOrder = [];

    chain.register('fast_pass', () => {
      executionOrder.push('fast_pass');
    });

    // slow_block 注册一个慢速钩子（远超 50ms 超时）
    chain.register('slow_block', () => {
      return new Promise(resolve => setTimeout(resolve, 500));
    });

    chain.register('after_block', () => {
      executionOrder.push('after_block');
    });

    const start = Date.now();
    await chain.execute();
    const elapsed = Date.now() - start;

    assert.ok(executionOrder.includes('fast_pass'));
    // slow_block 超时 (50ms) 后应继续执行 after_block
    assert.ok(executionOrder.includes('after_block'));
    // slow_block 钩子需要 500ms，但阶段超时 50ms 后就应该跳过
    assert.ok(elapsed < 500);
  });

  it("3. 钩子抛出异常后继续执行后续阶段", async () => {
    const runtime = makeRuntime();
    const chain = new CleanupHookChain(runtime);

    let errorLogged = false;
    runtime.log.error = (msg, data) => { errorLogged = true; };

    const executionOrder = [];

    chain.register('stop_accepting', () => {
      executionOrder.push('stop_accepting');
    });

    // drain_inflight 抛出同步异常
    chain.register('drain_inflight', () => {
      executionOrder.push('drain_inflight');
      throw new Error("drain 失败");
    });

    chain.register('persist_state', () => {
      executionOrder.push('persist_state');
    });

    chain.register('exit', () => {
      executionOrder.push('exit');
    });

    await chain.execute();

    // 所有阶段都应该执行，即使 drain_inflight 抛异常
    assert.ok(executionOrder.includes('stop_accepting'));
    assert.ok(executionOrder.includes('drain_inflight'));
    assert.ok(executionOrder.includes('persist_state'));
    assert.ok(executionOrder.includes('exit'));

    assert.strictEqual(errorLogged, true);
  });

  it("3b. 钩子返回 rejected Promise 后继续执行后续阶段", async () => {
    const runtime = makeRuntime();
    const chain = new CleanupHookChain(runtime);

    const executionOrder = [];

    chain.register('stop_accepting', () => {
      executionOrder.push('stop_accepting');
    });

    // drain_inflight 返回 rejected Promise
    chain.register('drain_inflight', () => {
      executionOrder.push('drain_inflight');
      return Promise.reject(new Error("async drain 失败"));
    });

    chain.register('persist_state', () => {
      executionOrder.push('persist_state');
    });

    chain.register('exit', () => {
      executionOrder.push('exit');
    });

    await chain.execute();

    assert.ok(executionOrder.includes('stop_accepting'));
    assert.ok(executionOrder.includes('drain_inflight'));
    assert.ok(executionOrder.includes('persist_state'));
    assert.ok(executionOrder.includes('exit'));
  });

  it("4. 注册到不存在的阶段不会崩溃", async () => {
    const runtime = makeRuntime();
    const chain = new CleanupHookChain(runtime);

    // 不应抛出异常
    assert.doesNotThrow(() => {
      chain.register('nonexistent_phase', () => {});
    });

    // 不应抛出异常（注册后执行）
    chain.register('another_fake_phase', () => {
      throw new Error("should never run");
    });

    // execute 不应崩溃
    await chain.execute();
  });

  it("5. 空钩子阶段被跳过（不记录日志）", async () => {
    const runtime = makeRuntime();
    const chain = new CleanupHookChain(runtime);

    const infoCalls = [];
    const origInfo = runtime.log.info;
    runtime.log.info = (msg, data) => { infoCalls.push([msg, data]); origInfo(msg, data); };

    // 只在最后一个阶段注册钩子
    chain.register('exit', () => {});

    await chain.execute();

    // 只有 exit 阶段有日志
    const phaseLogs = infoCalls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('[Shutdown] 进入阶段')
    );
    assert.strictEqual(phaseLogs.length, 1);
    assert.ok(phaseLogs[0][0].includes('exit'));
  });

  it("6. 多个钩子注册到同一阶段", async () => {
    const runtime = makeRuntime();
    const chain = new CleanupHookChain(runtime);

    const callOrder = [];

    chain.register('persist_state', () => {
      callOrder.push('persist_1');
      return Promise.resolve();
    });

    chain.register('persist_state', () => {
      callOrder.push('persist_2');
      return Promise.resolve();
    });

    chain.register('persist_state', () => {
      callOrder.push('persist_3');
      return Promise.resolve();
    });

    chain.register('exit', () => {
      callOrder.push('exit');
    });

    await chain.execute();

    // 所有三个钩子都应被调用
    assert.ok(callOrder.includes('persist_1'));
    assert.ok(callOrder.includes('persist_2'));
    assert.ok(callOrder.includes('persist_3'));
    // exit 在 persist 之后
    const exitIdx = callOrder.indexOf('exit');
    const persistIdx1 = callOrder.indexOf('persist_1');
    assert.ok(persistIdx1 < exitIdx);
  });

  it("7. getPhaseNames 返回正确的阶段名称列表", () => {
    const runtime = makeRuntime();
    const chain = new CleanupHookChain(runtime);

    assert.deepStrictEqual(chain.getPhaseNames(), [
      'stop_accepting',
      'drain_inflight',
      'persist_state',
      'close_resources',
      'flush_logs',
      'exit'
    ]);
  });

  it("8. getHookCount 返回正确的钩子数", () => {
    const runtime = makeRuntime();
    const chain = new CleanupHookChain(runtime);

    assert.strictEqual(chain.getHookCount('stop_accepting'), 0);
    assert.strictEqual(chain.getHookCount('nonexistent'), -1);

    chain.register('stop_accepting', () => {});
    assert.strictEqual(chain.getHookCount('stop_accepting'), 1);

    chain.register('stop_accepting', () => {});
    assert.strictEqual(chain.getHookCount('stop_accepting'), 2);
  });
});
