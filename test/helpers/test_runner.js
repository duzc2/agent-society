import assert from "node:assert";

// 辅助: 断言 mock 函数被某组参数调用过
export function assertCalledWith(fn, ...args) {
  const calls = fn.mock?.calls ?? [];
  const found = calls.some(c => {
    const callArgs = Array.isArray(c) ? c : c.arguments;
    try { assert.deepStrictEqual(callArgs, args); return true; }
    catch { return false; }
  });
  assert.ok(found, `Expected mock to be called with ${JSON.stringify(args)}`);
}

// 辅助: 子集匹配
export function assertSubset(actual, expected) {
  if (expected === actual) return;
  if (expected != null && typeof expected === "object") {
    assert.ok(typeof actual === "object" && actual !== null);
    for (const [key, val] of Object.entries(expected)) {
      assert.ok(key in actual, `Expected key "${key}"`);
      assertSubset(actual[key], val);
    }
  } else {
    assert.strictEqual(actual, expected);
  }
}
