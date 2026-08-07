/**
 * CmdConfirmService — 命令确认服务（V3 桌面端）
 *
 * 职责：
 * - 监听心跳消息 'cmd_confirm'
 * - 弹出 CmdConfirmDialog 让用户决定是否允许命令执行
 * - 用户操作后 POST /api/modules/localcmd/confirm-response
 *
 * @author Agent Society
 */

import { ref } from 'vue';

interface ConfirmPayload {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  matchPattern: string;
  orgId: string | null;
  agentId: string | null;
  intent: string;
  agentName: string;
  orgName: string | null;
  headAgentName: string | null;
}

interface PendingConfirm {
  messageId: number;
  payload: ConfirmPayload;
  resolve: (() => void) | null;
}

// 响应式状态（供 CmdConfirmDialog 使用）
export const cmdConfirmState = ref<{
  visible: boolean;
  pending: PendingConfirm | null;
}>({
  visible: false,
  pending: null
});

/**
 * 显示确认对话框
 * 返回 Promise，用户操作后 resolve
 */
function showConfirm(messageId: number, payload: ConfirmPayload): void {
  cmdConfirmState.value = {
    visible: true,
    pending: { messageId, payload, resolve: null }
  };
}

/**
 * 用户确认
 */
export function confirmCommand(rememberChoice: boolean, matchEntry: string): void {
  const pending = cmdConfirmState.value.pending;
  if (!pending) return;

  sendResponse(pending.messageId, true, pending.payload, rememberChoice, matchEntry);
  cmdConfirmState.value.pending = null;
  cmdConfirmState.value.visible = false;
}

/**
 * 用户拒绝
 */
export function denyCommand(rememberChoice: boolean, matchEntry: string): void {
  const pending = cmdConfirmState.value.pending;
  if (!pending) return;

  sendResponse(pending.messageId, false, pending.payload, rememberChoice, matchEntry);
  cmdConfirmState.value.pending = null;
  cmdConfirmState.value.visible = false;
}

/**
 * 关闭对话框（取消操作）
 */
export function dismissConfirm(): void {
  const pending = cmdConfirmState.value.pending;
  if (!pending) return;

  // 取消视为拒绝
  sendResponse(pending.messageId, false, pending.payload, false, '');
  cmdConfirmState.value.visible = false;
}

/**
 * 发送确认响应到服务端
 */
async function sendResponse(
  messageId: number,
  allowed: boolean,
  payload: ConfirmPayload,
  rememberChoice: boolean,
  matchEntry: string
): Promise<void> {
  try {
    const response = await fetch('/api/modules/localcmd/confirm-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageId,
        allowed,
        rememberChoice,
        matchEntry,
        orgId: payload.orgId
      })
    });

    if (!response.ok) {
      console.error('[CmdConfirmService] 确认响应发送失败:', response.status);
    }
  } catch (err) {
    console.error('[CmdConfirmService] 确认响应异常:', err);
  }
}

// 导出处理函数，供 heartbeatService 注册
export const cmdConfirmHandler = (message: { messageId: number; type: string; payload: any }) => {
  const payload: ConfirmPayload = message.payload;
  console.log('[CmdConfirmService] 收到命令确认请求:', payload.command, message.messageId);
  showConfirm(message.messageId, payload);
};
