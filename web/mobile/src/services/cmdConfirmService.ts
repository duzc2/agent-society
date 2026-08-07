/**
 * CmdConfirmService — 命令确认服务（移动端）
 *
 * 职责：
 * - 监听心跳消息 'cmd_confirm'
 * - 弹出 CmdConfirmSheet 让用户决定是否允许命令执行
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

export const cmdConfirmState = ref<{
  visible: boolean;
  messageId: number | null;
  payload: ConfirmPayload | null;
  rememberChoice: boolean;
  matchPattern: string;
}>({
  visible: false,
  messageId: null,
  payload: null,
  rememberChoice: false,
  matchPattern: ''
});

function showConfirm(messageId: number, payload: ConfirmPayload): void {
  cmdConfirmState.value = {
    visible: true,
    messageId,
    payload,
    rememberChoice: false,
    matchPattern: payload.matchPattern ?? ''
  };
}

export function confirmCommand(): void {
  const state = cmdConfirmState.value;
  if (state.messageId == null || !state.payload) return;
  const messageId = state.messageId;
  const payload = state.payload;
  const rememberChoice = state.rememberChoice;
  const matchEntry = state.matchPattern;
  state.messageId = null;
  state.payload = null;
  state.visible = false;
  sendResponse(messageId, true, rememberChoice, matchEntry, payload.orgId);
}

export function denyCommand(): void {
  const state = cmdConfirmState.value;
  if (state.messageId == null || !state.payload) return;
  const messageId = state.messageId;
  const rememberChoice = state.rememberChoice;
  const matchEntry = state.matchPattern;
  const orgId = state.payload.orgId;
  state.messageId = null;
  state.payload = null;
  state.visible = false;
  sendResponse(messageId, false, rememberChoice, matchEntry, orgId);
}

export function toggleRemember(): void {
  cmdConfirmState.value.rememberChoice = !cmdConfirmState.value.rememberChoice;
}

async function sendResponse(
  messageId: number,
  allowed: boolean,
  rememberChoice: boolean,
  matchEntry: string,
  orgId: string | null
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
        orgId
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
