/**
 * UI 命令服务
 *
 * 职责：
 * - 通过心跳接收服务端推送的 UI 命令（eval_js、get_content、dom_patch）
 * - 在页面上下文中执行命令
 * - 将执行结果发送回服务端
 *
 * 安全说明：
 * - eval_js 会直接在页面上下文中执行代码，具有完整 window/document 访问权限
 * - 该功能仅供智能体控制自身界面使用，不对外暴露
 *
 * @author Agent Society
 */

import { showSaveNotice } from './saveNoticeService';
import { heartbeatService, resolveAgentContext } from './heartbeatService';

// 命令类型定义
interface UiCommand {
    id: string;
    type: 'eval_js' | 'get_content' | 'dom_patch';
    payload: any;
}

// 命令执行结果
interface CommandResult {
    ok: boolean;
    result?: any;
    error?: string;
}

// DOM 补丁操作
interface DomOperation {
    op: string;
    selector?: string;
    name?: string;
    value?: string;
    position?: 'beforebegin' | 'afterbegin' | 'beforeend' | 'afterend';
}

class UiCommandService {
    private isRunning: boolean = false;

    /**
     * 启动命令服务（仅心跳通道）
     */
    start(): void {
        if (this.isRunning) return;

        this.isRunning = true;
        console.log('[UiCommandService] 启动（心跳通道）');

        // 注册心跳消息监听
        heartbeatService.onMessage('ui_command', this._handleHeartbeatCommand);
    }

    /**
     * 停止命令服务
     */
    stop(): void {
        this.isRunning = false;
        heartbeatService.offMessage('ui_command', this._handleHeartbeatCommand);
        console.log('[UiCommandService] 已停止');
    }

    /**
     * 执行命令
     */
    private async executeCommand(command: UiCommand): Promise<CommandResult> {
        try {
            switch (command.type) {
                case 'eval_js':
                    return this.executeEvalJs(command.payload);
                case 'get_content':
                    return this.executeGetContent(command.payload);
                case 'dom_patch':
                    return this.executeDomPatch(command.payload);
                default:
                    return { ok: false, error: `Unknown command type: ${command.type}` };
            }
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            console.error('[UiCommandService] 命令执行失败:', command.type, error);
            return { ok: false, error };
        }
    }

    /**
     * 执行 JavaScript 代码
     *
     * 在页面上下文中执行，具有完整的 window/document 访问权限。
     * 额外注入 __notify(text) 闭包（A 通道）：脚本可向执行智能体发页面通知，
     * 经服务端 notify-agent 进智能体会话（插话/新回合 + 持久化）。零全局变量。
     */
    private executeEvalJs(payload: { script: string; _ws?: string | null }): CommandResult {
        const script = payload?.script;

        if (typeof script !== 'string') {
            return { ok: false, error: 'Missing or invalid script parameter' };
        }

        const agentId = payload?._ws ?? null;
        const __notify = (text: unknown): void => {
            const body = typeof text === 'string' ? text : String(text ?? '');
            fetch('/api/modules/ui_page/notify-agent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId, text: body })
            }).catch(err => console.error('[UiCommandService] __notify 发送失败:', err));
        };

        // 创建函数并执行，传入 window 对象以确保最大权限
        const fn = new Function('window', 'document', '__notify', `
            "use strict";
            return (async () => {
                ${script}
            })();
        `);

        const result = fn(window, document, __notify);

        // 处理 Promise 返回值
        if (result && typeof result === 'object' && typeof result.then === 'function') {
            return result.then(
                (value: any) => ({ ok: true, result: this.serializeResult(value) }),
                (err: any) => ({ ok: false, error: err instanceof Error ? (err.stack || err.message) : String(err) })
            );
        }

        return { ok: true, result: this.serializeResult(result) };
    }

    /**
     * 获取页面内容
     */
    private executeGetContent(payload: {
        selector?: string | null;
        format?: string;
        maxChars?: number;
    }): CommandResult {
        const selector = payload?.selector;
        const format = payload?.format || 'summary';
        const maxChars = payload?.maxChars || 20000;

        let element: Element | Document | null = document;

        if (selector) {
            element = document.querySelector(selector);
            if (!element) {
                return { ok: false, error: `Element not found: ${selector}` };
            }
        }

        let content: string;

        switch (format) {
            case 'html':
                content = element instanceof Document
                    ? element.documentElement.outerHTML
                    : (element as Element).outerHTML;
                break;
            case 'text':
                content = element instanceof Document
                    ? element.body.innerText
                    : (element as Element).textContent || '';
                break;
            case 'summary':
                content = this.generateContentSummary(element, maxChars);
                break;
            default:
                return { ok: false, error: `Unknown format: ${format}` };
        }

        // 截断内容
        if (content.length > maxChars) {
            content = content.substring(0, maxChars) + '\n... (truncated)';
        }

        return { ok: true, result: content };
    }

    /**
     * 生成内容摘要
     */
    private generateContentSummary(element: Element | Document, maxChars: number): string {
        const parts: string[] = [];

        // 收集可见元素的文本和属性
        const elements = element.querySelectorAll('*');
        let charCount = 0;

        for (const el of Array.from(elements)) {
            // 跳过脚本、样式、隐藏元素
            if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) continue;

            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;

            // 收集交互元素
            const tagName = el.tagName.toLowerCase();
            const id = el.id ? `#${el.id}` : '';
            const classes = el.className && typeof el.className === 'string'
                ? el.className.split(' ').filter(c => c).map(c => `.${c}`).join('')
                : '';

            if (['button', 'a', 'input', 'textarea', 'select'].includes(tagName) || (el as HTMLElement).onclick) {
                const text = el.textContent?.trim() || '';
                const href = (el as HTMLAnchorElement).href;
                const type = (el as HTMLInputElement).type;

                let desc = `<${tagName}${id}${classes}>`;
                if (text) desc += ` text="${text.substring(0, 50)}"`;
                if (href) desc += ` href="${href}"`;
                if (type) desc += ` type="${type}"`;

                if (charCount + desc.length > maxChars) break;
                parts.push(desc);
                charCount += desc.length;
            }
        }

        return parts.join('\n');
    }

    /**
     * 执行 DOM 补丁
     */
    private executeDomPatch(payload: { operations: DomOperation[] }): CommandResult {
        const operations = payload?.operations;

        if (!Array.isArray(operations)) {
            return { ok: false, error: 'Missing or invalid operations parameter' };
        }

        const results: { index: number; success: boolean; error?: string }[] = [];

        for (let i = 0; i < operations.length; i++) {
            const op = operations[i];
            if (!op) continue;
            try {
                this.applyDomOperation(op);
                results.push({ index: i, success: true });
            } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                results.push({ index: i, success: false, error });
            }
        }

        const hasError = results.some(r => !r.success);
        return {
            ok: !hasError,
            result: results,
            error: hasError ? 'Some operations failed' : undefined
        };
    }

    /**
     * 应用单个 DOM 操作
     */
    private applyDomOperation(op: DomOperation): void {
        const { op: operation, selector, name, value, position } = op;

        switch (operation) {
            case 'setText': {
                const el = this.getElement(selector);
                el.textContent = value || '';
                break;
            }
            case 'setHtml': {
                const el = this.getElement(selector);
                el.innerHTML = value || '';
                break;
            }
            case 'setAttr': {
                const el = this.getElement(selector);
                if (!name) throw new Error('setAttr requires name parameter');
                el.setAttribute(name, value || '');
                break;
            }
            case 'remove': {
                const el = this.getElement(selector);
                el.remove();
                break;
            }
            case 'insertAdjacentHtml': {
                const el = this.getElement(selector);
                if (!position) throw new Error('insertAdjacentHtml requires position parameter');
                el.insertAdjacentHTML(position, value || '');
                break;
            }
            case 'addClass': {
                const el = this.getElement(selector);
                if (!value) throw new Error('addClass requires value parameter');
                el.classList.add(value);
                break;
            }
            case 'removeClass': {
                const el = this.getElement(selector);
                if (!value) throw new Error('removeClass requires value parameter');
                el.classList.remove(value);
                break;
            }
            case 'injectCss': {
                if (!value) throw new Error('injectCss requires value parameter');
                const style = document.createElement('style');
                style.textContent = value;
                document.head.appendChild(style);
                break;
            }
            default:
                throw new Error(`Unknown operation: ${operation}`);
        }
    }

    /**
     * 获取元素
     */
    private getElement(selector: string | undefined): Element {
        if (!selector) throw new Error('Missing selector parameter');
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Element not found: ${selector}`);
        return el;
    }

    /**
     * 处理通过心跳收到的 ui_command 消息
     */
    private _handleHeartbeatCommand = async (message: { messageId: number; type: string; payload: any }): Promise<void> => {
        // payload 格式: { type: 'eval_js'|'get_content'|..., payload: { ... } }
        const cmd = message.payload;
        if (!cmd || !cmd.type) return;

        // B1 通知命令：fire-and-forget，无结果回传，以 CustomEvent 分发给页面监听者
        if (cmd.type === 'notify') {
            console.log('[UiCommandService] 收到通知:', message.messageId);
            window.dispatchEvent(new CustomEvent('agent-notify', { detail: cmd.payload ?? {} }));
            return;
        }

        const command: UiCommand = {
            id: String(message.messageId),
            type: cmd.type,
            payload: cmd.payload
        };

        console.log('[UiCommandService] 收到命令:', cmd.type, message.messageId);
        const result = await this.executeCommand(command);
        // _preview 为面板"运行"按钮发起的预览执行：服务端无人等待结果，
        // 回传会触发 command_not_pending 404，故跳过
        if (!cmd.payload?._preview) {
            await this.sendResult(command.id, result);
        }

        // eval_js 执行后立即弹出保存提示框（可勾选「自动加载」）；
        // _preview 为面板"运行"按钮发起的预览执行，不弹保存提示
        if (cmd.type === 'eval_js' && !cmd.payload?._preview) {
            const script = cmd.payload?.script;
            const wsId = cmd.payload?._ws;
            // 连续多次执行会产生多个提示框并列显示（最早在下、最新在上），互不替换；
            // purpose/suggestedFilename 来自工具参数，用于展示目的与预填建议文件名；
            // agentContext 从组织树解析执行智能体的归属（哪个 agent 执行/哪个组织/谁管理），
            // 树未加载或 agent 不在树中时为 null，提示框不展示该行
            const agentCtx = resolveAgentContext(cmd.payload?._ws);
            showSaveNotice({
                message: '是否保存刚才执行的 JavaScript 代码？',
                purpose: cmd.payload?.purpose,
                suggestedFilename: cmd.payload?.suggestedFilename,
                agentContext: agentCtx,
            }).then(async (result) => {
                if (result?.filename && wsId) {
                    await fetch('/api/save-eval-script', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            workspaceId: wsId,
                            script,
                            filename: result.filename,
                            autoLoad: result.autoLoad,
                            // 目的描述随保存请求传给服务端，写入脚本文件头部注释（// purpose: xxx），
                            // 供管理面板展示；与 showSaveNotice 的 purpose 同源（工具参数）
                            purpose: cmd.payload?.purpose
                        })
                    });
                }
            });
        }
    };

    /**
     * 执行 JavaScript 代码（公开方法，供文件查看器等组件调用）
     * @param script 要执行的 JavaScript 代码
     * @param agentId 执行智能体 id（可选；供脚本内 __notify 定位通知目标）
     * @returns 执行结果
     */
    executeScript(script: string, agentId: string | null = null): Promise<{ ok: boolean; result?: any; error?: string }> {
        const commandResult = this.executeEvalJs({ script, _ws: agentId });

        // 如果返回的是 Promise（异步代码），等待其完成
        if (commandResult instanceof Promise) {
            return commandResult;
        }

        // 否则包装成 Promise 返回
        return Promise.resolve(commandResult);
    }

    /**
     * 执行所有「启用」的自动加载脚本（按注册顺序）。
     * 每次页面刷新/加载时由 App.vue 调用。
     *
     * 注意：必须直接执行，绝不能经心跳 ui_command 通道——
     * 否则 _handleHeartbeatCommand 会对每个自动加载脚本再次弹出保存提示。
     * 单个脚本失败不中断后续脚本。
     */
    async runAutoLoadScripts(): Promise<void> {
        try {
            const res = await fetch('/api/modules/ui_page/auto-load-scripts/executables');
            if (!res.ok) {
                console.error('[UiCommandService] 自动加载列表获取失败:', res.status);
                return;
            }
            const data = await res.json();
            if (!data?.ok) {
                console.error('[UiCommandService] 自动加载列表获取失败:', data?.message ?? data?.error);
                return;
            }
            // 顺序执行：保证脚本间 DOM 副作用顺序可见（前一个脚本建的元素可被后一个脚本操作）
            for (const s of data.scripts ?? []) {
                try {
                    await this.executeScript(s.script, s.workspaceId ?? null);
                } catch (err) {
                    console.error('[UiCommandService] 自动加载脚本执行失败:', s.path, err);
                }
            }
            // 服务端读取失败（文件缺失等）逐条记录，页面不受影响
            for (const e of data.errors ?? []) {
                console.error('[UiCommandService] 自动加载脚本读取失败（文件缺失?）:', e.path, e.error);
            }
        } catch (err) {
            console.error('[UiCommandService] 自动加载失败:', err);
        }
    }

    /**
     * 发送执行结果
     */
    private async sendResult(commandId: string, result: CommandResult): Promise<void> {
        const url = '/api/ui-commands/result';

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                commandId,
                ok: result.ok,
                result: result.result,
                error: result.error
            })
        });

        if (!response.ok) {
            throw new Error(`Failed to send result: HTTP ${response.status}`);
        }
    }

    /**
     * 序列化执行结果
     * 处理循环引用和不可序列化的值
     */
    private serializeResult(value: any): any {
        if (value === undefined) return null;
        if (value === null) return null;

        const type = typeof value;

        if (type === 'string' || type === 'number' || type === 'boolean') {
            return value;
        }

        if (value instanceof Date) {
            return value.toISOString();
        }

        if (value instanceof Element) {
            return {
                __type: 'Element',
                tagName: value.tagName,
                id: value.id,
                className: value.className
            };
        }

        if (Array.isArray(value)) {
            return value.map(item => this.serializeResult(item));
        }

        if (type === 'object') {
            const result: Record<string, any> = {};
            for (const key of Object.keys(value)) {
                try {
                    result[key] = this.serializeResult(value[key]);
                } catch {
                    result[key] = '[unserializable]';
                }
            }
            return result;
        }

        return String(value);
    }
}

// 导出单例
export const uiCommandService = new UiCommandService();
