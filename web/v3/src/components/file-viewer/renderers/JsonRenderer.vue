<script setup lang="ts">
/**
 * JSON 渲染器
 * 
 * 支持 JSON 格式化显示和折叠
 * 
 * @module components/file-viewer/renderers/JsonRenderer
 */
import { computed, ref } from 'vue';
import { Copy, Check } from 'lucide-vue-next';
import Button from 'primevue/button';
import type { RendererProps } from '../types';

const props = defineProps<RendererProps>();

// 状态
const copied = ref(false);

/**
 * JSON 内容（剥离 BOM、去除首尾空白）
 */
const jsonContent = computed(() => {
  let text = '';
  if (typeof props.content.data === 'string') {
    text = props.content.data;
  } else if (props.content.data instanceof ArrayBuffer) {
    const decoder = new TextDecoder('utf-8');
    text = decoder.decode(props.content.data);
  }
  // 剥离 UTF-8 BOM（\uFEFF），否则首行 JSON.parse 会失败
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
  }
  return text;
});

/**
 * 是否有效的 JSON（整体为单一 JSON 文档）
 * 注意：必须在 isJsonl 之前定义，因为 isJsonl 依赖本计算属性。
 */
const isValidJson = computed(() => {
  try {
    JSON.parse(jsonContent.value);
    return true;
  } catch {
    return false;
  }
});

/**
 * 是否为 JSONL（JSON Lines）格式
 * JSONL 文件每行是一个独立的 JSON 值，整体不是合法的 JSON。
 * 只有在整体不是合法 JSON 时才检测 JSONL，避免误判单行 JSON。
 * 兼容 \r\n、\r 等不同换行符。
 */
const isJsonl = computed(() => {
  if (isValidJson.value) return false;
  const text = jsonContent.value;
  if (!text.trim()) return false;
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return false;
  try {
    for (const line of lines) {
      JSON.parse(line.trim());
    }
    return true;
  } catch {
    return false;
  }
});

/**
 * JSONL 每行解析后的对象数组
 */
const jsonlLines = computed(() => {
  if (!isJsonl.value) return [];
  const lines = jsonContent.value.split(/\r?\n/).filter(line => line.trim());
  return lines.map(line => {
    try {
      return JSON.parse(line.trim());
    } catch {
      return null;
    }
  }).filter((v): v is unknown => v !== null);
});

/**
 * 格式化的 JSON / JSONL
 */
const formattedJson = computed(() => {
  try {
    // 优先按标准 JSON 处理
    const parsed = JSON.parse(jsonContent.value);
    return JSON.stringify(parsed, null, 2);
  } catch {
    // JSONL 回退：每行独立格式化后用空行分隔
    if (isJsonl.value && jsonlLines.value.length > 0) {
      return jsonlLines.value
        .map(obj => JSON.stringify(obj, null, 2))
        .join('\n\n');
    }
    return jsonContent.value;
  }
});

/**
 * 复制到剪贴板
 */
const copyToClipboard = async () => {
  try {
    await navigator.clipboard.writeText(formattedJson.value);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch (err) {
    console.error('复制失败:', err);
  }
};
</script>

<template>
  <div class="json-renderer flex flex-col h-full bg-[var(--bg)] relative">
    <!-- JSON 验证状态 -->
    <div class="absolute top-3 left-3 z-10">
      <span
        v-if="isValidJson"
        class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700"
      >
        有效 JSON
      </span>
      <span
        v-else-if="isJsonl"
        class="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700"
      >
        JSONL（{{ jsonlLines.length }} 条记录）
      </span>
      <span
        v-else
        class="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700"
      >
        无效 JSON
      </span>
    </div>

    <!-- 悬浮复制按钮 -->
    <div class="absolute top-3 right-3 z-10">
      <Button
        variant="text"
        size="small"
        v-tooltip.bottom="copied ? '已复制' : '复制 JSON'"
        @click="copyToClipboard"
        class="bg-[var(--surface-1)]/80 backdrop-blur"
      >
        <Check v-if="copied" class="w-4 h-4 text-green-500" />
        <Copy v-else class="w-4 h-4" />
      </Button>
    </div>

    <!-- JSON 内容 -->
    <div class="flex-1 overflow-auto">
      <pre class="p-4 pt-12 text-sm font-mono"><code class="json">{{ formattedJson }}</code></pre>
    </div>
  </div>
</template>

<style scoped>
.json-renderer {
  width: 100%;
  height: 100%;
}

pre {
  margin: 0;
  min-height: 100%;
}

code.json {
  color: var(--text-1);
  line-height: 1.6;
}

/* JSON 语法高亮 */
code.json :deep(.string) { color: #22c55e; }
code.json :deep(.number) { color: #f59e0b; }
code.json :deep(.boolean) { color: #3b82f6; }
code.json :deep(.null) { color: #ef4444; }
code.json :deep(.key) { color: #8b5cf6; }
</style>
