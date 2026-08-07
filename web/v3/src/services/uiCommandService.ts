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
import { heartbeatService } from './heartbeatService';

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
     * 在页面上下文中执行，具有完整的 window/document 访问权限
     */
    private executeEvalJs(payload: { script: string }): CommandResult {
        const script = payload?.script;

        if (typeof script !== 'string') {
            return { ok: false, error: 'Missing or invalid script parameter' };
        }

        // 创建函数并执行，传入 window 对象以确保最大权限
        const fn = new Function('window', 'document', `
            "use strict";
            return (async () => {
                ${script}
            })();
        `);

        const result = fn(window, document);

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

        const command: UiCommand = {
            id: String(message.messageId),
            type: cmd.type,
            payload: cmd.payload
        };

        console.log('[UiCommandService] 收到命令:', cmd.type, message.messageId);
        const result = await this.executeCommand(command);
        await this.sendResult(command.id, result);

        // eval_js 执行后立即弹出保存提示框
        if (cmd.type === 'eval_js') {
            const script = cmd.payload?.script;
            const wsId = cmd.payload?._ws;
            showSaveNotice('是否保存刚才执行的 JavaScript 代码？').then(async (filename) => {
                if (filename && wsId) {
                    await fetch('/api/save-eval-script', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ workspaceId: wsId, script, filename })
                    });
                }
            });
        }
    };

    /**
     * 执行 JavaScript 代码（公开方法，供文件查看器等组件调用）
     * @param script 要执行的 JavaScript 代码
     * @returns 执行结果
     */
    executeScript(script: string): Promise<{ ok: boolean; result?: any; error?: string }> {
        const commandResult = this.executeEvalJs({ script });

        // 如果返回的是 Promise（异步代码），等待其完成
        if (commandResult instanceof Promise) {
            return commandResult;
        }

        // 否则包装成 Promise 返回
        return Promise.resolve(commandResult);
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
