<script setup lang="ts">
/**
 * 单条消息气泡
 * 显示：文本内容 / 工具调用 / 思考过程
 */
import { computed } from 'vue';
import type { Message } from '../../types';
import { Wrench, Brain, Bot, User, Clock, Database, BookOpen } from 'lucide-vue-next';
import { useAppStore } from '../../stores/app';
import { useAgentStore } from '../../stores/agent';
import MoodGrid from '../common/MoodGrid.vue';
import { isMoodDark } from '../../utils/moodColors';
import { useFileViewer } from '../../composables/useFileViewer';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
  breaks: true,
  gfm: true,
});

const props = defineProps<{
  message: Message;
}>();

const appStore = useAppStore();
const agentStore = useAgentStore();
const { openWorkspaceFile } = useFileViewer();

const senderMoodColors = computed(() => {
  if (isUser.value) return undefined;
  return agentStore.moodColorsMap[props.message.senderId];
});

const isUser = computed(() => props.message.senderType === 'user');
const isTool = computed(() => props.message.type === 'tool_call');
const hasReasoning = computed(() => !!props.message.reasoning);

const timeStr = computed(() => {
  const d = new Date(props.message.timestamp);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
});

// 将消息内容渲染为 markdown HTML
const renderedContent = computed(() => {
  const content = props.message.content;
  if (!content) return '';
  const raw = marked.parse(content) as string;
  return DOMPurify.sanitize(raw);
});

// 检查 payload 中是否有文件
const files = computed(() => {
  if (!props.message.payload) return [];
  const payload = props.message.payload;
  if (payload.files && Array.isArray(payload.files)) {
    return payload.files.map((f: any) => ({
      name: f.name || f.path?.split('/').pop() || 'file',
      path: f.path || f.name || '',
      mimeType: f.mimeType || '',
      extension: f.extension || f.name?.split('.').pop() || ''
    }));
  }
  if (payload.file) {
    const f = payload.file;
    return [{
      name: f.name || f.path?.split('/').pop() || 'file',
      path: f.path || f.name || '',
      mimeType: f.mimeType || '',
      extension: f.extension || f.name?.split('.').pop() || ''
    }];
  }
  return [];
});

// 判断文件是否为图片
function isImage(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

// 延迟消息标记
const delayInfo = computed(() => {
  const msg = props.message;
  // 已投递：显示投递信息
  if (msg.deliveredAt) {
    if (msg.sendTime) {
      const d = new Date(msg.sendTime);
      const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      return { label: '延迟消息', detail: `于 ${time} 发送` };
    }
    return { label: '延迟消息', detail: '已送达' };
  }
  // 未投递：显示预计送达时间
  if (msg.scheduledDeliveryTime) {
    const d = new Date(msg.scheduledDeliveryTime);
    const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return { label: '延迟消息', detail: `预计送达 ${time}` };
  }
  return null;
});

// 打开文件查看器
async function openFile(file: { name: string; path: string; mimeType: string }) {
  // 聊天消息中的图片文件，path 可能是 URL，直接打开
  if (isImage(file.mimeType)) {
    appStore.openFileViewer({
      fileName: file.name,
      mimeType: file.mimeType,
      content: '',
      src: file.path
    });
    return;
  }

  const err = await openWorkspaceFile(file);
  if (err) {
    appStore.openFileViewer({
      fileName: file.name,
      mimeType: file.mimeType,
      content: err,
      src: undefined
    });
  }
}
</script>

<template>
  <div
    :id="'msg-' + message.id"
    class="flex gap-2 animate-fade-in-up"
    :class="isUser ? 'flex-row-reverse' : 'flex-row'"
  >
    <!-- 头像 -->
    <div class="shrink-0 mt-0.5">
      <div
        class="relative w-9 h-9 rounded-full overflow-hidden flex items-center justify-center"
        :class="isUser ? 'bg-[var(--primary-weak)]' : ''"
      >
        <MoodGrid
          v-if="!isUser && (senderMoodColors?.length ?? 0) > 0 && appStore.moodColorsEnabled"
          :mood-colors="senderMoodColors"
          :enabled="appStore.moodColorsEnabled"
          class="absolute inset-0"
        />
        <User v-if="isUser" class="relative z-10 w-4 h-4 text-[var(--primary)]" />
        <Bot v-else class="relative z-10 w-4 h-4" :class="isMoodDark(senderMoodColors) ? 'text-white' : 'text-[var(--text-2)]'" />
      </div>
    </div>

    <!-- 气泡内容 -->
    <div
      class="max-w-[80%] rounded-2xl px-3 py-2 text-sm"
      :class="isUser
        ? 'bg-[var(--primary)] text-white rounded-br-md'
        : 'bg-[var(--surface-1)] text-[var(--text-1)] border border-[var(--border)] rounded-bl-md'"
    >
      <!-- 工具调用标记 -->
      <div v-if="isTool && message.toolCall" class="flex items-center gap-1 mb-1 text-xs opacity-70">
        <Wrench class="w-3 h-3" />
        <span>工具调用: {{ message.toolCall.name }}</span>
      </div>

      <!-- 记忆召回 (AgentMemory) -->
      <details v-if="message.memoryContext" class="mb-1">
        <summary class="flex items-center gap-1 text-xs text-[var(--text-3)] cursor-pointer">
          <Database class="w-3 h-3" />
          <span>记忆召回</span>
        </summary>
        <pre class="mt-1 text-xs text-[var(--text-3)] whitespace-pre-wrap break-words max-h-40 overflow-y-auto bg-[var(--surface-3)] rounded-lg p-2">{{ message.memoryContext }}</pre>
      </details>

      <!-- 知识树检索 (KnowledgeTree) -->
      <details v-if="message.knowledgeContext" class="mb-1">
        <summary class="flex items-center gap-1 text-xs text-[var(--text-3)] cursor-pointer">
          <BookOpen class="w-3 h-3" />
          <span>知识树</span>
        </summary>
        <pre class="mt-1 text-xs text-[var(--text-3)] whitespace-pre-wrap break-words max-h-40 overflow-y-auto bg-[var(--surface-3)] rounded-lg p-2">{{ message.knowledgeContext }}</pre>
      </details>

      <!-- 思考过程 -->
      <details v-if="hasReasoning" class="mb-1">
        <summary class="flex items-center gap-1 text-xs text-[var(--text-3)] cursor-pointer">
          <Brain class="w-3 h-3" />
          <span>思考过程</span>
        </summary>
        <pre class="mt-1 text-xs text-[var(--text-3)] whitespace-pre-wrap break-words max-h-40 overflow-y-auto bg-[var(--surface-3)] rounded-lg p-2">{{ message.reasoning }}</pre>
      </details>

      <!-- 消息正文（Markdown 渲染） -->
      <div
        class="markdown-body break-words text-sm leading-relaxed"
        :style="{ fontSize: appStore.chatFontSize + 'px' }"
        v-html="renderedContent"
      />

      <!-- 文件缩略图 -->
      <div v-if="files.length > 0" class="flex flex-wrap gap-2 mt-2">
        <button
          v-for="(file, i) in files"
          :key="i"
          class="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/10 text-xs active:scale-95 transition-transform"
          @click="openFile(file)"
          type="button"
        >
          <span v-if="isImage(file.mimeType)" class="text-base">🖼</span>
          <span v-else class="text-base">📄</span>
          <span class="truncate max-w-[100px]">{{ file.name }}</span>
        </button>
      </div>

      <!-- 延迟消息标记 -->
      <div
        v-if="delayInfo"
        class="flex items-center gap-1 text-[10px] mt-1 text-[var(--text-3)]"
      >
        <Clock class="w-3 h-3" />
        <span>{{ delayInfo.detail }}</span>
      </div>

      <!-- 时间戳 -->
      <div
        class="text-[10px] mt-1"
        :class="isUser ? 'text-white/60 text-right' : 'text-[var(--text-3)]'"
      >
        {{ timeStr }}
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Markdown 渲染样式 — 使用主题变量 */
.markdown-body :deep(h1) {
  font-size: 1.25rem;
  font-weight: 700;
  margin: 1rem 0 0.5rem;
  padding-bottom: 0.25rem;
  border-bottom: 1px solid var(--border);
}

.markdown-body :deep(h2) {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 0.875rem 0 0.5rem;
  padding-bottom: 0.25rem;
  border-bottom: 1px solid var(--border);
}

.markdown-body :deep(h3) {
  font-size: 1rem;
  font-weight: 600;
  margin: 0.75rem 0 0.375rem;
}

.markdown-body :deep(h4),
.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  font-weight: 600;
  margin: 0.625rem 0 0.25rem;
}

.markdown-body :deep(p) {
  margin: 0.375rem 0;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  padding-left: 1.25rem;
  margin: 0.375rem 0;
}

.markdown-body :deep(li) {
  margin: 0.125rem 0;
}

.markdown-body :deep(blockquote) {
  border-left: 3px solid var(--primary);
  padding-left: 0.75rem;
  margin: 0.5rem 0;
  opacity: 0.85;
}

.markdown-body :deep(code) {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 0.85em;
  background: var(--surface-2);
  padding: 0.15em 0.35em;
  border-radius: 3px;
}

.markdown-body :deep(pre) {
  background: var(--surface-2);
  padding: 0.75rem;
  border-radius: 6px;
  overflow-x: auto;
  margin: 0.5rem 0;
}

.markdown-body :deep(pre code) {
  background: none;
  padding: 0;
  font-size: 0.8rem;
  line-height: 1.5;
}

.markdown-body :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0.5rem 0;
  font-size: 0.85em;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--border);
  padding: 0.35rem 0.5rem;
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
  margin: 0.75rem 0;
}

.markdown-body :deep(a) {
  color: var(--primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.markdown-body :deep(img) {
  max-width: 100%;
  border-radius: 4px;
  margin: 0.25rem 0;
}

.markdown-body :deep(strong) {
  font-weight: 700;
}

.markdown-body :deep(em) {
  font-style: italic;
}
</style>
