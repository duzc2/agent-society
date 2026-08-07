/**
 * HeartbeatService — 统一心跳通信框架（移动端）
 *
 * 职责：
 * - 每 3s POST /api/heartbeat，携带 lastMessageId
 * - 接收服务端推送的新消息
 * - 按 type 分发给注册的处理器
 *
 * 设计原则：
 * - 无 clientId，无客户端状态。服务端不区分客户端。
 * - lastMessageId 为客户端已收到的最大消息 ID（初始 0）
 * - 服务端 drain(lastMessageId) 天然过滤重复，无需客户端去重
 *
 * @author Agent Society
 */

import { reactive } from 'vue';

type HeartbeatMessage = {
  messageId: number;
  type: string;
  payload: any;
};

type MessageHandler = (message: HeartbeatMessage) => void;

class HeartbeatService {
  private lastMessageId: number = 0;
  private isRunning: boolean = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private readonly INTERVAL_MS = 3000;

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[HeartbeatService] 启动，lastMessageId:', this.lastMessageId);
    this._tick();
    this.timer = setInterval(() => this._tick(), this.INTERVAL_MS);
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[HeartbeatService] 已停止');
  }

  onMessage(type: string, handler: MessageHandler): void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
  }

  offMessage(type: string, handler: MessageHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  private async _tick(): Promise<void> {
    if (!this.isRunning) return;
    try {
      const response = await fetch('/api/heartbeat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ lastMessageId: this.lastMessageId }),
      });

      if (!response.ok) {
        console.warn('[HeartbeatService] 心跳请求失败:', response.status);
        return;
      }

      const data = await response.json();

      // 服务端检测到心跳序列号来自上一会话（服务器重启导致 _nextId 重置），需要刷新页面
      if (data.needRefresh) {
        console.warn('[HeartbeatService] 服务端心跳序列号重置，刷新页面以同步状态');
        this.stop();
        // 使用 replace(true) 强制从服务器重新加载，并用 setTimeout 延迟确保在当前事件循环外执行
        setTimeout(() => {
          window.location.replace(window.location.href);
        }, 50);
        return;
      }

      const messages: HeartbeatMessage[] = data.messages || [];

      if (messages.length > 0) {
        this.lastMessageId = messages[messages.length - 1].messageId;

        for (const msg of messages) {
          const typeHandlers = this.handlers.get(msg.type);
          if (typeHandlers) {
            for (const handler of typeHandlers) {
              try {
                handler(msg);
              } catch (err) {
                console.error('[HeartbeatService] 处理器错误:', msg.type, err);
              }
            }
          } else {
            console.log('[HeartbeatService] 未处理的消息类型:', msg.type, msg.messageId);
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      console.warn('[HeartbeatService] 心跳异常:', err);
    }
  }
}

export const heartbeatService = new HeartbeatService();

/**
 * 组织树响应式状态（由 org_tree 心跳消息驱动）。
 * 替代原 GET /api/org/tree 轮询。
 */
export interface OrgTreeNode {
  id: string;
  roleName: string;
  roleId: string | null;
  sortOrder: number;
  parentAgentId: string | null;
  status: string;
  customName: string | null;
  orgName: string | null;
  children: OrgTreeNode[];
  computeStatus: string;
  computePhase: string | null;
}

export const orgTreeState = reactive<{
  tree: OrgTreeNode[];
  nodeCount: number;
  loaded: boolean;
}>({ tree: [], nodeCount: 0, loaded: false });

/**
 * org_tree 消息处理函数 — 更新 orgTreeState
 */
export const orgTreeHandler = (msg: HeartbeatMessage) => {
  const payload = msg.payload as { tree: OrgTreeNode[]; nodeCount: number };
  orgTreeState.tree = payload.tree;
  orgTreeState.nodeCount = payload.nodeCount;
  orgTreeState.loaded = true;
};
