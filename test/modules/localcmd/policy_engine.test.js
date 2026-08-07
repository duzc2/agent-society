/**
 * PolicyEngine 测试 — 命令策略匹配引擎 v2
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  normalizeCommand,
  splitCompoundCommand,
  compileEntries,
  checkPolicy
} from "../../../modules/localcmd/policy_engine.js";

// ── normalizeCommand ──

describe("normalizeCommand — 命令规范化", () => {
  it("去掉路径前缀取 basename", () => {
    assert.strictEqual(normalizeCommand("/usr/bin/python"), "python");
    assert.strictEqual(normalizeCommand("C:\\Windows\\System32\\cmd.exe"), "cmd");
  });

  it("去掉可执行文件后缀 .exe .bat .cmd .ps1 .com", () => {
    assert.strictEqual(normalizeCommand("python.exe"), "python");
    assert.strictEqual(normalizeCommand("script.bat"), "script");
    assert.strictEqual(normalizeCommand("run.cmd"), "run");
    assert.strictEqual(normalizeCommand("deploy.ps1"), "deploy");
    assert.strictEqual(normalizeCommand("setup.com"), "setup");
  });

  it("保留第一个 token 和不带路径的参数", () => {
    assert.strictEqual(
      normalizeCommand("python", ["train.py", "--epochs", "10"]),
      "python train.py --epochs 10"
    );
  });

  it("参数中的路径取 basename", () => {
    assert.strictEqual(
      normalizeCommand("python", ["/home/user/script.py"]),
      "python script.py"
    );
  });

  it("全部转小写", () => {
    assert.strictEqual(normalizeCommand("PYTHON"), "python");
    assert.strictEqual(normalizeCommand("Python", ["Script.PY"]), "python script.py");
  });

  it("空字符串或无 command", () => {
    assert.strictEqual(normalizeCommand(""), "");
    assert.strictEqual(normalizeCommand(null), "");
    assert.strictEqual(normalizeCommand(undefined), "");
  });

  it("跳过空参数", () => {
    assert.strictEqual(
      normalizeCommand("git", ["log", "", "--oneline"]),
      "git log --oneline"
    );
  });

  it("command 前后空格被 trim", () => {
    assert.strictEqual(normalizeCommand("  python  "), "python");
  });
});

// ── splitCompoundCommand ──

describe("splitCompoundCommand — 复合命令拆分", () => {
  it("按 && 拆分", () => {
    const result = splitCompoundCommand("echo hello && echo world");
    assert.deepStrictEqual(result, ["echo hello", "echo world"]);
  });

  it("按 || 拆分", () => {
    const result = splitCompoundCommand("cat file || echo fail");
    assert.deepStrictEqual(result, ["cat file", "echo fail"]);
  });

  it("按 ; 拆分", () => {
    const result = splitCompoundCommand("cd /tmp ; ls");
    assert.deepStrictEqual(result, ["cd /tmp", "ls"]);
  });

  it("按 | 拆分", () => {
    const result = splitCompoundCommand("ps aux | grep node");
    assert.deepStrictEqual(result, ["ps aux", "grep node"]);
  });

  it("按 |& 拆分", () => {
    const result = splitCompoundCommand("cmd1 |& cmd2");
    assert.deepStrictEqual(result, ["cmd1", "cmd2"]);
  });

  it("按 & 拆分", () => {
    const result = splitCompoundCommand("server & client");
    assert.deepStrictEqual(result, ["server", "client"]);
  });

  it("多种分隔符混合", () => {
    const result = splitCompoundCommand("a && b || c ; d | e");
    assert.deepStrictEqual(result, ["a", "b", "c", "d", "e"]);
  });

  it("双引号内的分隔符不拆分", () => {
    const result = splitCompoundCommand('echo "hello && world" && echo done');
    assert.deepStrictEqual(result, ['echo "hello && world"', "echo done"]);
  });

  it("单引号内的分隔符不拆分", () => {
    const result = splitCompoundCommand("echo 'a || b' && echo c");
    assert.deepStrictEqual(result, ["echo 'a || b'", "echo c"]);
  });

  it("单引号内双引号不影响拆分", () => {
    const result = splitCompoundCommand("echo '\"测试\"' && echo ok");
    assert.deepStrictEqual(result, ["echo '\"测试\"'", "echo ok"]);
  });

  it("双引号内单引号不影响拆分", () => {
    const result = splitCompoundCommand("echo \"it's ok\" && echo done");
    assert.deepStrictEqual(result, ["echo \"it's ok\"", "echo done"]);
  });

  it("空输入返回空数组", () => {
    assert.deepStrictEqual(splitCompoundCommand(""), []);
    assert.deepStrictEqual(splitCompoundCommand(null), []);
    assert.deepStrictEqual(splitCompoundCommand("   "), []);
  });

  it("无分隔符的简单命令不拆分", () => {
    const result = splitCompoundCommand("git status");
    assert.deepStrictEqual(result, ["git status"]);
  });
});

// ── compileEntries ──

describe("compileEntries — 条目编译", () => {
  it("glob 条目编译为 ^ 锚定的正则", () => {
    const compiled = compileEntries([{ type: "glob", pattern: "rm -rf*" }]);
    assert.strictEqual(compiled.length, 1);
    assert.strictEqual(compiled[0].regex.source, "^rm -rf.*");
    assert.ok(compiled[0].regex.test("rm -rf /tmp"));
  });

  it("glob * 匹配任意字符", () => {
    const compiled = compileEntries([{ type: "glob", pattern: "python*" }]);
    assert.strictEqual(compiled.length, 1);
    assert.ok(compiled[0].regex.test("python"));
    assert.ok(compiled[0].regex.test("python3"));
    assert.ok(compiled[0].regex.test("python train.py"));
  });

  it("regex 条目直接编译", () => {
    const compiled = compileEntries([{ type: "regex", pattern: "^sudo\\s" }]);
    assert.strictEqual(compiled.length, 1);
    assert.ok(compiled[0].regex.test("sudo rm -rf /"));
    assert.ok(!compiled[0].regex.test("not sudo"));
  });

  it("无效的 regex 被跳过（容错）", () => {
    const compiled = compileEntries([
      { type: "regex", pattern: "[invalid" },  // 未闭合字符类
      { type: "glob", pattern: "ok*" }
    ]);
    assert.strictEqual(compiled.length, 1);
    assert.strictEqual(compiled[0].original.type, "glob");
  });

  it("空条目数组或非数组被跳过", () => {
    assert.deepStrictEqual(compileEntries(null), []);
    assert.deepStrictEqual(compileEntries([]), []);
    assert.deepStrictEqual(compileEntries([null]), []);
    assert.deepStrictEqual(compileEntries([{ type: "glob", pattern: "" }]), []);
  });
});

// ── checkPolicy ──

describe("checkPolicy — 策略检查", () => {
  const policy = {
    whitelist: [
      { type: "glob", pattern: "git*" },
      { type: "glob", pattern: "npm*" },
      { type: "glob", pattern: "node*" },
      { type: "regex", pattern: "^echo\\s" }
    ],
    blacklist: [
      { type: "glob", pattern: "rm -rf*" },
      { type: "glob", pattern: "shutdown*" },
      { type: "regex", pattern: "^sudo\\s" }
    ]
  };

  it("白名单匹配 → allow", () => {
    const result = checkPolicy("git status", policy);
    assert.strictEqual(result.action, "allow");
    assert.strictEqual(result.matchEntry, null);
  });

  it("黑名单匹配 → reject", () => {
    const result = checkPolicy("rm -rf /tmp", policy);
    assert.strictEqual(result.action, "reject");
    assert.strictEqual(result.matchEntry.pattern, "rm -rf*");
    assert.strictEqual(result.segment, "rm -rf /tmp");
  });

  it("黑名单优先于白名单", () => {
    const policyWithConflict = {
      whitelist: [{ type: "glob", pattern: "shutdown*" }],
      blacklist: [{ type: "glob", pattern: "shutdown*" }]
    };
    const result = checkPolicy("shutdown -h now", policyWithConflict);
    assert.strictEqual(result.action, "reject");
  });

  it("regex 黑名单匹配", () => {
    const result = checkPolicy("sudo apt update", policy);
    assert.strictEqual(result.action, "reject");
    assert.strictEqual(result.matchEntry.pattern, "^sudo\\s");
  });

  it("regex 白名单匹配", () => {
    const result = checkPolicy("echo hello", policy);
    assert.strictEqual(result.action, "allow");
    assert.strictEqual(result.matchEntry, null);
  });

  it("既不黑白也不白名单 → confirm", () => {
    const result = checkPolicy("unknown_command", policy);
    assert.strictEqual(result.action, "confirm");
    assert.strictEqual(result.matchEntry, null);
    assert.strictEqual(result.segment, null);
  });

  it("空命令 → reject", () => {
    const result = checkPolicy("", policy);
    assert.strictEqual(result.action, "reject");
  });

  it("null/undefined 命令 → reject", () => {
    assert.strictEqual(checkPolicy(null, policy).action, "reject");
    assert.strictEqual(checkPolicy(undefined, policy).action, "reject");
  });

  it("复合命令 — 任一子命令命中黑名单 → 整体 reject", () => {
    const result = checkPolicy("echo hello && rm -rf /tmp", policy);
    assert.strictEqual(result.action, "reject");
    assert.strictEqual(result.matchEntry.pattern, "rm -rf*");
  });

  it("复合命令 — 所有子命令命中白名单 → 整体 allow", () => {
    const result = checkPolicy("git status && npm install && echo done", policy);
    assert.strictEqual(result.action, "allow");
  });

  it("复合命令 — 子命令部分在部分不在白名单 → confirm", () => {
    const result = checkPolicy("git status && unknown_cmd", policy);
    assert.strictEqual(result.action, "confirm");
  });

  it("glob 不区分大小写（Windows/默认）", () => {
    const result = checkPolicy("RM -RF /tmp", policy);
    assert.strictEqual(result.action, "reject");
  });
});

// ── 边界情况 ──

describe("policy_engine 边界情况", () => {
  it("空策略对象 — 黑名单和白名单都空", () => {
    const emptyPolicy = { whitelist: [], blacklist: [] };
    const result = checkPolicy("any command", emptyPolicy);
    assert.strictEqual(result.action, "confirm");
  });

  it("policy 为 null/undefined — 当作空策略", () => {
    const result = checkPolicy("echo hello", { whitelist: null, blacklist: null });
    assert.strictEqual(result.action, "confirm");
  });

  it("glob 中原有的特殊字符被转义", () => {
    const p = { whitelist: [], blacklist: [{ type: "glob", pattern: "rm (test)*" }] };
    // ( ) 应被转义，不应匹配 "rm test"
    const result = checkPolicy("rm test", p);
    assert.strictEqual(result.action, "confirm");
    // 应该匹配 "rm (test)"
    const result2 = checkPolicy("rm (test)", p);
    assert.strictEqual(result2.action, "reject");
  });

  it("命令中的路径被规范化后再匹配", () => {
    const p = {
      whitelist: [{ type: "glob", pattern: "python*" }],
      blacklist: []
    };
    const result = checkPolicy("/usr/local/bin/python3 train.py", p);
    assert.strictEqual(result.action, "allow");
  });

  it("previously compiled cache is reused", () => {
    const p = {
      whitelist: [{ type: "glob", pattern: "node*" }],
      blacklist: []
    };
    checkPolicy("node test.js", p);
    // 第二次调用应使用缓存
    const result = checkPolicy("node index.js", p);
    assert.strictEqual(result.action, "allow");
    assert.ok(p._compiledWhitelist.length > 0);
    assert.ok(p._compiledBlacklist.length === 0);
  });
});
