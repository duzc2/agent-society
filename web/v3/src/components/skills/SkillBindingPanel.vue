<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="mb-3 flex items-center justify-between gap-3">
      <div class="text-sm text-[var(--text-2)]">
        共 {{ entries.length }} 个技能
      </div>
      <div class="text-xs text-[var(--text-3)]">
        智能体只会看到“已安装且可用”的技能
      </div>
    </div>

    <div v-if="loading" class="flex flex-1 items-center justify-center">
      <Loader2 class="h-5 w-5 animate-spin text-[var(--primary)]" />
    </div>

    <div v-else class="min-h-0 flex-1 overflow-y-auto space-y-3">
      <div
        v-for="entry in entries"
        :key="entry.skillId"
        :data-skill-id="entry.skillId"
        class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4"
      >
        <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <div class="truncate text-sm font-medium text-[var(--text-1)]">
                {{ entry.displayName }}
              </div>
              <span class="rounded-full px-2 py-0.5 text-xs" :class="installStateClass(entry.installState)">
                {{ installStateLabel(entry.installState) }}
              </span>
              <span class="rounded-full px-2 py-0.5 text-xs" :class="visibleStateClass(entry)">
                {{ visibleStateLabel(entry) }}
              </span>
            </div>
            <div class="mt-2 text-xs text-[var(--text-2)]">{{ entry.description || '暂无描述' }}</div>
            <div class="mt-2 space-y-1 text-xs text-[var(--text-3)]">
              <div>skillId：{{ entry.skillId }}</div>
              <div>配置来源：{{ sourceLabel(entry) }}</div>
              <div v-if="entry.missingReason">缺失原因：{{ entry.missingReason }}</div>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <Button
              v-for="action in actionsForEntry(entry)"
              :key="action.id"
              size="small"
              :variant="action.variant"
              :severity="action.severity"
              class="!px-3"
              @click="action.run"
            >
              {{ action.label }}
            </Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import Button from 'primevue/button';
import { useDialog } from 'primevue/usedialog';
import { Loader2 } from 'lucide-vue-next';
import type { SkillBinding, SkillBindingEntry, SkillBindingView } from '../../services/skillApi';
import { skillApi } from '../../services/skillApi';
import { openCustomSkillEditorWindow } from './custom/customSkillWindow';

const props = defineProps<{
  targetType: 'role' | 'agent';
  targetId: string;
  selectedSkillId?: string;
}>();

const loading = ref(false);
const view = ref<SkillBindingView | null>(null);
const dialog = useDialog();

const entries = computed(() => view.value?.entries || []);
const bindings = computed(() => view.value?.bindings || []);

const load = async () => {
  if (!props.targetId) return;
  loading.value = true;
  try {
    view.value = props.targetType === 'role'
      ? await skillApi.getRoleSkills(props.targetId)
      : await skillApi.getAgentSkills(props.targetId);
  } finally {
    loading.value = false;
  }
};

const saveBindings = async (nextBindings: SkillBinding[]) => {
  loading.value = true;
  try {
    view.value = props.targetType === 'role'
      ? await skillApi.updateRoleSkills(props.targetId, nextBindings)
      : await skillApi.updateAgentSkills(props.targetId, nextBindings);
  } finally {
    loading.value = false;
  }
};

const replaceBinding = (skillId: string, enabled: boolean | null) => {
  const current = bindings.value.filter((item) => item.skillId !== skillId);
  if (enabled !== null) {
    current.push({ skillId, enabled });
  }
  void saveBindings(current);
};

const installStateLabel = (installState: string): string => {
  if (installState === 'installed') return '已安装';
  if (installState === 'installing') return '安装中';
  if (installState === 'corrupted') return '已损坏';
  return '未安装';
};

const installStateClass = (installState: string): string => {
  if (installState === 'installed') return 'bg-green-500/10 text-green-600';
  if (installState === 'corrupted') return 'bg-red-500/10 text-red-600';
  return 'bg-[var(--surface-3)] text-[var(--text-3)]';
};

const visibleStateLabel = (entry: SkillBindingEntry): string => {
  if (entry.visible) return '运行时可见';
  if (entry.configuredEnabled && entry.missingReason) return '已配置但缺失';
  if (entry.source === 'role' && props.targetType === 'agent') return '从岗位继承';
  if (entry.configuredEnabled) return '已配置';
  if (entry.source === 'agent' && entry.agentConfiguredEnabled === false) return '实例已禁用';
  return '未配置';
};

const visibleStateClass = (entry: SkillBindingEntry): string => {
  if (entry.visible) return 'bg-emerald-500/10 text-emerald-600';
  if (entry.configuredEnabled && entry.missingReason) return 'bg-amber-500/10 text-amber-600';
  if (entry.source === 'agent' && entry.agentConfiguredEnabled === false) return 'bg-red-500/10 text-red-600';
  return 'bg-[var(--surface-3)] text-[var(--text-3)]';
};

const sourceLabel = (entry: SkillBindingEntry): string => {
  if (props.targetType === 'role') {
    return entry.configuredEnabled ? '岗位配置' : '未配置';
  }
  if (entry.source === 'agent') {
    return entry.agentConfiguredEnabled === false ? '智能体已禁用' : '智能体配置';
  }
  if (entry.source === 'role') {
    return '岗位继承';
  }
  return '未配置';
};

const actionsForEntry = (entry: SkillBindingEntry) => {
  const actions = [];
  if (entry.skillId.startsWith('custom:skill:')) {
    actions.push({
      id: 'edit-custom',
      label: '编辑技能',
      variant: 'outlined',
      severity: 'secondary',
      run: () => openCustomSkillEditorWindow(dialog, {
        skillId: entry.skillId,
        sourceContext: props.targetType === 'role' ? 'role_skill_list' : 'agent_skill_list'
      })
    });
  }

  if (props.targetType === 'role') {
    if (entry.configuredEnabled) {
      return [
        ...actions,
        {
          id: 'remove',
          label: '移除配置',
          variant: 'outlined',
          severity: 'secondary',
          run: () => replaceBinding(entry.skillId, null)
        }
      ];
    }
    return [
      ...actions,
      {
        id: 'enable',
        label: '添加为可用',
        variant: 'outlined',
        severity: 'primary',
        run: () => replaceBinding(entry.skillId, true)
      }
    ];
  }

  if (entry.source === 'agent') {
    return [
      ...actions,
      {
        id: 'remove-override',
        label: '移除实例配置',
        variant: 'outlined',
        severity: 'secondary',
        run: () => replaceBinding(entry.skillId, null)
      }
    ];
  }

  if (entry.source === 'role') {
    return [
      ...actions,
      {
        id: 'disable',
        label: '对该智能体禁用',
        variant: 'outlined',
        severity: 'danger',
        run: () => replaceBinding(entry.skillId, false)
      }
    ];
  }

  return [
    ...actions,
    {
      id: 'enable',
      label: '添加为可用',
      variant: 'outlined',
      severity: 'primary',
      run: () => replaceBinding(entry.skillId, true)
    }
  ];
};

watch(() => props.targetId, () => {
  void load();
}, { immediate: true });

watch(() => props.selectedSkillId, async (skillId) => {
  if (!skillId) return;
  await load();
  requestAnimationFrame(() => {
    const target = document.querySelector(`[data-skill-id="${skillId}"]`);
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
});

onMounted(() => {
  void load();
});
</script>
