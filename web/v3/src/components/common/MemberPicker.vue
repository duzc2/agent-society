<script setup lang="ts">
/**
 * 成员多选器：搜索 + 勾选列表。
 * 创建群 / 拉人 / 踢人 共用同一套选择 UI，避免三处重复实现。
 * 搜索按名称/角色/组织名过滤（组织名来自 orgTreeState）。
 */
import { ref, computed } from 'vue';
import { Search } from 'lucide-vue-next';
import { orgTreeState } from '../../services/heartbeatService';

/** 候选成员项（创建群/拉人传智能体；踢人传群成员，无 orgId 时不显示组织行） */
export interface MemberPickerItem {
  id: string;
  name: string;
  role?: string | null;
  orgId?: string;
}

const props = defineProps<{
  agents: MemberPickerItem[];
  modelValue: string[];
  /** 搜索框占位文案 */
  placeholder?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string[]): void;
}>();

const search = ref('');

// 组织名映射（智能体候选显示所属组织；逻辑同 GlobalSidebar 建群框）
const orgNameMap = computed(() => {
  const map: Record<string, string> = {};
  function walk(nodes: any[]) {
    for (const n of nodes) {
      // 组织节点：有 children 且有 roleName
      if (n.children?.length > 0 && n.roleName) map[n.id] = n.roleName;
      if (n.children) walk(n.children);
    }
  }
  walk(orgTreeState.tree);
  return map;
});

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return props.agents;
  return props.agents.filter(a => {
    const orgName = a.orgId ? (orgNameMap.value[a.orgId] || '') : '';
    return a.name.toLowerCase().includes(q) ||
      (a.role && a.role.toLowerCase().includes(q)) ||
      orgName.toLowerCase().includes(q);
  });
});

function toggle(id: string, checked: boolean) {
  const next = new Set(props.modelValue);
  if (checked) {
    next.add(id);
  } else {
    next.delete(id);
  }
  emit('update:modelValue', [...next]);
}
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <!-- 搜索框 -->
    <div class="relative">
      <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-3)]" />
      <input
        v-model="search"
        type="text"
        :placeholder="placeholder || '搜索名称、角色或组织...'"
        class="w-full pl-8 pr-3 py-1.5 text-sm rounded-md border border-[var(--border-1)] bg-[var(--surface-1)] text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-[var(--primary)]"
      />
    </div>
    <div v-if="filtered.length === 0" class="text-xs text-[var(--text-3)] py-2 text-center">
      {{ search ? '无匹配成员' : '暂无可选成员' }}
    </div>
    <div v-else class="max-h-48 overflow-y-auto border border-[var(--border-1)] rounded-md">
      <label
        v-for="agent in filtered"
        :key="agent.id"
        class="flex items-center gap-2 px-3 py-2 hover:bg-[var(--surface-2)] cursor-pointer border-b border-[var(--border-1)] last:border-b-0"
      >
        <input
          type="checkbox"
          :checked="modelValue.includes(agent.id)"
          class="w-4 h-4 accent-[var(--primary)] shrink-0"
          @change="toggle(agent.id, ($event.target as HTMLInputElement).checked)"
        />
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-sm text-[var(--text-1)] truncate">{{ agent.name }}</span>
            <span v-if="agent.role" class="text-xs text-[var(--text-3)] shrink-0">{{ agent.role }}</span>
          </div>
          <div v-if="agent.orgId && orgNameMap[agent.orgId]" class="text-[11px] text-[var(--text-3)] truncate">{{ orgNameMap[agent.orgId] }}</div>
        </div>
      </label>
    </div>
  </div>
</template>
