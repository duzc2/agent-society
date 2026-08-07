/**
 * Dialog 引用管理模块
 *
 * 替代 window.$dialog 全局变量模式，使用模块级单例管理 PrimeVue Dialog 实例。
 * App.vue 在 onMounted 时调用 setDialogRef 注册，fileViewerService 通过 getDialogRef 获取。
 */

import type { useDialog } from 'primevue/usedialog';

let _dialog: ReturnType<typeof useDialog> | null = null;

export function setDialogRef(d: ReturnType<typeof useDialog>) {
  _dialog = d;
}

export function getDialogRef(): ReturnType<typeof useDialog> | null {
  return _dialog;
}
