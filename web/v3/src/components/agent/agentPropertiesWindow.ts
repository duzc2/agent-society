import AgentPropertiesDialog from './AgentPropertiesDialog.vue';
import { createDragEndHandler } from '../../utils/dialogBounds';

export interface AgentPropertiesWindowOptions {
  agentId: string;
  agentName?: string;
  roleName?: string;
  roleId?: string | null;
  agentStatus?: 'online' | 'offline' | 'busy' | string;
  initialTab?: string;
  selectedSkillId?: string;
}

/**
 * 打开智能体属性窗口。
 * @param dialog PrimeVue 动态对话框服务
 * @param options 智能体窗口上下文
 * @returns 动态对话框实例
 */
export const openAgentPropertiesWindow = (dialog: any, options: AgentPropertiesWindowOptions) => {
  return dialog.open(AgentPropertiesDialog, {
    props: {
      header: `${options.agentName || '智能体'} 属性`,
      style: { width: '820px', maxWidth: '95vw' },
      modal: false,
      closable: true,
      dismissableMask: false,
      closeOnEscape: false,
      keepInViewport: false,
      onDragend: createDragEndHandler()
    } as any,
    data: options
  });
};
