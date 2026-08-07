<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine } from '@codemirror/view';

interface Props {
  leftContent: string;
  rightContent: string;
  fontSize?: number;
}

const props = withDefaults(defineProps<Props>(), {
  fontSize: 14
});

const emit = defineEmits<{
  (event: 'update:rightContent', value: string): void;
}>();

const containerRef = ref<HTMLDivElement | null>(null);
let mergeView: MergeView | null = null;

// 创建监听更新的扩展
const createUpdateListener = (callback: (content: string) => void) => {
  return EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      callback(update.state.doc.toString());
    }
  });
};

const createEditorTheme = () => {
  return EditorView.theme({
    '&': {
      height: '100%',
      fontSize: `${props.fontSize}px`,
      color: 'var(--text-1)',
      backgroundColor: 'var(--surface-1)'
    },
    '.cm-scroller': {
      fontFamily: '"Cascadia Code", "Fira Code", Consolas, monospace',
      overflow: 'auto'
    },
    '.cm-content': {
      caretColor: 'var(--text-1)',
      color: 'var(--text-1)'
    },
    '.cm-line': {
      color: 'var(--text-1)'
    },
    '.cm-gutters': {
      backgroundColor: 'var(--surface-2)',
      color: 'var(--text-3)',
      border: 'none'
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 8px 0 4px',
      color: 'var(--text-3)'
    },
    '.cm-deletedChunk': {
      backgroundColor: 'rgba(220, 53, 69, 0.15)'
    },
    '.cm-insertedChunk': {
      backgroundColor: 'rgba(40, 167, 69, 0.15)'
    },
    '.cm-deletedText': {
      backgroundColor: 'rgba(220, 53, 69, 0.4)'
    },
    '.cm-insertedText': {
      backgroundColor: 'rgba(40, 167, 69, 0.4)'
    },
    '.cm-merge-gap': {
      backgroundColor: 'var(--border)'
    },
    '&.cm-focused': {
      outline: 'none'
    }
  });
};

const initMergeView = () => {
  if (!containerRef.value) return;

  // 清理旧的 mergeView
  if (mergeView) {
    mergeView.destroy();
    mergeView = null;
  }

  const baseExtensions = [
    createEditorTheme(),
    lineNumbers(),
    highlightActiveLine(),
    EditorView.lineWrapping
  ];

  mergeView = new MergeView({
    a: {
      doc: props.leftContent,
      extensions: [
        ...baseExtensions,
        EditorState.readOnly.of(true)
      ]
    },
    b: {
      doc: props.rightContent,
      extensions: [
        ...baseExtensions,
        createUpdateListener((content) => {
          emit('update:rightContent', content);
        })
      ]
    },
    parent: containerRef.value,
    orientation: 'a-b'
  });
};

// 监听左侧内容变化
watch(() => props.leftContent, (newVal) => {
  if (mergeView?.a) {
    mergeView.a.dispatch({
      changes: { from: 0, to: mergeView.a.state.doc.length, insert: newVal }
    });
  }
});

// 监听右侧内容变化（外部更新）
watch(() => props.rightContent, (newVal) => {
  if (mergeView?.b) {
    const currentContent = mergeView.b.state.doc.toString();
    if (currentContent !== newVal) {
      mergeView.b.dispatch({
        changes: { from: 0, to: mergeView.b.state.doc.length, insert: newVal }
      });
    }
  }
});

// 监听字体大小变化，重新创建编辑器
watch(() => props.fontSize, () => {
  initMergeView();
});

onMounted(() => {
  initMergeView();
});

onBeforeUnmount(() => {
  if (mergeView) {
    mergeView.destroy();
    mergeView = null;
  }
});
</script>

<template>
  <div class="skill-diff-editor h-full w-full">
    <div ref="containerRef" class="h-full w-full"></div>
  </div>
</template>

<style scoped>
.skill-diff-editor {
  background-color: var(--surface-1);
}

.skill-diff-editor :deep(.cm-merge-view) {
  height: 100%;
  display: flex;
  background-color: var(--surface-1);
}

.skill-diff-editor :deep(.cm-merge-view > div) {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  background-color: var(--surface-1);
}

.skill-diff-editor :deep(.cm-merge-view .cm-editor) {
  height: 100%;
  background-color: var(--surface-1);
}

.skill-diff-editor :deep(.cm-merge-view .cm-editor .cm-content) {
  color: var(--text-1);
}

.skill-diff-editor :deep(.cm-merge-view .cm-editor .cm-line) {
  color: var(--text-1);
}

.skill-diff-editor :deep(.cm-merge-view .cm-merge-gap) {
  flex-shrink: 0;
  width: 3px;
  background-color: var(--border);
}
</style>
