import { ref, onMounted, onUnmounted, type Ref } from 'vue';

/**
 * 软键盘感知 composable
 * 监听 visualViewport.resize 事件，计算键盘高度
 * 用于移动端输入框和消息列表的定位
 */
export function useKeyboard(): {
  keyboardHeight: Ref<number>;
  isKeyboardOpen: Ref<boolean>;
} {
  const keyboardHeight = ref(0);
  const isKeyboardOpen = ref(false);
  const initialHeight = ref(window.innerHeight);

  function handleResize() {
    if (window.visualViewport) {
      const viewportHeight = window.visualViewport.height;
      const diff = initialHeight.value - viewportHeight;

      // 阈值：高度差超过 100px 才认为键盘弹出
      if (diff > 100) {
        keyboardHeight.value = diff;
        isKeyboardOpen.value = true;
      } else {
        keyboardHeight.value = 0;
        isKeyboardOpen.value = false;
      }
    }
  }

  onMounted(() => {
    // 记录初始高度
    setTimeout(() => {
      initialHeight.value = window.innerHeight;
    }, 100);

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleResize);
    }
    // fallback: 监听 window resize（某些浏览器不支持 visualViewport）
    window.addEventListener('resize', handleResize);
  });

  onUnmounted(() => {
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', handleResize);
    }
    window.removeEventListener('resize', handleResize);
  });

  return {
    keyboardHeight,
    isKeyboardOpen
  };
}
