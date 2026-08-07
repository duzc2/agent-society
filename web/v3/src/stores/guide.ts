import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useOrgStore } from './org';
import { orgTreeState } from '../services/heartbeatService';

/**
 * 新手引导状态管理
 *
 * 职责：
 * - 管理引导显示状态（仅运行时）
 * - 检查是否应该显示引导
 * - 显示/隐藏引导
 *
 * 注意：
 * - 不使用localStorage
 * - 不存储引导完成状态
 * - 每次刷新检查组织列表
 * - 纯前端实现
 *
 * @author Agent Society
 */
export const useGuideStore = defineStore('guide', () => {
  // 用户是否主动关闭了引导（JS状态，仅运行时，不持久化）
  const dismissed = ref(false);

  /**
   * 是否显示引导 — 响应式计算
   *
   * 自动依赖：
   * - orgTreeState.loaded：心跳是否已推送组织树
   * - useOrgStore().orgs：组织列表
   * - dismissed：用户是否关闭
   *
   * 规则：
   * - 心跳数据未到达 → 不显示（等待中）
   * - 存在真实组织（id !== 'home'） → 不显示
   * - 用户关闭 → 不显示
   * - 无真实组织且已加载 → 显示
   */
  const isVisible = computed(() => {
    // 用户已主动关闭
    if (dismissed.value) return false;
    // 心跳尚未推送组织树数据，无法判断
    if (!orgTreeState.loaded) return false;
    // 过滤掉"首页"虚拟组织，检查是否有真实组织
    const realOrgs = useOrgStore().orgs.filter(org => org.id !== 'home');
    return realOrgs.length === 0;
  });

  /**
   * 检查是否应该显示引导（兼容旧接口）
   */
  const shouldShowGuide = (): boolean => {
    return isVisible.value;
  };

  /**
   * 隐藏引导（JS逻辑）
   *
   * 调用时机：
   * - 用户点击发送按钮
   * - 用户点击关闭按钮
   * - 组织被创建后
   */
  const hideGuide = () => {
    dismissed.value = true;
    console.log('隐藏新手引导');
  };

  return {
    isVisible,
    shouldShowGuide,
    hideGuide,
  };
});
