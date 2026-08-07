<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { Copy, Check, FileJson } from 'lucide-vue-next';
import { getMarkdownEngine } from '../file-viewer/renderers/markdown';
import type { RenderResult } from '../file-viewer/renderers/markdown';
import { renderAllCodeBlocks } from '../file-viewer/renderers/markdown/plugins/code-highlight';
import { renderAllMath } from '../file-viewer/renderers/markdown/plugins/math';
import { useAppStore } from '../../stores/app';
import '../file-viewer/renderers/markdown/prism-theme.css';
import 'katex/dist/katex.min.css';
import '../file-viewer/renderers/markdown/katex-theme.css';

const appStore = useAppStore();

// 消息类型检测
type ContentType = 'json' | 'markdown' | 'text';

const props = defineProps<{
  content: string;
  searchKeyword?: string;
  messageId?: string;
}>();

// 状态
const copied = ref(false);
const contentRef = ref<HTMLElement | null>(null);

// Markdown 引擎
const mdEngine = getMarkdownEngine();

/**
 * 检测内容类型
 */
const detectContentType = (content: string): ContentType => {
  const trimmed = content.trim();

  // 1. 检测 JSON
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // 不是有效 JSON，继续检查
    }
  }

  // 2. 检测 Markdown 特征
  const markdownIndicators = [
    /^#{1,6}\s+/m,        // 标题
    /^\*{3,}$/m,           // 分隔线
    /^[-*+]\s+/m,          // 无序列表
    /^\d+\.\s+/m,          // 有序列表
    /```[\s\S]*?```/,      // 代码块
    /\[.*?\]\(.*?\)/,      // 链接
    /^\>\s+/m,             // 引用
    /^\$\$[\s\S]*?\$\$/,   // 块级公式
    /\$.*?\$/,             // 行内公式
    /\*\*.*?\*\*/,         // 粗体
    /_.*?_/,               // 斜体
  ];

  for (const indicator of markdownIndicators) {
    if (indicator.test(trimmed)) {
      return 'markdown';
    }
  }

  // 3. 默认为纯文本
  return 'text';
};

const contentType = computed(() => detectContentType(props.content));

/**
 * 渲染 Markdown
 */
const renderMarkdown = (content: string): RenderResult => {
  return mdEngine.render(content, {
    filePath: '',
    workspaceId: undefined
  });
};

/**
 * 格式化 JSON
 */
const formatJson = (content: string): string => {
  try {
    const obj = JSON.parse(content);
    return JSON.stringify(obj, null, 2);
  } catch {
    return content;
  }
};

/**
 * 高亮 JSON
 */
const highlightJson = (content: string): string => {
  try {
    const obj = JSON.parse(content);
    const jsonStr = JSON.stringify(obj, null, 2);

    // 简单的语法高亮
    return jsonStr
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
        let cls = 'json-number';
        if (/^"/.test(match)) {
          if (/:$/.test(match)) {
            cls = 'json-key';
          } else {
            cls = 'json-string';
          }
        } else if (/true|false/.test(match)) {
          cls = 'json-boolean';
        } else if (/null/.test(match)) {
          cls = 'json-null';
        }
        return `<span class="${cls}">${match}</span>`;
      });
  } catch {
    return content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
};

/**
 * 渲染带搜索高亮的内容
 */
const renderWithHighlight = (html: string): string => {
  if (!props.searchKeyword?.trim()) return html;

  const keyword = props.searchKeyword.trim();
  const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // 只在文本内容中替换，避免破坏 HTML 标签
  const regex = new RegExp(`(>)([^<]*?)(${escapedKeyword})([^<]*?)(<)`, 'gi');
  return html.replace(regex, (_, start, prefix, match, suffix, end) => {
    return `${start}${prefix}<mark class="search-highlight">${match}</mark>${suffix}${end}`;
  });
};

/**
 * JSON 内容
 */
const jsonContent = computed(() => formatJson(props.content.trim()));

/**
 * 高亮的 JSON
 */
const highlightedJson = computed(() => highlightJson(props.content.trim()));

/**
 * Markdown 渲染结果
 */
const markdownResult = computed(() => renderMarkdown(props.content.trim()));

/**
 * 渲染后的 Markdown HTML
 */
const renderedMarkdownHtml = computed(() => {
  const html = markdownResult.value.html;
  return renderWithHighlight(html);
});

/**
 * 纯文本内容（转义 HTML）
 */
const textContent = computed(() => {
  return props.content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
});

/**
 * 渲染后的纯文本（带高亮）
 */
const renderedTextHtml = computed(() => {
  const text = textContent.value;
  if (!props.searchKeyword?.trim()) return `<div class="text-content">${text}</div>`;

  const keyword = props.searchKeyword.trim();
  const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escapedKeyword})`, 'gi');

  const highlighted = text.replace(regex, '<mark class="search-highlight">$1</mark>');
  return `<div class="text-content">${highlighted}</div>`;
});

/**
 * 复制到剪贴板
 */
const copyToClipboard = async () => {
  try {
    const textToCopy = contentType.value === 'json'
      ? jsonContent.value
      : props.content;

    await navigator.clipboard.writeText(textToCopy);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch (err) {
    console.error('复制失败:', err);
  }
};

/**
 * 渲染后处理（代码高亮、数学公式）
 */
watch(() => [props.content, contentType.value], () => {
  nextTick(() => {
    if (!contentRef.value) return;

    if (contentType.value === 'markdown') {
      renderAllCodeBlocks(contentRef.value);
      renderAllMath(contentRef.value);
    }
  });
}, { immediate: true });

onMounted(() => {
  nextTick(() => {
    if (!contentRef.value) return;

    if (contentType.value === 'markdown') {
      renderAllCodeBlocks(contentRef.value);
      renderAllMath(contentRef.value);
    }
  });
});
</script>

<template>
  <div class="message-content" ref="contentRef" :style="{ fontSize: appStore.chatFontSize + 'px' }">
    <!-- JSON 内容 -->
    <div v-if="contentType === 'json'" class="json-content">
      <div class="json-header flex items-center justify-between mb-2 px-2 py-1 rounded-lg bg-[var(--surface-3)]">
        <div class="flex items-center gap-2">
          <FileJson class="w-3.5 h-3.5 text-[var(--primary)]" />
          <span class="text-[10px] font-bold text-[var(--text-3)] uppercase tracking-wider">JSON</span>
        </div>
        <button
          @click="copyToClipboard"
          class="flex items-center gap-1 text-[10px] text-[var(--primary)] hover:text-[var(--primary-hover)] transition-colors cursor-pointer px-2 py-1 rounded hover:bg-[var(--surface-2)]"
          :title="copied ? '已复制' : '复制 JSON'"
        >
          <Check v-if="copied" class="w-3.5 h-3.5" />
          <Copy v-else class="w-3.5 h-3.5" />
          <span v-if="!copied" class="hidden sm:inline">复制</span>
        </button>
      </div>
      <pre
        class="json-body text-xs font-mono p-3 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]"
        v-html="highlightedJson"
      ></pre>
    </div>

    <!-- Markdown 内容 -->
    <div
      v-else-if="contentType === 'markdown'"
      class="markdown-content"
      v-html="renderedMarkdownHtml"
    ></div>

    <!-- 纯文本内容 -->
    <div
      v-else
      class="text-content-wrapper"
      v-html="renderedTextHtml"
    ></div>
  </div>
</template>

<style scoped>
.message-content {
  width: 100%;
}

/* JSON 样式 */
.json-content {
  --json-key: #0451a5;
  --json-string: #a31515;
  --json-number: #098658;
  --json-boolean: #0000ff;
  --json-null: #808080;
}

.my-app-dark .json-content {
  --json-key: #9cdcfe;
  --json-string: #ce9178;
  --json-number: #b5cea8;
  --json-boolean: #569cd6;
  --json-null: #569cd6;
}

.json-key { color: var(--json-key); }
.json-string { color: var(--json-string); }
.json-number { color: var(--json-number); }
.json-boolean { color: var(--json-boolean); }
.json-null { color: var(--json-null); }

.json-body {
  /* 为未命中语法高亮规则的括号、逗号、冒号等字符提供主题文本色，
     避免深色主题下继承浏览器默认黑色，导致在深蓝背景上对比度不足。 */
  color: var(--text-1);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
}

/* Markdown 样式 */
.markdown-content {
  color: var(--text-1);
  line-height: 1.7;
  word-wrap: break-word;
  overflow-wrap: break-word;
  max-width: 100%;
}

.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3),
.markdown-content :deep(h4),
.markdown-content :deep(h5),
.markdown-content :deep(h6) {
  color: var(--text-1);
  font-weight: 600;
  margin-top: 1em;
  margin-bottom: 0.5em;
}

.markdown-content :deep(h1) { font-size: 1.4em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
.markdown-content :deep(h2) { font-size: 1.25em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
.markdown-content :deep(h3) { font-size: 1.1em; }

.markdown-content :deep(p) {
  margin-bottom: 0.75em;
}

.markdown-content :deep(code) {
  background: var(--surface-3);
  padding: 0.2em 0.4em;
  border-radius: 4px;
  font-size: 0.9em;
  color: var(--primary);
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
}

.markdown-content :deep(pre) {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1em;
  margin: 0.75em 0;
  max-width: 100%;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
}

.markdown-content :deep(pre code) {
  background: transparent;
  padding: 0;
  color: var(--text-1);
  font-size: 0.85em;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
}

.markdown-content :deep(blockquote) {
  border-left: 4px solid var(--primary);
  padding-left: 1em;
  margin: 0.75em 0;
  color: var(--text-2);
  font-style: italic;
}

.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  padding-left: 1.5em;
  margin-bottom: 0.75em;
}

.markdown-content :deep(li) {
  margin-bottom: 0.25em;
}

.markdown-content :deep(a) {
  color: var(--primary);
  text-decoration: none;
}

.markdown-content :deep(a:hover) {
  color: var(--primary-hover);
  text-decoration: underline;
}

.markdown-content :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0.75em 0;
  font-size: 0.9em;
  display: block;
  overflow-x: auto;
  max-width: 100%;
}

.markdown-content :deep(th),
.markdown-content :deep(td) {
  border: 1px solid var(--border);
  padding: 0.4em 0.6em;
  text-align: left;
}

.markdown-content :deep(th) {
  background: var(--surface-3);
  font-weight: 600;
}

.markdown-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 1.5em 0;
}

.markdown-content :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  margin: 0.75em 0;
}

/* 数学公式样式 */
.markdown-content :deep(.math-inline) {
  display: inline;
}

.markdown-content :deep(.math-block) {
  display: block;
  margin: 0.75em 0;
  overflow-x: auto;
  max-width: 100%;
}

/* 防止内容撑大容器 */
.markdown-content :deep(*) {
  max-width: 100%;
}

/* 纯文本样式 */
.text-content-wrapper {
  color: var(--text-1);
  white-space: pre-wrap;
  line-height: 1.6;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

.text-content {
  white-space: pre-wrap;
  line-height: 1.6;
}

/* 搜索高亮 */
:deep(.search-highlight) {
  background-color: var(--org-anim-highlight, #FDE047);
  color: var(--text-1);
  padding: 0.1em 0.2em;
  border-radius: 2px;
  font-weight: 600;
}

/* Prism 代码块样式继承 */
.markdown-content :deep(pre[class*="language-"]) {
  margin: 0.75em 0;
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
}

.markdown-content :deep(code[class*="language-"]) {
  font-size: 0.85em;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
}
</style>
