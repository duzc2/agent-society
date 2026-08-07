<script setup lang="ts">
/**
 * 心情颜色环组件
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
  return { background: `conic-gradient(${props.moodColors.join(', ')})` };
});
</script>

<template>
  <div v-if="showColors" class="w-full h-full" :style="gradientStyle" />
</template>
