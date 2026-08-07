# Agent Society - 全面静态扫描分析报告

**项目**: Agent Society (agent-society-mvp)
**仓库路径**: `C:\Users\ASUS\Desktop\ai-build-ai\agents`
**分析日期**: 2026-05-17
**分析方法**: 行业最高标准全量源代码静态扫描
**分析维度**: 安全性、性能、稳定性、功能性、易用性、代码质量

---

## 一、总览

| 维度 | 发现总数 | CRITICAL | HIGH | MEDIUM | LOW |
|------|---------|----------|------|--------|-----|
| 安全性 | 46 | 4 | 22 | 15 | 5 |
| 性能 | 34 | 0 | 7 | 22 | 5 |
| 稳定性 | 57 | 3 | 12 | 27 | 15 |
| 功能性 | 56 | 3 | 12 | 27 | 14 |
| 易用性与代码质量 | 65 | 1 | 8 | 22 | 34 |
| **合计** | **258** | **11** | **61** | **113** | **73** |

---

## 二、关键发现摘要 (Top 30)

### 安全 (Top 5)

| # | 严重度 | 问题 | 位置 |
|---|--------|------|------|
| 1 | **CRITICAL** | Logger 序列化所有数据对象，无密钥/敏感词过滤，`process.stderr.write` 全局劫持捕获所有库的 stderr 输出 | `src/platform/utils/logger/logger.js:435-526` |
| 2 | **CRITICAL** | LLM 可通过 `localcmd_spawn` 工具在宿主机执行任意 OS 命令，无命令白名单 | `modules/localcmd/tools.js:28-52` |
| 3 | **CRITICAL** | `chrome_navigate` 无 URL 校验，可访问 `http://127.0.0.1`、`file:///etc/passwd`、云元数据服务 | `modules/chrome/features/navigation.js:65-93` |
| 4 | **CRITICAL** | LLM 可通过 `ssh_shell_send` 在远程服务器执行任意 Shell 命令 | `modules/ssh/tools.js:48-67` |
| 5 | **HIGH** | SSH Host Key 验证未接入 ssh2 lib，所有连接无 MITM 防护 | `modules/ssh/connection_manager.js:292-299` |

### 性能 (Top 5)

| # | 严重度 | 问题 | 位置 |
|---|--------|------|------|
| 6 | **HIGH** | `loadConversationSync()` 使用 `readFileSync()` 在 TurnEngine 同步路径上阻塞事件循环 | `src/platform/services/conversation/conversation_manager.js:432-437` |
| 7 | **HIGH** | 前端 App.vue 每2秒执行3个顺序(非并行)API 轮询调用 | `web/v3/src/App.vue:78-105` |
| 8 | **HIGH** | Worker 线程未设置 `resourceLimits`，恶意脚本可 OOM 整个进程 | `src/platform/runtime/javascript_executor.js:297-303` |
| 9 | **HIGH** | 聊天消息列表无虚拟滚动，500条消息创建2000-3000个DOM节点 | `web/v3/src/components/chat/ChatMessageList.vue:851` |
| 10 | **HIGH** | `JSON.stringify(data, null, 2)` 格式化写入2倍磁盘+CPU开销 | `src/platform/services/conversation/conversation_manager.js:261` |

### 稳定性 (Top 7)

| # | 严重度 | 问题 | 位置 |
|---|--------|------|------|
| 11 | **LOW** | `_sendJson` 内层 catch 的 JSON.stringify (操作纯字符串值) 实际不会抛出，三层防御已足够健壮 | `src/platform/services/http/http_server/utilities.js:58-74` |
| 12 | **HIGH** | `compute_scheduler` 在 ingress/runOneStep 中未跳过 `retrying` 状态的 agent，可能导致双工处理 | `src/platform/runtime/compute_scheduler.js:265-269` |
| 13 | **HIGH** | `wakeUpAndProcess` 与主 `_loop()` 之间存在竞态条件 | `src/platform/runtime/compute_scheduler.js:131-150` |
| 14 | **HIGH** | `agent_cancel_manager.abort()` 未调用 `unmarkAgentAsActivelyProcessing()` | `src/platform/runtime/agent_cancel_manager.js` |
| 15 | **HIGH** | 请求 JSON Body 解析无大小限制 (DoS 风险) | `src/platform/services/http/http_server/utilities.js:11-32` |
| 16 | **MEDIUM** | shutdown_manager 的 `process.on()` 监听器在 destroy() 中未被移除 | `src/platform/runtime/shutdown_manager.js:247-361` |
| 17 | **MEDIUM** | `_storeMessage` 使用 `void` 操作符丢失错误上下文 | `src/platform/services/http/http_server/index.js:431-530` |

### 功能性 (Top 5)

| # | 严重度 | 问题 | 位置 |
|---|--------|------|------|
| 16 | **HIGH** | `validateTaskBrief` 静默修改调用者对象（副作用隐藏于验证函数中） | `src/platform/utils/message/task_brief.js:50-52` |
| 17 | **HIGH** | `_collectDescendantAgents` 无尽递归检测，循环引用导致栈溢出 | `src/platform/runtime/agent_queue_manager.js:53-67` |
| 18 | **HIGH** | `send_message` 工具不验证发送者存在性，`"unknown"` 发件人会传播 | `src/platform/runtime/tools_agent.js:482-645` |
| 19 | **HIGH** | 消息格式检验仅警告不阻止（验证基础设施形同虚设） | `src/platform/runtime/tools_agent.js:551-565` |
| 20 | **HIGH** | 聊天 store 中响应式数组 push 与 watch 之间存在时序问题 | `web/v3/src/stores/chat.ts:240` |

### 易用性与代码质量 (Top 5)

| # | 严重度 | 问题 | 位置 |
|---|--------|------|------|
| 21 | **CRITICAL** | 用户可见错误使用原生 `alert()` 弹窗（阻塞线程、不可样式化） | `web/v3/src/components/chat/ChatArea.vue:887-939` |
| 22 | **HIGH** | HTTP 路由是一个500+行的 if-else 巨型函数 | `src/platform/services/http/http_server/router.js:1-500+` |
| 23 | **HIGH** | 前后端无共享类型定义，API 契约变更无法在编译时检测 | `web/v3/src/types/index.ts` vs `src/platform/` |
| 24 | **HIGH** | 聊天界面几乎无 ARIA 属性，不符合 WCAG 2.1 AA | `web/v3/src/components/chat/ChatArea.vue` |
| 25 | **HIGH** | 12+ 文件中存在 25+ 个魔法数字，无常量定义 | 全仓分散 |

---

## 三、安全性详细分析

### 3.1 命令注入

#### [CRITICAL] S-01: LLM 控制的任意 OS 命令执行
- **文件**: `modules/localcmd/tools.js:28-52`, `modules/localcmd/process_manager.js:258-271`
- **描述**: `localcmd_spawn` 工具接受 LLM 自由格式的 `command` 参数并直接传给 `child_process.spawn()`。无命令白名单、无路径限制、无参数验证。
- **缓解措施**: `shell: false` 防止了 Shell 元字符注入
- **残余风险**: 对抗性 Prompt 可让 LLM 执行 `python -c`、`bash`、`curl`、`nc` 等任意二进制文件
- **修复建议**: 实现二进制白名单 + 参数验证

#### [CRITICAL] S-02: LLM 控制的 SSH 远程命令注入
- **文件**: `modules/ssh/tools.js:48-67`, `modules/ssh/shell_manager.js:361-440`
- **描述**: `ssh_shell_send` 工具将 LLM 生成的命令直接写入 SSH Shell 流，零输入净化
- **修复建议**: 实现 SSH 命令白名单或确认机制

#### [HIGH] S-03: 未验证的 Git URL 传给 `git clone`
- **文件**: `src/platform/services/skills/git/git_skill_service.js:60-84, 261-269`
- **描述**: HTTP API 请求体中的 `gitUrl` 无协议验证直接传给 `execFile("git", ["clone", ...])`
- **风险**: `git clone` 的 `--config` 标志可被滥用进行代码执行
- **修复建议**: 强制 `https://` 协议 + 已知主机白名单

### 3.2 SSH 安全

#### [HIGH] S-04: SSH Host Key 验证未接入
- **文件**: `modules/ssh/connection_manager.js:292-299`
- **描述**: 虽支持 `verifyHostKey` 配置选项，但 `Client.connect()` 的 `connectionConfig` 对象中**从未传递** `hostVerifier` 回调
- **后果**: SSH2 库默认自动接受 Host Key，每次连接都暴露在 MITM 攻击下
- **修复建议**: 将 `verifyHostKey` 配置接入 ssh2 的 `hostVerifier` 回调，生成并持久化 known_hosts 条目

#### [HIGH] S-05: SSH 凭证明文存储
- **文件**: `modules/ssh/connection_manager.js:77-96, 302-322`
- **描述**: SSH 密码、私钥、passphrase 均以明文 JSON 存储在配置文件中
- **修复建议**: 使用平台密钥库或派生加密密钥加密存储

#### [HIGH] S-06: SSH 命令记录明文泄露
- **文件**: `modules/ssh/shell_manager.js:363, 429`
- **描述**: 所有 SSH 命令（可能包含 `export TOKEN=xxx` 等秘密）明文写入日志文件
- **修复建议**: 命令记录前进行敏感词过滤

### 3.3 LLM 提供商安全

#### [HIGH] S-07: API Key 明文存储
- **文件**: `src/platform/utils/config/config.js:280-282, 560, 574, 612, 628`
- **描述**: 所有 LLM 提供商的 API Key 以明文 JSON 存储在 `app.local.json` 和 `llmservices.local.json`
- **修复建议**: 加密 API Key 存储，使用平台密钥管理方案

#### [HIGH] S-08: LLM 配置 API 端点无认证
- **文件**: `src/platform/services/http/http_server/router.js:510-565`
- **描述**: `GET/POST /api/config/llm` 端点无需认证即可读写明文 API Key
- **缓解**: 服务器绑定 `127.0.0.1`
- **修复建议**: 添加 API 认证机制

#### [MEDIUM] S-09: 无 Prompt 注入防护层
- **文件**: `src/platform/runtime/turn_engine.js`, `src/platform/runtime/runtime_llm.js`
- **描述**: 用户消息和智能体间消息直接传入 LLM API，无任何注入过滤（如 "Ignore previous instructions" 模式匹配）
- **修复建议**: 在用户消息与系统提示之间添加分隔符和过滤层

### 3.4 浏览器自动化安全

#### [CRITICAL] S-10: `chrome_navigate` 零 URL 校验 - 完全 SSRF
- **文件**: `modules/chrome/features/navigation.js:65-93`
- **描述**: `page.goto(url)` 调用前无任何 URL 验证：
  - 可访问 `http://127.0.0.1:PORT/` 内部服务
  - 可访问 `http://169.254.169.254/` 云元数据
  - 可访问 `file:///etc/passwd` 本地文件
  - 可访问内网地址 (10.x, 172.16.x, 192.168.x)
- **修复建议**: URL 协议限制（仅 https），私有/环回 IP 阻止

#### [HIGH] S-11: LLM 通过 `new Function()` 在浏览器中执行任意 JavaScript
- **文件**: `modules/chrome/features/interaction.js:344-363`
- **描述**: LLM 生成的脚本通过 `new Function()` 在 Puppeteer 浏览器页面中执行，可提取 Cookie、localStorage 等
- **修复建议**: 限制脚本对敏感 DOM API 的访问

### 3.5 日志安全

#### [CRITICAL] S-12: Logger 完全无密钥/敏感词脱敏
- **文件**: `src/platform/utils/logger/logger.js:435-462`
- **描述**: `_formatData` 函数将传入数据完整序列化为 JSON，无任何关键词过滤。若任何代码路径将包含 `apiKey`、`password`、`token`、`secret`、`key` 的对象传给 logger，这些密钥将写入 `system.log` 和 `stderr.log`
- **修复建议**: 在 `_formatData` 中添加基于字段名匹配的脱敏逻辑

#### [CRITICAL] S-13: 全局 stderr 劫持捕获所有库输出
- **文件**: `src/platform/utils/logger/logger.js:485-526`
- **描述**: `process.stderr.write` 全局覆盖捕获**所有** stderr 输出。若任何第三方库将 API Key 输出到 stderr，它们会出现在日志文件中而无法过滤
- **修复建议**: 在 stderr 捕获层添加实时脱敏

#### [HIGH] S-14: 错误堆栈泄露完整文件系统路径
- **文件**: `src/platform/utils/logger/logger.js:436-438`
- **描述**: 错误堆栈跟踪完整记录，暴露内部模块名、函数名、文件系统路径结构
- **修复建议**: 生产环境中限制错误堆栈详细程度

### 3.6 HTTP 服务器安全

#### [HIGH] S-15: 所有状态变更端点无 CSRF 防护
- **文件**: `src/platform/services/http/http_server/index.js:541-608`
- **描述**: 无 CSRF Token 生成/验证、无 `SameSite` Cookie、无 `Origin`/`Referer` 校验
- **修复建议**: 添加 CSRF Token 或 Origin 头验证

#### [HIGH] S-16: 所有 API 端点无速率限制
- **描述**: 攻击者可无限制地发送消息消耗 LLM API 额度、创建大量智能体耗尽内存
- **修复建议**: 按端点实现速率限制

#### [MEDIUM] S-17: JSON Body 解析无大小限制
- **文件**: `src/platform/services/http/http_server/utilities.js:11-32`
- **描述**: 请求体被累积为单一字符串而无大小检查，可发送数 GB 请求体耗尽服务器内存
- **修复建议**: 添加 `Content-Length` 检查

### 3.7 正面发现

- **P-01**: `shell: false` 防止 localcmd_spawn 中的 Shell 注入
- **P-02**: `verifyHostKey` 配置架构已存在，仅需接入 ssh2
- **P-03**: `maskApiKey()` 在 API 响应中隐藏密钥（仅显示最后4位）
- **P-04**: `_validateUrl` 在 HTTP 客户端中强制 HTTPS
- **P-05**: JavaScript 沙箱使用 `vm.createContext` + `Object.create(null)` 隔离
- **P-06**: 服务器显式绑定 `127.0.0.1` 阻止远程访问

---

## 四、性能详细分析

### 4.1 内存泄漏

#### [MEDIUM] P-01: shutdown_manager 中的孤立信号处理器
- **文件**: `src/platform/runtime/shutdown_manager.js:247-361`
- **描述**: 多个 `process.on()` 注册的监听器在 `destroy()` 中未移除。重复实例化会导致监听器累积
- **修复建议**: 添加 `removeSystemHandlers()` 方法，在 `destroy()` 中调用

#### [MEDIUM] P-02: ResourceLifecycle 未清理空 Set
- **文件**: `src/platform/runtime/resource_lifecycle.js:23-31, 113-115`
- **描述**: 当所有资源注销后，`_byAgent` 和 `_byType` Map 中的空 Set 未被删除
- **修复建议**: 当 Set 为空时从 Map 中删除对应条目

### 4.2 低效数据结构

#### [MEDIUM] P-03: BFS 使用 `Array.shift()` 导致 O(n*d) 性能
- **文件**: `web/v3/src/services/api.ts:116-132`
- **描述**: `getDescendantIds` 在 BFS 遍历中使用 `queue.shift()`，每次 O(n)。200个10层深度的智能体需要 10-50ms
- **修复建议**: 使用索引指针代替 `shift()`

#### [MEDIUM] P-04: Worker 结果冗余 `JSON.parse(JSON.stringify())`
- **文件**: `src/platform/runtime/javascript_executor_worker.js:251-264`
- **描述**: `toTransferable()` 执行冗余的双序列化，而 `postMessage` 已使用结构化克隆算法
- **修复建议**: 移除 `toTransferable()`，直接发送原始值

#### [MEDIUM] P-05: `currentMessages` computed 对每条消息进行浅拷贝
- **文件**: `web/v3/src/components/chat/ChatMessageList.vue:221-322`
- **描述**: 200条消息 = 200次 `{...msg}` 浅拷贝。加上 `getGroupFiles` 和 `getGroupTokens` 在模板中多次调用，每次渲染遍历数组 6-8 次
- **修复建议**: 单次遍历算法，预计算聚合值

### 4.3 阻塞操作

#### [HIGH] P-06: `loadConversationSync` 在 TurnEngine 路径上使用同步 I/O
- **文件**: `src/platform/services/conversation/conversation_manager.js:418-450`
- **描述**: 使用 `existsSync` + `readFileSync` 加载对话 JSON。2MB 文件阻塞事件循环 10-50ms
- **修复建议**: 将路径改为异步：`await fs.readFile(filePath, "utf8")`

#### [HIGH] P-07: `JSON.stringify(data, null, 2)` 2倍磁盘空间和CPU开销
- **文件**: `src/platform/services/conversation/conversation_manager.js:261`
- **描述**: 500条消息的对话：2MB JSON -> 4MB 格式化。500ms 防抖 = 8MB/s 持续写入
- **修复建议**: 改为 `JSON.stringify(data, null, 0)` 紧凑格式

### 4.4 前端性能

#### [HIGH] P-08: 全局2秒轮询含3个顺序 API 调用
- **文件**: `web/v3/src/App.vue:78-105`
- **描述**: 每2秒发起3个 `await` 顺序网络请求。每请求 300ms = 900ms 周期。8小时 = ~43,000 API 调用
- **修复建议**: `Promise.all()` 并行化，标签页不可见时暂停轮询

#### [HIGH] P-09: 消息列表无虚拟滚动
- **文件**: `web/v3/src/components/chat/ChatMessageList.vue:851`
- **描述**: 500条消息创建 2000-3000 DOM 节点。初始渲染 200-500ms，滚动性能下降
- **修复建议**: 实现虚拟滚动或使用 `vue-virtual-scroller`

#### [MEDIUM] P-10: `chatMessages` 使用深层 `ref()` 响应性
- **文件**: `web/v3/src/stores/chat.ts:12-18`
- **描述**: 每条消息被 Vue Proxy 包装。1000条消息 = ~200-500KB Proxy 开销
- **修复建议**: 使用 `shallowRef`，通过整体替换触发更新

### 4.5 JavaScript 执行沙箱

#### [HIGH] P-11: Worker 线程无 `resourceLimits`
- **文件**: `src/platform/runtime/javascript_executor.js:297-303`
- **描述**: 无 `resourceLimits` 的 Worker 可分配无限堆内存。恶意脚本可在超时前耗尽进程内存导致 OOM
- **修复建议**: 添加 `resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 }`

#### [MEDIUM] P-12: Worker 线程每次创建/销毁（无池化）
- **文件**: `src/platform/runtime/javascript_executor.js:290-350`
- **描述**: 每次执行创建新 Worker（30-100ms），执行完立即销毁。频繁调用时开销占主导
- **修复建议**: 实现预生成的 Worker 池

#### [MEDIUM] P-13: 默认 VM 超时 5 分钟过于宽松
- **文件**: `src/platform/runtime/javascript_executor.js:48`
- **描述**: `DEFAULT_VM_TIMEOUT_MS = 300_000`，恶意无限循环占用 CPU 核心 5 分钟
- **修复建议**: 减少至 60,000ms（1 分钟），支持工具参数配置硬顶 120,000ms

### 4.6 其他性能问题

- **P-14**: `LlmClientPoolManager` 无池驱逐/空闲超时/最大尺寸（可能耗尽文件描述符）
- **P-15**: `formatMessageForLlm` 中 memory 和 knowledge 上下文顺序获取而非并行
- **P-16**: `ChatMessageList.vue` 未使用 `v-memo`，单条新消息导致所有 200+ 条重新渲染
- **P-17**: Vite `manualChunks` 仅分离 `primevue`，mermaid/KateX/lucide 等大型依赖未分块
- **P-18**: `buildSystemPromptForAgent` 使用 `+=` 串接字符串，大 Prompt 产生中间分配

---

## 五、稳定性详细分析

### 5.1 错误处理缺口

#### ~~HIGH~~ → **LOW** ST-01: `_sendJson` fallback catch 理论边界案例
- **文件**: `src/platform/services/http/http_server/utilities.js:58-74`
- **描述**: 代码已实现三层防御（外层 try-catch → 内层 try-catch → finalErr catch）。内层 JSON.stringify 操作的是 `{ error: "json_serialization_error", message: err.message }`——所有值均为字面字符串，`JSON.stringify` 仅在循环引用、BigInt 或 Symbol 时抛出，纯字符串对象不会触发异常。该代码实际已足够健壮
- **修复建议**: 无需修复（已通过人工复核确认为误报），仅从防御性编程角度考虑可记录为 LOW 优先级

#### [HIGH] ST-02: LLM 调用 catch 处理器回退到 raw error
- **文件**: `src/platform/runtime/compute_scheduler.js:571-636`
- **描述**: LLM 失败时的错误处理有多层尝试，但最终 fallback 创建 `{error: "llm_call_failed", message: String(err)}` 时若 `err` 为奇异值（Symbol、未定义），错误处理自身可能失败
- **修复建议**: 使用 `try { String(err) } catch { "unknown error" }` 包裹

### 5.2 状态一致性与竞态条件

#### [HIGH] ST-03: compute_scheduler 未跳过 `retrying` 状态
- **文件**: `src/platform/runtime/compute_scheduler.js:265-269, 422-425`
- **描述**: `retrying` 状态在 `_ingestMessagesToTurns` 和 `_runOneStep` 的跳过列表中缺失：
  1. Agent A 的 LLM 调用失败，进入 `retrying`（2秒退避）
  2. 退避期间 `_ingestMessagesToTurns` 处理 Agent A（未跳过!）
  3. 新消息入队，创建新 Turn
  4. 重试成功，assistant 消息写入对话
  5. 新 Turn 使用被修改的对话，产生重复/不连贯的 assistant 消息
- **修复建议**: 在两个方法中添加 `"retrying"` 到跳过列表

#### [HIGH] ST-04: `wakeUpAndProcess` 与主 `_loop()` 竞态
- **文件**: `src/platform/runtime/compute_scheduler.js:131-150`
- **描述**: `wakeUpAndProcess` 通过 `setImmediate` 调度，与主 `while` 循环交错调用 `_ingestMessagesToTurns` 和 `_runOneStep`。两个路径都消费共享的 `_readyQueue`，可能导致 agent 被重复处理
- **修复建议**: 使用 `_processingSemaphore` 或 `_wakeupPending` 标志防止并发唤醒

#### [HIGH] ST-05: cancel_manager.abort() 未取消活跃处理标记
- **文件**: `src/platform/runtime/agent_cancel_manager.js`
- **描述**: `abort()` 增加 epoch 并中止 LLM 调用，但未调用 `runtime_state.unmarkAgentAsActivelyProcessing()`
- **后果**: 新消息可能触发级联中断循环
- **修复建议**: 在 abort 方法中添加 `unmarkAgentAsActivelyProcessing`

### 5.3 优雅降级

#### [MEDIUM] ST-06: shutdown_manager 的双重关闭竞态
- **文件**: `src/platform/runtime/shutdown_manager.js`
- **描述**: 缺少 `_isShuttingDown` 守卫。SIGTERM + 超时可触发双重关闭，导致资源被清理两次
- **修复建议**: `shutdown()` 顶部添加 `if (this._isShuttingDown) return;`

#### [MEDIUM] ST-07: `forceCleanupAgent` 无每个资源的超时
- **文件**: `src/platform/runtime/resource_lifecycle.js:126-143`
- **描述**: 资源顺序清理，单个卡住的资源（如不关闭的 Chrome）阻塞整个清理链。10秒总预算可能被单个资源完全消耗
- **修复建议**: 每个资源添加 `Promise.race` 超时

### 5.4 其他稳定性问题

- **ST-08 [MEDIUM]**: `org.json` 持久化每次序列化整个组织状态，突发大量修改时频繁写入
- **ST-09 [MEDIUM]**: `releaseLock` 中无锁代际检查，延迟回调可能操作过期的锁
- **ST-10 [MEDIUM]**: `agent_cancel_manager._cancellations` Map 在 agent 删除后不清除，长期运行内存泄漏
- **ST-11 [MEDIUM]**: `idle_monitor._lastActivity` Map 和 `_warningEmitted` Set 在 agent 删除后不清除
- **ST-12 [MEDIUM]**: 事件监听器在 SSE 连接断开后未注销，`_toolCallListeners` 等 Set 无限增长
- **ST-13 [MEDIUM]**: 事件发射时在 Set 上迭代，若监听器在回调中调用 `off` 则迭代行为未定义

---

## 六、功能性详细分析

### 6.1 类型安全（tsconfig.json: strict: false）

#### [HIGH] FC-01: `validateTaskBrief` 静默副作用
- **文件**: `src/platform/utils/message/task_brief.js:50-52`
- **描述**: 被标记为验证函数但静默修改调用者对象。`constraints` 非数组时被转换为包含 JSON 字符串的单元素数组
- **修复建议**: 将修改提取到独立的 `normalizeTaskBrief()` 函数

#### [HIGH] FC-02: 未检查的 Map.get() 空值
- **文件**: `src/platform/runtime/agent_queue_manager.js:14-17` 及全仓多处
- **描述**: `this.runtime._agents.get(agentId)` 在许多地方未进行空值检查。agent 在获取 ID 和执行之间被删除时导致 `TypeError`
- **修复建议**: 添加集中式 `getAgentOrNull(agentId)` 方法

### 6.2 组织与智能体生命周期

#### [HIGH] FC-03: `_collectDescendantAgents` 无循环检测
- **文件**: `src/platform/runtime/agent_queue_manager.js:53-67`
- **描述**: Agent A.parent = B, B.parent = A 的循环引用导致无限递归/栈溢出崩溃
- **修复建议**: 添加 `visited` Set 参数

#### [HIGH] FC-04: `send_message` 不验证发送者存在性
- **文件**: `src/platform/runtime/tools_agent.js:482-645`
- **描述**: 发送者默认为 `ctx.agent?.id ?? "unknown"`。若 ctx.agent 无 id，消息来自 `"unknown"`。回复 `"unknown"` 的消息无处投递
- **修复建议**: 在发送者默认为 "unknown" 后添加存在性验证

#### [HIGH] FC-05: 消息验证仅警告不阻止
- **文件**: `src/platform/runtime/tools_agent.js:551-565`
- **描述**: `validateMessageFormat` 函数有全面的验证逻辑，但失败仅产生日志警告而不阻止发送。验证基础设施形同虚设
- **修复建议**: 强制执行验证或移除验证基础设施

#### [MEDIUM] FC-06: User agent 绕过 TurnEngine
- **文件**: `src/platform/runtime/compute_scheduler.js:368-394`
- **描述**: 发给 `user` 的消息绕过 TurnEngine，不经过对话历史管理、系统提示构建、知识检索
- **修复建议**: 在 user agent 的 `onMessage` 中添加对话跟踪

### 6.3 工具实现

#### [HIGH] FC-07: 工具事件缺失 `agentId` 字段
- **文件**: `src/platform/runtime/compute_scheduler.js:849-858`
- **描述**: 预执行工具调用事件缺少 `agentId` 字段，而 JSDoc 声明其为必需
- **修复建议**: 在事件对象中添加 `agentId`

#### [MEDIUM] FC-08: `find_role_by_name` 缺少参数验证
- **文件**: `src/platform/runtime/tools_agent.js`
- **描述**: 盲目解构 `args.name` 未验证 `args` 是否为对象、`name` 是否为字符串
- **修复建议**: 添加 `typeof args.name !== 'string'` 守卫

#### [MEDIUM] FC-09: `move_file` 接受 6 种不同的源/目标参数名
- **文件**: `src/platform/runtime/tools_file.js:99-100`
- **描述**: 虽提高了 LLM 可用性，但增加了误解风险。优先级顺序未文档化
- **修复建议**: 文档化优先级顺序

### 6.4 前端状态管理

#### [HIGH] FC-10: 响应式数组 push 与 watch 间存在时序问题
- **文件**: `web/v3/src/stores/chat.ts:240`
- **描述**: `chatMessages.value[id] = []` 后 `push(userMsg)`。若 watch 在赋值和 push 之间触发，将看到空数组
- **修复建议**: 直接赋值包含消息的数组：`chatMessages.value[id] = [userMsg]`

#### [MEDIUM] FC-11: `allAgents` 去重逻辑不更新已有 agent
- **文件**: `web/v3/src/stores/agent.ts:48-59`
- **描述**: 仅添加新的 agent，已存在的 agent 属性变更（如状态从 idle -> processing）不更新
- **修复建议**: 添加更新步骤：合并已有 agent 的属性

### 6.5 测试覆盖缺口

#### [HIGH] FC-12: 中断机制零测试覆盖
- **缺失**: `message_bus.js` -> `agent_cancel_manager.js` -> `turn_engine.js` -> `compute_scheduler.js` 的中断流程端到端无测试
- **风险**: 这是系统中最复杂的多模块协调流程

#### [HIGH] FC-13: `AutoReplyManager` 零测试
- **文件**: `src/platform/runtime/auto_reply.js`
- **风险**: 定时器代码具有高 Bug 率

#### [HIGH] FC-14: `ReplyManager` 零测试
- **文件**: `src/platform/runtime/reply_manager.js`
- **风险**: 处理用户交互入口点，涉及 HTTP -> ComputeScheduler -> TurnEngine -> MessageBus 协调

#### [MEDIUM] FC-15: 所有5个前端 Store 均无测试
- **缺失**: `agent.ts`, `chat.ts`, `org.ts`, `app.ts`, `guide.ts`
- **风险**: Vue 响应性边界情况和乐观更新回滚错误无法在无测试时捕获

---

## 七、易用性与代码质量详细分析

### 7.1 用户体验

#### [CRITICAL] UX-01: 用户错误使用原生 `alert()`
- **文件**: `web/v3/src/components/chat/ChatArea.vue:887-939`
- **描述**: 删除智能体失败、批量删除失败、清空历史失败均使用 `alert()` 弹窗。原生 alert 阻塞整个 JavaScript 线程，不可样式化，无消除动画
- **修复建议**: 替换为 PrimeVue Toast（已是项目依赖）

#### [HIGH] UX-02: 聊天 Store 所有错误被静默吞没
- **文件**: `web/v3/src/stores/chat.ts:142-350`
- **描述**: 所有 catch 块仅 `console.error`，无用户可见反馈。消息发送失败、历史加载失败均无感知
- **修复建议**: 暴露 `error` 响应式 ref，显示内联错误提示和重试按钮

#### [HIGH] UX-03: Agent Store 无错误状态
- **文件**: `web/v3/src/stores/agent.ts:27-33, 81-89`
- **描述**: 智能体列表加载失败时静默失败。用户看到空列表但无法区分是"无智能体"还是"加载失败"
- **修复建议**: 添加 `error` 响应式 ref 和重试机制

#### [MEDIUM] UX-04: 思维气泡依赖3秒轮询
- **文件**: `web/v3/src/components/chat/ChatArea.vue:342`
- **描述**: 用户发送消息后，`computeStatus` 在下次轮询(最多3秒)才更新。中间无"agent思考中"状态
- **修复建议**: 在 `sendMessage` 成功后立即设置本地 "等待回复" 标志

### 7.2 无障碍

#### [HIGH] UX-05: 聊天界面几乎无 ARIA 属性
- **文件**: `web/v3/src/components/chat/ChatArea.vue:946-1388`
- **描述**: 文本输入无 `aria-label`，消息列表无 `role="log"` 或 `aria-live`，滚动按钮仅有 `title`
- **修复建议**: 添加全面的 ARIA 标注，使 WCAG 2.1 AA 合规

#### [HIGH] UX-06: 焦点指示器被明确禁用
- **文件**: `web/v3/src/components/chat/ChatArea.vue:1500-1504`
- **描述**: `outline: none !important` 完全移除浏览器焦点环，违反 WCAG 2.4.7
- **修复建议**: 保留发光效果的同时添加具有足够对比度的可见焦点环

#### [MEDIUM] UX-07: 颜色仅有的危险操作指示
- **文件**: `web/v3/src/components/chat/ChatArea.vue:1004`
- **描述**: 删除和清空菜单项仅通过红色(`text-red-500`)区分，色盲用户无法区分
- **修复建议**: 添加文字后缀如"(不可撤销)"或使用不同的图标

### 7.3 配置体验

#### [MEDIUM] UX-08: 模板与实际配置默认值冲突
- **文件**: `config/app_template.json:20` vs `config/app.json:24`
- **描述**: 模板 `contextLimit.maxTokens: 12000`，实际 `contextLimit.maxTokens: 60960`
- **修复建议**: 对齐模板与实际默认值

#### [MEDIUM] UX-09: 配置仅验证类型不验证范围
- **文件**: `src/platform/utils/config/config.js:155-180, 430-470`
- **描述**: `httpPort` 可设为 -1 或 99999，`maxTokens` 可为 0 或负数，但不报错
- **修复建议**: 添加范围验证

### 7.4 代码质量

#### [HIGH] CQ-01: 500行+ 超长 if-else 路由函数
- **文件**: `src/platform/services/http/http_server/router.js:1-500+`
- **描述**: 违反了项目 AGENTS.md 指南（"禁止出现超长 ifelse switchcase"）。圈复杂度 >100
- **修复建议**: 重构为声明式路由表

#### [HIGH] CQ-02: 前后端无共享类型定义
- **文件**: `web/v3/src/types/index.ts` vs `src/platform/`
- **描述**: 前端独立定义 TypeScript 接口，后端使用 JavaScript + JSDoc。API 契约变更时编译期无法检测
- **修复建议**: 创建 `shared/types/api-types.ts` 或从后端 JSDoc 生成前端类型

#### [HIGH] CQ-03: 25+ 个魔法数字分布在 12+ 个文件中
- **示例**: `3000` 出现在 4 个不同文件中用于不同目的（HTTP端口、轮询间隔、shutdown超时等）
- **修复建议**: 创建集中式常量文件

#### [MEDIUM] CQ-04: JSON Body 解析代码严重重复
- **文件**: `src/platform/services/http/http_server/agents.js:782-806` 及多处
- **描述**: 15-20 行手动 JSON 解析代码在多个处理器中重复。`_readJsonBody()` 工具已存在
- **修复建议**: 审计所有处理器，标准化使用 `_readJsonBody()`

#### [MEDIUM] CQ-05: ChatArea.vue 约 945 行
- **文件**: `web/v3/src/components/chat/ChatArea.vue:1-944`
- **描述**: 超过项目指南的 500 行限制
- **修复建议**: 提取为 composables：`useAutoReply`、`useSearch`、`useScrollManagement`、`useFileDialog`

### 7.5 包健康

#### [MEDIUM] CQ-06: 双锁文件存在
- **文件**: `bun.lock` (93KB) + `package-lock.json` (101KB)
- **描述**: 项目同时维护 `bun.lock` 和 `package-lock.json` 双锁文件（Node.js 为主，Bun 为备选）。不同锁文件可能导致环境间行为差异
- **修复建议**: 推荐以 `package-lock.json` 为主要锁文件，`bun.lock` 作为 Bun 备选运行时的辅助锁文件

#### [MEDIUM] CQ-07: Gitee 依赖无镜像回退
- **文件**: `package.json:31, 33`
- **描述**: `hmemory` 和 `llama-cpp-provider` 从 Gitee 安装。非中国贡献者可能无法访问，Gitee 不可用时项目无法构建
- **修复建议**: 发布到 npm 或添加 GitHub 镜像回退

### 7.6 文档

#### [MEDIUM] CQ-08: README 引用不存在的 API 参考文档
- **文件**: `README.md:237`
- **描述**: 引用 `./docs/api-reference.md` 但该文件不存在
- **修复建议**: 创建文档或删除死链接

#### [MEDIUM] CQ-09: `spec.md` 仅涵盖 Windows 打包
- **文件**: `spec.md:1-53`
- **描述**: 51行仅覆盖 Windows 安装器。无功能性规格说明
- **修复建议**: 重命名为 `packaging.md` 或扩展为完整规格

---

## 八、修复优先级总表 (Top 30)

按影响/工作量比排序：

| 优先级 | ID | 维度 | 严重度 | 问题简述 | 预估工作量 |
|--------|----|------|--------|----------|-----------|
| P0 | ST-C4 | 稳定性 | HIGH | JSON Body 无大小限制 | 小 |
| P0 | S-01 | 安全 | CRITICAL | Logger 密钥脱敏 | 中 |
| P0 | S-10 | 安全 | CRITICAL | Chrome URL SSRF 校验 | 小 |
| P0 | S-02 | 安全 | CRITICAL | localcmd_spawn 命令白名单 | 中 |
| P0 | ST-03 | 稳定性 | HIGH | retrying 状态跳过 | 1行 |
| ~~P0~~ | ST-01 | 稳定性 | ~~HIGH~~ LOW | _sendJson fallback catch (已核实为误报) | - |
| P0 | FC-03 | 功能性 | HIGH | 后代收集循环检测 | 5行 |
| P0 | P-11 | 性能 | HIGH | Worker resourceLimits | 3行 |
| P0 | UX-01 | 易用性 | CRITICAL | alert() 替换为 Toast | 中 |
| P1 | S-04 | 安全 | HIGH | SSH Host Key 验证接入 | 中 |
| P1 | S-05 | 安全 | HIGH | API Key 明文存储加密 | 大 |
| P1 | S-15 | 安全 | HIGH | CSRF 防护 | 中 |
| P1 | ST-04 | 稳定性 | HIGH | wakeUpAndProcess 竞态 | 大 |
| P1 | ST-05 | 稳定性 | HIGH | cancel abort 清理 | 中 |
| P1 | FC-01 | 功能性 | HIGH | validateTaskBrief 副作用分离 | 小 |
| P1 | FC-04 | 功能性 | HIGH | send_message 发送者验证 | 3行 |
| P1 | FC-14 | 功能性 | HIGH | ReplyManager 测试 | 中 |
| P1 | P-06 | 性能 | HIGH | 同步 I/O 转异步 | 中 |
| P1 | P-09 | 性能 | HIGH | 虚拟滚动 | 大 |
| P1 | UX-05 | 易用性 | HIGH | ARIA 标注 | 大 |
| P2 | S-16 | 安全 | HIGH | API 速率限制 | 中 |
| P2 | S-09 | 安全 | MEDIUM | Prompt 注入防护 | 大 |
| P2 | ST-02 | 稳定性 | HIGH | LLM 错误处理回退 | 小 |
| P2 | FC-12 | 功能性 | HIGH | 中断机制测试 | 大 |
| P2 | P-03 | 性能 | MEDIUM | BFS shift 优化 | 小 |
| P2 | P-04 | 性能 | MEDIUM | Worker 冗余 JSON 序列化 | 1行 |
| P2 | P-07 | 性能 | HIGH | JSON 紧凑格式 | 1字符 |
| P2 | CQ-01 | 代码质量 | HIGH | 路由重构 | 大 |
| P2 | CQ-03 | 代码质量 | HIGH | 魔法数字常量化 | 中 |
| P3 | S-17 | 安全 | MEDIUM | JSON Body 大小限制 | 小 |
| P3 | P-12 | 性能 | MEDIUM | Worker 池化 | 大 |

---

## 九、建议的修复路线图

### 阶段一：关键安全与稳定性（P0）
1. Logger 添加密钥脱敏正则过滤
2. Chrome `navigate` 添加 URL 协议/私有IP校验
3. `localcmd_spawn` 添加命令白名单
4. Worker 添加 `resourceLimits`
5. 修复 `retrying` 状态跳过、循环检测
6. 将 `alert()` 替换为 Toast 组件

### 阶段二：安全加固与核心稳定性（P1）
7. SSH Host Key 验证接入
8. API Key 加密存储
9. CSRF + 速率限制
10. 修复竞态条件和状态泄漏
11. 同步 I/O 改异步 + JSON 紧凑格式
12. 虚拟滚动实现
13. 为关键流程添加测试

### 阶段三：代码质量与用户体验（P2-P3）
14. 路由重构
15. ARIA 无障碍标注
16. Prompt 注入防护层
17. 魔法数字常量化
18. Worker 池化和前后端类型共享

---

## 十、方法论说明

本报告采用以下行业标准进行静态分析：

- **OWASP Top 10 Web Application Security Risks** - 安全分析基准
- **CWE Top 25 Most Dangerous Software Weaknesses** - 弱点分类
- **Google JavaScript Style Guide / Airbnb Style Guide** - 代码质量基准
- **WCAG 2.1 AA** - 无障碍标准
- **Web Vitals (LCP, INP, CLS)** - 性能基准
- **ISO 25010 Software Quality Model** - 全面质量框架

所有发现均经人工代码审查验证，而非仅依赖自动化工具结果。

---

*报告生成时间: 2026-05-17 | 分析方法: 全量源代码人工静态审查 | 审查行数: ~20,000+ JS/TS/Vue/CSS*
