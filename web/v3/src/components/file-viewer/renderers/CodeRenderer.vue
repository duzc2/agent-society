<script setup lang="ts">
/**
 * 代码渲染器
 *
 * 使用 Prism.js 进行语法高亮，支持多种编程语言
 *
 * @module components/file-viewer/renderers/CodeRenderer
 */
import { computed, inject, onMounted, ref } from 'vue';
import * as Prism from 'prismjs';
import type { Token } from 'prismjs';
import type { RendererProps } from '../types';
import { CopyFunctionKey } from '../injectionKeys';

// Prism 语言定义（与 code-highlight.ts 共享 Prism 单例，但为确保可用性显式导入）
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-swift';
import 'prismjs/components/prism-kotlin';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-sql';

// 文件扩展名 → Prism 语言名 映射
const LANG_MAP: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript',
  jsx: 'javascript', tsx: 'typescript',
  py: 'python', pyw: 'python',
  java: 'java',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  swift: 'swift',
  kt: 'kotlin', kts: 'kotlin',
  rb: 'ruby',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
  json: 'json',
  yaml: 'yaml', yml: 'yaml',
  sql: 'sql',
};

const props = defineProps<RendererProps>();

// 注入 FileViewer 提供的方法
const copyContext = inject<{ setCopyFunction: (fn: () => void) => void; copied?: { value: boolean } } | null>(CopyFunctionKey, null);

// 状态
const localCopied = ref(false);

/**
 * 代码内容
 */
const codeContent = computed(() => {
  if (typeof props.content.data === 'string') {
    return props.content.data;
  }
  if (props.content.data instanceof ArrayBuffer) {
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(props.content.data);
  }
  return '';
});

/**
 * 文件扩展名
 */
const fileExtension = computed(() => {
  const name = props.fileName || props.filePath || '';
  const parts = name.split('.');
  return parts.length > 1 ? parts.pop()?.toLowerCase() || '' : '';
});

/**
 * Prism 语言名
 */
const lang = computed(() => {
  return LANG_MAP[fileExtension.value] || '';
});

/**
 * HTML 转义
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 构建单行包裹的 span 标签 HTML
 */
function tokenSpanStart(type: string): string {
  return `<span class="token ${type}">`;
}

/**
 * 基于 Prism tokenize 的逐行高亮
 *
 * 关键设计：
 * 1. 使用 Prism.tokenize() 获取 token 流（而非 highlight() 返回的 HTML 字符串）
 * 2. 逐行处理 token，遇到换行时关闭并重新打开跨行的 span
 * 3. 确保每行都是合法的 HTML 片段，可在 <td> 中独立渲染
 */
function highlightCodeLineByLine(code: string, grammar: Record<string, any>): string[] {
  const tokens = Prism.tokenize(code, grammar);
  const lines: string[] = [];
  let currentLine = '';
  // 跨行 token 栈：记录每层 span 的打开标签
  const openSpans: string[] = [];

  /** 追加文本到当前行，处理换行 */
  function appendText(str: string): void {
    const parts = str.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        // 换行：关闭所有打开的 span，结束当前行，在新行重新打开
        for (let j = openSpans.length - 1; j >= 0; j--) {
          currentLine += '</span>';
        }
        lines.push(currentLine);
        currentLine = '';
        for (const span of openSpans) {
          currentLine += span;
        }
      }
      currentLine += escapeHtml(parts[i] ?? '');
    }
  }

  /** 递归处理 token */
  function processToken(token: string | Token): void {
    if (typeof token === 'string') {
      appendText(token);
      return;
    }

    const type = typeof token.type === 'string' ? token.type : '';
    const spanOpen = tokenSpanStart(type);
    currentLine += spanOpen;
    openSpans.push(spanOpen);

    if (typeof token.content === 'string') {
      appendText(token.content);
    } else if (Array.isArray(token.content)) {
      for (const child of token.content) {
        processToken(child);
      }
    } else if (token.content != null) {
      appendText(String(token.content));
    }

    currentLine += '</span>';
    openSpans.pop();
  }

  for (const token of tokens) {
    processToken(token);
  }

  // 最后一行
  lines.push(currentLine);

  return lines;
}

/**
 * 高亮后的代码行（每行是独立的 HTML 片段）
 */
const highlightedLines = computed(() => {
  const code = codeContent.value;
  const grammar = lang.value ? Prism.languages[lang.value] : null;

  if (!grammar) {
    // 无匹配语法时仅做 HTML 转义
    return code.split('\n').map(line => escapeHtml(line));
  }

  try {
    return highlightCodeLineByLine(code, grammar);
  } catch (err) {
    console.error('[CodeRenderer] Prism highlight failed:', err);
    return code.split('\n').map(line => escapeHtml(line));
  }
});

/**
 * 复制到剪贴板
 */
const copyToClipboard = async () => {
  try {
    await navigator.clipboard.writeText(codeContent.value);
    if (copyContext?.copied) {
      const copiedRef = copyContext.copied as any;
      if (typeof copiedRef === 'object' && 'value' in copiedRef) {
        copiedRef.value = true;
        setTimeout(() => {
          if ((copyContext.copied as any)?.value) {
            (copyContext.copied as any).value = false;
          }
        }, 2000);
      }
    } else {
      localCopied.value = true;
      setTimeout(() => {
        localCopied.value = false;
      }, 2000);
    }
    console.log('[CodeRenderer] copyToClipboard success');
  } catch (err) {
    console.error('复制失败:', err);
  }
};

// 组件挂载时注册复制函数
onMounted(() => {
  console.log('[CodeRenderer] onMounted, copyContext:', copyContext);
  if (copyContext) {
    copyContext.setCopyFunction(copyToClipboard);
    console.log('[CodeRenderer] copyFunction registered');
  }
});
</script>

<template>
  <div class="code-renderer flex flex-col h-full bg-[var(--bg)]">
    <!-- 代码内容 -->
    <div class="flex-1 overflow-auto">
      <table class="code-table">
        <tbody>
          <tr v-for="(lineHtml, index) in highlightedLines" :key="index">
            <td class="line-number">{{ index + 1 }}</td>
            <td class="code-line" v-html="lineHtml || '&nbsp;'" />
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.code-renderer {
  width: 100%;
  height: 100%;
}

.code-table {
  width: 100%;
  border-collapse: collapse;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.5;
}

.line-number {
  width: 50px;
  padding: 0 12px;
  text-align: right;
  color: var(--text-3);
  background: var(--surface-2);
  border-right: 1px solid var(--border);
  user-select: none;
  vertical-align: top;
}

.code-line {
  padding: 0 12px;
  color: var(--text-1);
  white-space: pre;
  vertical-align: top;
}

/* Prism token 语法高亮颜色 */
:deep(.token.keyword) { color: #c678dd; }
:deep(.token.string) { color: #98c379; }
:deep(.token.number) { color: #d19a66; }
:deep(.token.comment) { color: #5c6370; font-style: italic; }
:deep(.token.function) { color: #61afef; }
:deep(.token.operator) { color: #56b6c2; }
:deep(.token.punctuation) { color: #abb2bf; }
:deep(.token.boolean) { color: #d19a66; }
:deep(.token.class-name) { color: #e5c07b; }
:deep(.token.builtin) { color: #e5c07b; }
:deep(.token.attr-name) { color: #d19a66; }
:deep(.token.attr-value) { color: #98c379; }
:deep(.token.tag) { color: #e06c75; }
:deep(.token.regex) { color: #56b6c2; }
:deep(.token.variable) { color: #e06c75; }
:deep(.token.property) { color: #e06c75; }
:deep(.token.selector) { color: #d19a66; }
:deep(.token.important) { color: #c678dd; font-weight: bold; }
:deep(.token.bold) { font-weight: bold; }
:deep(.token.italic) { font-style: italic; }
</style>
