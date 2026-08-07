import { ref, nextTick } from 'vue';
import html2canvas from 'html2canvas';
import { useChatStore } from '../../stores/chat';
import { useToast } from 'primevue/usetoast';
import { getMarkdownEngine } from '../file-viewer/renderers/markdown';

export function useChatExport() {
  const chatStore = useChatStore();
  const toast = useToast();
  const isExporting = ref(false);

  function formatTime(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderMessageHTML(msg: any, mdEngine: any, agentName: string): string {
    const contentHtml = mdEngine.render(msg.content || '').html;
    const timeStr = formatTime(msg.timestamp);
    const senderLabel = msg.senderType === 'user' ? 'User' : agentName;

    let html = `
      <div style="margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #e5e7eb;">
        <div style="margin-bottom: 8px; display: flex; align-items: center; gap: 8px;">
          <span style="font-weight: 700; font-size: 14px; color: #1f2937;">${escapeHtml(senderLabel)}</span>
          <span style="color: #6b7280; font-size: 12px;">${timeStr}</span>
          ${msg.scheduledDeliveryTime ? `<span style="color: #f59e0b; font-size: 12px; background: #fef3c7; padding: 2px 6px; border-radius: 4px;">&#x23F0; 延迟消息</span>` : ''}
        </div>`;

    // Reasoning block
    if (msg.reasoning) {
      html += `
        <div style="margin: 8px 0; padding: 12px; background: #f0fdf4; border-left: 3px solid #22c55e; border-radius: 6px;">
          <div style="font-weight: 600; font-size: 13px; color: #166534; margin-bottom: 6px;">Thinking Process</div>
          <div style="color: #374151; font-size: 13px; white-space: pre-wrap; word-break: break-word;">${escapeHtml(msg.reasoning)}</div>
        </div>`;
    }

    // Tool call
    if (msg.toolCall) {
      html += `
        <div style="margin: 8px 0; padding: 12px; background: #eff6ff; border-left: 3px solid #3b82f6; border-radius: 6px;">
          <div style="font-weight: 600; font-size: 13px; color: #1e40af; margin-bottom: 6px;">Tool: ${escapeHtml(msg.toolCall.name || '')}</div>
          <div style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Args:</div>
          <pre style="background: #f3f4f6; padding: 8px; border-radius: 4px; font-size: 12px; overflow-x: auto;">${escapeHtml(typeof msg.toolCall.args === 'string' ? msg.toolCall.args : JSON.stringify(msg.toolCall.args, null, 2))}</pre>
          ${msg.toolCall.result !== undefined ? `
            <div style="font-size: 12px; color: #6b7280; margin-top: 8px; margin-bottom: 4px;">Result:</div>
            <pre style="background: #f3f4f6; padding: 8px; border-radius: 4px; font-size: 12px; overflow-x: auto;">${escapeHtml(typeof msg.toolCall.result === 'string' ? msg.toolCall.result : JSON.stringify(msg.toolCall.result, null, 2))}</pre>
          ` : ''}
        </div>`;
    }

    // Main content
    html += `
        <div style="color: #374151; font-size: 14px; line-height: 1.6;">
          ${contentHtml}
        </div>
      </div>`;

    return html;
  }

  async function exportMessagesToPNG(
    agentId: string,
    messageIds: string[],
    agentName: string,
  ) {
    if (!messageIds.length || isExporting.value) return;

    const messages = (chatStore.chatMessages[agentId] || [])
      .filter(m => messageIds.includes(m.id))
      .sort((a, b) => a.timestamp - b.timestamp);

    if (!messages.length) return;

    isExporting.value = true;

    const container = document.createElement('div');
    container.style.cssText =
      'position:fixed;left:-9999px;top:0;width:800px;background:#ffffff;z-index:-1;';

    try {
      const mdEngine = getMarkdownEngine();
      const nowStr = formatTime(Date.now());

      let htmlContent = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; padding: 48px 40px;">
          <div style="text-align: center; margin-bottom: 32px; padding-bottom: 20px; border-bottom: 2px solid #e5e7eb;">
            <h1 style="font-size: 24px; font-weight: 700; color: #111827; margin: 0 0 8px 0;">聊天记录导出</h1>
            <div style="font-size: 14px; color: #6b7280;">
              <span>${escapeHtml(agentName)}</span>
              <span style="margin: 0 8px;">|</span>
              <span>${nowStr}</span>
              <span style="margin: 0 8px;">|</span>
              <span>共 ${messages.length} 条消息</span>
            </div>
          </div>`;

      for (const msg of messages) {
        htmlContent += renderMessageHTML(msg, mdEngine, agentName);
      }

      htmlContent += `
          <div style="text-align: center; margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 12px;">
            Generated by ${escapeHtml(agentName)}
          </div>
        </div>`;

      container.innerHTML = htmlContent;
      document.body.appendChild(container);

      // Wait for fonts/images to load
      await nextTick();
      await new Promise(resolve => setTimeout(resolve, 300));

      const canvas = await html2canvas(container, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true,
        logging: false,
      });

      canvas.toBlob((blob) => {
        if (!blob) {
          console.error('[ChatExport] Canvas toBlob failed');
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const safeName = agentName.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_');
        a.href = url;
        a.download = `chat_export_${safeName}_${nowStr.replace(/[: ]/g, '_')}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        toast.add({
          severity: 'success',
          summary: '导出成功',
          detail: '聊天记录长图已下载',
          life: 3000,
        });
      }, 'image/png');
    } catch (err) {
      console.error('[ChatExport] 导出长图失败:', err);
      toast.add({
        severity: 'error',
        summary: '导出失败',
        detail: '导出长图时发生错误，请重试',
        life: 3000,
      });
    } finally {
      document.body.removeChild(container);
      isExporting.value = false;
    }
  }

  return { exportMessagesToPNG, isExporting };
}
