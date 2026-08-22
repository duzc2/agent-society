/**
 * Save Notice Service
 *
 * 管理保存提示浮层列表，供 uiCommandService 调用。
 * 智能体连续多次执行 eval_js 时会产生多个提示，互不替换：
 * 新提示追加到列表末尾，渲染时最早的卡片在底部、新的往上堆叠，
 * 已存在的卡片位置不因新提示出现而改变，避免用户误操作。
 * SaveNotice.vue 组件在 App.vue 中监听此服务状态。
 */

import { reactive } from 'vue';

/** 保存提示的确认结果 */
export interface SaveNoticeResult {
  /** 文件名（null 表示用户取消/关闭） */
  filename: string | null;
  /** 是否勾选了「自动加载」 */
  autoLoad: boolean;
}

/** 执行脚本的智能体归属上下文（来自组织树），显示在提示框帮助用户确认是谁执行的 */
export interface AgentContext {
  /** 执行脚本的智能体名称 */
  agentName: string;
  /** 所属组织名称（可能未设置） */
  orgName: string | null;
  /** 管理组织的智能体名称（设置该组织名的 agent） */
  orgManagerName: string | null;
}

/** 单条保存提示（含独立表单状态，多卡片各自维护） */
export interface SaveNoticeItem {
  id: number;
  message: string;
  /** 脚本运行目的（来自 ui_page_eval_js 的 purpose 参数），显示在提示框帮助用户确认 */
  purpose?: string;
  /** 建议文件名（不含 .js 后缀），预填输入框，用户可修改 */
  suggestedFilename?: string;
  /** 执行脚本的智能体归属（agent 名/组织/组织管理者），解析失败时为 null 不展示 */
  agentContext?: AgentContext | null;
  /** 是否处于文件名输入态 */
  saveMode: boolean;
  /** 文件名输入框当前值 */
  inputValue: string;
  /** 「自动加载」勾选状态（默认不勾选） */
  autoLoad: boolean;
  resolve: ((result: SaveNoticeResult | null) => void) | null;
}

interface SaveNoticeState {
  /** 提示列表：索引 0 为最早创建的卡片 */
  items: SaveNoticeItem[];
}

const state = reactive<SaveNoticeState>({
  items: [],
});

let nextId = 1;

/**
 * 新增一条保存提示，返回 Promise，用户确认后 resolve。
 * 多次调用会并列显示（最早的在下、最新的在上），互不替换。
 * @param options
 * @param options.message 提示文字
 * @param options.purpose 脚本运行目的（可空，来自工具 purpose 参数）
 * @param options.suggestedFilename 建议文件名（可空，预填输入框）
 * @param options.agentContext 执行脚本的智能体归属（可空，来自组织树解析）
 * @returns Promise<SaveNoticeResult | null>（null 表示用户取消/关闭）
 */
export function showSaveNotice(options: {
  message: string;
  purpose?: string;
  suggestedFilename?: string;
  agentContext?: AgentContext | null;
}): Promise<SaveNoticeResult | null> {
  return new Promise<SaveNoticeResult | null>((resolve) => {
    state.items.push({
      id: nextId++,
      message: options.message,
      purpose: options.purpose || undefined,
      suggestedFilename: options.suggestedFilename || undefined,
      agentContext: options.agentContext || null,
      saveMode: false,
      inputValue: options.suggestedFilename || '',
      autoLoad: false,
      resolve,
    });
  });
}

/**
 * 关闭指定提示并 resolve（不替换、不影响其他提示）。
 * @param id 提示项 id
 * @param filename 文件名（null 表示取消）
 */
export function hideSaveNotice(id: number, filename: string | null) {
  const idx = state.items.findIndex((i) => i.id === id);
  if (idx < 0) return;
  const item = state.items[idx];
  state.items.splice(idx, 1);
  if (item.resolve) {
    item.resolve({ filename, autoLoad: item.autoLoad });
    item.resolve = null;
  }
}

export const saveNoticeState = state;
