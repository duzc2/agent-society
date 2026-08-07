<script setup lang="ts">
/**
 * 心情颜色环组件（移动端精简版）
 * 使用 CSS conic-gradient 在圆形容器内显示 5 色渐变环。
 * 父组件将 MoodGrid 放在 rounded-full 容器内作为彩色背景层。
 */
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  moodColors?: string[] | null;
  enabled?: boolean;
}>(), {});

const showColors = computed(() =>
  props.enabled !== false && Array.isArray(props.moodColors) && props.moodColors.length === 5
);

const gradientStyle = computed(() => {
  if (!showColors.value || !props.moodColors) return {};
  // 末尾重复第一个颜色作为第 6 个色标，确保 c5→c1 有渐变过渡而非硬切
  const allStops = [...props.moodColors, props.moodColors[0]];
  return { background: `conic-gradient(${allStops.join(', ')})` };
});
</script>

<template>
  <div v-if="showColors" class="w-full h-full" :style="gradientStyle" />
</template>
