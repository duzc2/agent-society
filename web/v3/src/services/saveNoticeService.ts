/**
 * Save Notice Service
 *
 * 管理保存提示浮层的显示状态，供 uiCommandService 调用。
 * SaveNotice.vue 组件在 App.vue 中监听此服务状态。
 */

import { reactive } from 'vue';

interface SaveNoticeState {
  visible: boolean;
  message: string;
  resolve: ((filename: string | null) => void) | null;
  /** 递增版本号，用于在 notice 已显示时触发表单重置 */
  version: number;
}

const state = reactive<SaveNoticeState>({
  visible: false,
  message: '',
  resolve: null,
  version: 0,
});

/**
 * 显示保存提示浮层，返回 Promise，用户输入文件名后 resolve。
 * 如果当前已有 notice 在显示，则替换其内容（不闪烁）。
 * @param message 提示文字
 * @returns Promise<文件名 | null>（null 表示用户取消/关闭）
 */
export function showSaveNotice(message: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    // 如果已经显示，先重置表单状态（通过递增 version 触发 SaveNotice 内部重置）
    if (state.visible) {
      state.version++;
    }
    state.visible = true;
    state.message = message;
    state.resolve = resolve;
  });
}

export function hideSaveNotice(filename: string | null) {
  state.visible = false;
  if (state.resolve) {
    state.resolve(filename);
    state.resolve = null;
  }
}

export const saveNoticeState = state;
