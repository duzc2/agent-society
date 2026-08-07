<script setup lang="ts">
/**
 * 全屏文件查看器（适配明暗主题）
 * 支持：图片（双指捏合缩放）+ HTML 内嵌 + Markdown 渲染/源码切换 + 纯文本
 */
import { ref, watch, computed } from 'vue';
import { X, Download, Code, Eye, ExternalLink } from 'lucide-vue-next';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useAppStore } from '../../stores/app';

const appStore = useAppStore();

// 图片缩放
const scale = ref(1);
const isImage = ref(false);
const isHtml = ref(false);
const isMarkdown = ref(false);
const showSource = ref(false);
const showHtmlSource = ref(false);

// HTML 文件的原始 URL（iframe :src 直接加载，参考 web/v3）
const htmlFileUrl = computed(() => {
  const filePath = appStore.fileViewer.filePath;
  const workspaceId = appStore.currentOrgId;
  if (!filePath || !workspaceId) return '';
  const cleanPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
  return `/workspace-files/${encodeURIComponent(workspaceId)}/${encodeURIComponent(cleanPath)}`;
});

// 触摸状态
let initialPinchDistance = 0;
let initialScale = 1;

// 配置 marked
marked.setOptions({
  breaks: true,
  gfm: true,
});

function getFileExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx === -1) return '';
  return name.slice(idx).toLowerCase();
}

// 渲染后的 markdown HTML
const renderedHtml = computed(() => {
  if (!isMarkdown.value || !appStore.fileViewer.content) return '';
  const raw = marked.parse(appStore.fileViewer.content) as string;
  return DOMPurify.sanitize(raw);
});

watch(() => appStore.fileViewer.open, (open) => {
  if (open) {
    scale.value = 1;
    showSource.value = false;
    showHtmlSource.value = false;
    const mt = appStore.fileViewer.mimeType;
    const ext = getFileExtension(appStore.fileViewer.fileName);
    isImage.value = mt.startsWith('image/');
    isHtml.value = mt === 'text/html';
    isMarkdown.value = mt === 'text/markdown' || ext === '.md' || ext === '.markdown';
  }
});

function getFileUrl(path: string): string {
  if (path.startsWith('http')) return path;
  if (path.startsWith('/')) return path;
  return `/api/files/${encodeURIComponent(path)}`;
}

function getTouchDistance(e: TouchEvent): number {
  const t1 = e.touches[0];
  const t2 = e.touches[1];
  if (!t1 || !t2) return 0;
  return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
}

function onTouchStart(e: TouchEvent) {
  if (e.touches.length === 2) {
    initialPinchDistance = getTouchDistance(e);
    initialScale = scale.value;
  }
}

function onTouchMove(e: TouchEvent) {
  if (e.touches.length === 2) {
    e.preventDefault();
    const currentDistance = getTouchDistance(e);
    const ratio = currentDistance / initialPinchDistance;
    scale.value = Math.max(0.5, Math.min(5, initialScale * ratio));
  }
}

function toggleSource() {
  showSource.value = !showSource.value;
}

function toggleHtmlSource() {
  showHtmlSource.value = !showHtmlSource.value;
}

function close() {
  appStore.closeFileViewer();
}

function openInNewWindow() {
  if (!htmlFileUrl.value) return;
  window.open(htmlFileUrl.value, '_blank');
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="appStore.fileViewer.open"
      class="fixed inset-0 z-[200] bg-[var(--bg)] flex flex-col"
    >
      <!-- 顶部栏 -->
      <div class="flex items-center justify-between px-4 h-12 text-[var(--text-1)] shrink-0"
           style="padding-top: var(--safe-top)">
        <button
          class="p-1 -ml-1 rounded-lg hover:bg-[var(--surface-3)] transition-colors"
          @click="close"
          type="button"
          aria-label="关闭"
        >
          <X class="w-5 h-5" />
        </button>
        <span class="text-sm font-medium truncate mx-2">{{ appStore.fileViewer.fileName }}</span>

        <!-- 右侧按钮组 -->
        <div class="flex items-center gap-1">
          <!-- HTML 源码/预览切换 -->
          <button
            v-if="isHtml"
            class="p-1.5 rounded-lg hover:bg-[var(--surface-3)] transition-colors"
            :title="showHtmlSource ? '切换预览' : '切换源码'"
            @click="toggleHtmlSource"
            type="button"
            aria-label="切换源码预览"
          >
            <Eye v-if="showHtmlSource" class="w-4 h-4" />
            <Code v-else class="w-4 h-4" />
          </button>

          <!-- Markdown 源码/预览切换 -->
          <button
            v-if="isMarkdown"
            class="p-1.5 rounded-lg hover:bg-[var(--surface-3)] transition-colors"
            :title="showSource ? '切换预览' : '切换源码'"
            @click="toggleSource"
            type="button"
            aria-label="切换源码预览"
          >
            <Eye v-if="showSource" class="w-4 h-4" />
            <Code v-else class="w-4 h-4" />
          </button>

          <!-- 新窗口打开 -->
          <button
            v-if="isHtml"
            class="p-1.5 rounded-lg hover:bg-[var(--surface-3)] transition-colors"
            title="新窗口打开"
            @click="openInNewWindow"
            type="button"
            aria-label="新窗口打开"
          >
            <ExternalLink class="w-4 h-4" />
          </button>

          <!-- 下载 -->
          <a
            v-if="appStore.fileViewer.src"
            :href="getFileUrl(appStore.fileViewer.src)"
            target="_blank"
            class="p-1.5 rounded-lg hover:bg-[var(--surface-3)] transition-colors"
            aria-label="下载"
          >
            <Download class="w-4 h-4" />
          </a>
        </div>
      </div>

      <!-- 内容区 -->
      <div class="flex-1 overflow-auto">
        <!-- 图片 -->
        <div
          v-if="isImage && appStore.fileViewer.src"
          class="w-full h-full flex items-center justify-center overflow-auto bg-[var(--bg)]"
          @touchstart="onTouchStart"
          @touchmove="onTouchMove"
        >
          <img
            :src="getFileUrl(appStore.fileViewer.src)"
            :alt="appStore.fileViewer.fileName"
            class="max-w-full max-h-full object-contain transition-transform duration-100"
            :style="{ transform: `scale(${scale})` }"
          />
        </div>

        <!-- HTML 源码视图 -->
        <div v-else-if="isHtml && showHtmlSource" class="w-full h-full overflow-auto">
          <pre class="text-sm text-[var(--text-1)] whitespace-pre-wrap break-words font-mono leading-relaxed p-4">{{
            appStore.fileViewer.content || '(无内容)'
          }}</pre>
        </div>

        <!-- HTML iframe 预览（参考 web/v3，通过 :src 加载原始文件 URL） -->
        <iframe
          v-else-if="isHtml"
          class="w-full h-full bg-white border-0"
          :src="htmlFileUrl"
          sandbox="allow-scripts allow-same-origin"
        />

        <!-- Markdown 渲染 -->
        <div
          v-else-if="isMarkdown && !showSource"
          class="w-full max-w-2xl mx-auto"
        >
          <div
            class="markdown-body px-4 py-3 text-[var(--text-1)] text-sm leading-relaxed"
            v-html="renderedHtml"
          />
        </div>

        <!-- Markdown 源码 / 纯文本 -->
        <div v-else class="w-full h-full overflow-auto">
          <pre class="text-sm text-[var(--text-1)] whitespace-pre-wrap break-words font-mono leading-relaxed p-4">{{
            appStore.fileViewer.content || '(无内容)'
          }}</pre>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Markdown 渲染样式 — 使用主题变量，参考桌面版配色 */
.markdown-body :deep(h1) {
  font-size: 1.5rem;
  font-weight: 700;
  margin: 1.25rem 0 0.75rem;
  padding-bottom: 0.375rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-1);
}

.markdown-body :deep(h2) {
  font-size: 1.25rem;
  font-weight: 600;
  margin: 1.125rem 0 0.625rem;
  padding-bottom: 0.25rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-1);
}

.markdown-body :deep(h3) {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 1rem 0 0.5rem;
  color: var(--text-1);
}

.markdown-body :deep(h4),
.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  font-size: 1rem;
  font-weight: 600;
  margin: 0.875rem 0 0.375rem;
  color: var(--text-1);
}

.markdown-body :deep(p) {
  margin: 0.5rem 0;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  padding-left: 1.5rem;
  margin: 0.5rem 0;
}

.markdown-body :deep(li) {
  margin: 0.25rem 0;
}

.markdown-body :deep(blockquote) {
  border-left: 4px solid var(--primary);
  padding-left: 0.875rem;
  margin: 0.625rem 0;
  color: var(--text-2);
}

.markdown-body :deep(code) {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 0.85em;
  background: var(--surface-2);
  color: var(--text-1);
  padding: 0.15em 0.35em;
  border-radius: 3px;
}

.markdown-body :deep(pre) {
  background: var(--surface-2);
  padding: 0.875rem;
  border-radius: 6px;
  overflow-x: auto;
  margin: 0.625rem 0;
}

.markdown-body :deep(pre code) {
  background: none;
  padding: 0;
  font-size: 0.82rem;
  line-height: 1.55;
}

.markdown-body :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0.625rem 0;
  font-size: 0.85rem;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--border);
  padding: 0.4rem 0.625rem;
  text-align: left;
}

.markdown-body :deep(th) {
  background: var(--surface-2);
  font-weight: 600;
}

.markdown-body :deep(tr:nth-child(even)) {
  background: var(--surface-1);
}

.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 1rem 0;
}

.markdown-body :deep(a) {
  color: var(--primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.markdown-body :deep(a:hover) {
  opacity: 0.8;
}

.markdown-body :deep(img) {
  max-width: 100%;
  border-radius: 4px;
}

.markdown-body :deep(strong) {
  font-weight: 700;
}

.markdown-body :deep(em) {
  font-style: italic;
}
</style>
