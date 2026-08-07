/**
 * 弹窗边界限制工具
 * 
 * 确保弹窗在拖拽时遵守边界限制：
 * - 顶部完全不能超出视口上边缘（一个像素也不行）
 * - 其他方向至少保留 10x10 像素可见区域
 */

const MIN_VISIBLE_SIZE = 10;

/**
 * 检查并调整弹窗位置，确保遵守边界限制
 * @param dialogElement 弹窗 DOM 元素
 */
export function constrainDialogPosition(dialogElement: HTMLElement): void {
  if (!dialogElement) return;

  const rect = dialogElement.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let needsAdjust = false;
  let newLeft = rect.left;
  let newTop = rect.top;

  // 检查右侧是否完全在视口左侧外
  if (rect.right < MIN_VISIBLE_SIZE) {
    newLeft = -rect.width + MIN_VISIBLE_SIZE;
    needsAdjust = true;
  }
  // 检查左侧是否完全在视口右侧外
  else if (rect.left > viewportWidth - MIN_VISIBLE_SIZE) {
    newLeft = viewportWidth - MIN_VISIBLE_SIZE;
    needsAdjust = true;
  }

  // 严格限制：窗口顶部不能超出视口上边缘（一个像素也不行）
  if (rect.top < 0) {
    newTop = 0;
    needsAdjust = true;
  }
  // 检查底部是否完全在视口下方外
  else if (rect.top > viewportHeight - MIN_VISIBLE_SIZE) {
    newTop = viewportHeight - MIN_VISIBLE_SIZE;
    needsAdjust = true;
  }

  if (needsAdjust) {
    dialogElement.style.left = `${newLeft}px`;
    dialogElement.style.top = `${newTop}px`;
  }
}

/**
 * 全局拖拽监听器（用于实时限制顶部边界）
 */
function onGlobalDrag(_event: DragEvent | MouseEvent): void {
  // 找到正在拖拽的弹窗
  const activeDialog = document.querySelector('.p-dialog-dragging') as HTMLElement ||
                      document.querySelector('.p-dialog[data-p-dragging="true"]') as HTMLElement;
  
  if (!activeDialog) return;

  const rect = activeDialog.getBoundingClientRect();
  
  // 实时限制：顶部不能超出视口上边缘
  if (rect.top < 0) {
    activeDialog.style.top = '0px';
  }
}

/**
 * 初始化全局拖拽监听
 */
let isGlobalListenerInitialized = false;
export function initGlobalDragListener(): void {
  if (isGlobalListenerInitialized) return;
  isGlobalListenerInitialized = true;

  // 监听 mousemove 来实时限制（比 drag 事件更可靠）
  document.addEventListener('mousemove', onGlobalDrag, { capture: true });
}

/**
 * 处理拖拽结束事件的工厂函数
 * @returns dragend 事件处理器
 */
export function createDragEndHandler(): (event: any) => void {
  return (event: any) => {
    // PrimeVue Dialog 的 dragend 事件会在事件后触发
    // 使用 setTimeout 确保 DOM 已更新
    setTimeout(() => {
      const dialogElement = event?.target?.closest?.('.p-dialog') || 
                           document.querySelector('.p-dialog:last-of-type');
      if (dialogElement instanceof HTMLElement) {
        constrainDialogPosition(dialogElement);
      }
    }, 0);
  };
}

/**
 * 为 DynamicDialog 创建包含边界检查的 props
 * @param baseProps 基础 props
 * @returns 包含 onDragend 的 props
 */
export function createDialogProps(baseProps: Record<string, any>): Record<string, any> {
  // 确保全局监听器已初始化
  initGlobalDragListener();
  
  return {
    ...baseProps,
    onDragend: createDragEndHandler()
  };
}

// 自动初始化
if (typeof document !== 'undefined') {
  initGlobalDragListener();
}
