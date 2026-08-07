/**
 * PolicyEngine — 命令策略匹配引擎
 *
 * 纯函数，无副作用。用于判断一条命令是否应被允许、拒绝或需要确认。
 * v2: 支持 glob 通配符、正则表达式、复合命令拆分、编译缓存
 */

/** @typedef {{type: "glob"|"regex", pattern: string, reason?: string}} PolicyEntry */
/** @typedef {{whitelist: PolicyEntry[], blacklist: PolicyEntry[]}} CmdPolicy */

const IS_WINDOWS = process.platform === "win32";

/**
 * 规范化命令字符串
 * - 去掉路径前缀（取 basename）
 * - 去掉可执行文件后缀（.exe, .bat, .cmd, .ps1）
 * - 后续带路径分隔符的参数取 basename
 * - 组合为 startsWith 可匹配的字符串
 *
 * @param {string} command - 命令名（第一个 token）
 * @param {string[]} [args] - 命令参数
 * @returns {string} 规范化后的匹配字符串，如 "python -i"
 */
export function normalizeCommand(command, args = []) {
  if (!command || typeof command !== "string") return "";

  // 1. 第一个 token：去路径，去后缀
  let first = command.trim();
  // 去掉路径前缀
  const lastSlash = Math.max(first.lastIndexOf("/"), first.lastIndexOf("\\"));
  if (lastSlash >= 0) {
    first = first.slice(lastSlash + 1);
  }
  // 去掉可执行文件后缀
  first = first.replace(/\.(exe|bat|cmd|ps1|com)$/i, "");

  // 2. 构建规范化字符串
  const parts = [first.toLowerCase()];

  // 3. 后续参数：取 basename（如果有路径分隔符）
  for (const arg of args) {
    if (!arg || typeof arg !== "string") continue;
    const lastSep = Math.max(arg.lastIndexOf("/"), arg.lastIndexOf("\\"));
    const normalized = lastSep >= 0 ? arg.slice(lastSep + 1) : arg;
    parts.push(normalized.toLowerCase());
  }

  return parts.join(" ");
}

/**
 * 按复合命令分隔符拆分，引号内不拆分。
 * 分隔符: && || ; | |& &
 *
 * @param {string} rawCommand - 原始命令字符串
 * @returns {string[]} 拆分后的子命令列表
 */
export function splitCompoundCommand(rawCommand) {
  if (!rawCommand || typeof rawCommand !== "string") return [];

  const segments = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < rawCommand.length) {
    const ch = rawCommand[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }

    if (!inSingle && !inDouble) {
      // 双字符分隔符优先
      if (ch === "&" && rawCommand[i + 1] === "&") {
        segments.push(current);
        current = "";
        i += 2;
        continue;
      }
      if (ch === "|" && rawCommand[i + 1] === "|") {
        segments.push(current);
        current = "";
        i += 2;
        continue;
      }
      if (ch === "|" && rawCommand[i + 1] === "&") {
        segments.push(current);
        current = "";
        i += 2;
        continue;
      }
      // 单字符分隔符 & ; |
      if (ch === "&" || ch === ";") {
        segments.push(current);
        current = "";
        i++;
        continue;
      }
      // | 单字符（已排除 || 和 |&）
      if (ch === "|") {
        segments.push(current);
        current = "";
        i++;
        continue;
      }
    }

    current += ch;
    i++;
  }

  segments.push(current);
  return segments.map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * 将 glob 模式转换为正则表达式片段
 * 规则：. + ^ $ { } ( ) | [ ] \ → 转义; * → .*; ? → .
 *
 * @param {string} pattern - glob 模式
 * @returns {string} 正则表达式源字符串
 */
function globToRegexSource(pattern) {
  return pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
}

/**
 * 编译策略条目为预编译的正则对象数组
 * 编译结果：{ original: PolicyEntry, regex: RegExp }
 *
 * @param {PolicyEntry[]} entries - 策略条目列表
 * @returns {{original: PolicyEntry, regex: RegExp}[]}
 */
export function compileEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const compiled = [];
  for (const entry of entries) {
    if (!entry || !entry.pattern || typeof entry.pattern !== "string") continue;
    try {
      let regex;
      if (entry.type === "regex") {
        regex = new RegExp(entry.pattern, "i");
      } else {
        // glob → regex，锚定开头
        const source = globToRegexSource(entry.pattern);
        regex = new RegExp("^" + source, "i");
      }
      compiled.push({ original: entry, regex });
    } catch {
      // 无效的正则，跳过此条目
    }
  }
  return compiled;
}

/**
 * 检查策略
 *
 * 匹配逻辑（strictest-segment-wins）：
 * 1. 拆分复合命令（&& || ; | |& &）
 * 2. 每个子命令规范化后做编译匹配
 * 3. 任意子命令命中黑名单 → 整体 reject
 * 4. 所有子命令命中白名单 → 整体 allow
 * 5. 其他 → confirm
 *
 * 编译缓存：挂载在 policy._compiledBlacklist / policy._compiledWhitelist
 *
 * @param {string} rawCommand - 原始命令字符串（含 command 和 args）
 * @param {CmdPolicy} policy - 策略对象
 * @returns {{action: 'allow'|'reject'|'confirm', matchEntry: PolicyEntry|null, segment: string|null}}
 */
export function checkPolicy(rawCommand, policy) {
  if (!rawCommand || typeof rawCommand !== "string") {
    return { action: "reject", matchEntry: null, segment: null };
  }

  // 编译缓存
  if (!policy._compiledBlacklist) {
    policy._compiledBlacklist = compileEntries(policy.blacklist ?? []);
  }
  if (!policy._compiledWhitelist) {
    policy._compiledWhitelist = compileEntries(policy.whitelist ?? []);
  }

  // 拆分复合命令
  const segments = splitCompoundCommand(rawCommand);

  // 空命令 → reject
  if (segments.length === 0) {
    return { action: "reject", matchEntry: null, segment: null };
  }

  let allInWhitelist = true;

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    // 将 segment 拆为 command + args
    const tokens = trimmed.split(/\s+/);
    const command = tokens[0];
    const args = tokens.slice(1);
    const normalized = normalizeCommand(command, args);

    // 1. 黑名单优先 — 任意命中 → reject
    for (const compiled of policy._compiledBlacklist) {
      if (compiled.regex.test(normalized)) {
        return {
          action: "reject",
          matchEntry: compiled.original,
          segment: trimmed
        };
      }
    }

    // 2. 白名单检查
    const inWhitelist = policy._compiledWhitelist.some(
      c => c.regex.test(normalized)
    );
    if (!inWhitelist) {
      allInWhitelist = false;
    }
  }

  // 3. 所有子命令都在白名单 → allow
  if (allInWhitelist) {
    return { action: "allow", matchEntry: null, segment: null };
  }

  // 4. 需要确认
  return { action: "confirm", matchEntry: null, segment: null };
}
