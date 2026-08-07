<script setup lang="ts">
import { ref, watch, inject } from 'vue';
import Button from 'primevue/button';
import { useDialog } from 'primevue/usedialog';
import { Loader2 } from 'lucide-vue-next';
import { skillApi, type SkillOverviewResponse } from '../../services/skillApi';
import RoleDetailDialog from '../overview/RoleDetailDialog.vue';
import { createDragEndHandler } from '../../utils/dialogBounds';
import { openAgentPropertiesWindow } from '../agent/agentPropertiesWindow';

const dialogRef = inject<any>('dialogRef');
const dialogData = dialogRef?.value?.data || {};
const skillId = String(dialogData.skillId || '');

const dialog = useDialog();
const overview = ref<SkillOverviewResponse | null>(null);
const loading = ref(false);

const load = async () => {
  if (!skillId) {
    overview.value = null;
    return;
  }
  loading.value = true;
  try {
    overview.value = await skillApi.getSkillOverview(skillId);
  } finally {
    loading.value = false;
  }
};

const openRole = (roleId: string, roleName: string) => {
  dialog.open(RoleDetailDialog, {
    props: {
      header: `岗位属性：${roleName}`,
      style: { width: '860px', maxWidth: '95vw' },
      modal: false,
      closable: true,
      dismissableMask: false,
      closeOnEscape: false,
      keepInViewport: false,
      onDragend: createDragEndHandler()
    } as any,
    data: {
      roleId,
      roleName,
      initialTab: 'skills',
      selectedSkillId: skillId
    }
  });
};

const openAgent = (agent: SkillOverviewResponse['agents'][number]) => {
  openAgentPropertiesWindow(dialog, {
    agentId: agent.agentId,
    agentName: agent.agentName,
    roleName: agent.roleName,
    roleId: agent.roleId,
    initialTab: 'skills',
    selectedSkillId: skillId
  });
};

watch(() => skillId, () => {
  void load();
}, { immediate: true });
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div v-if="loading" class="flex flex-1 items-center justify-center">
      <Loader2 class="h-5 w-5 animate-spin text-[var(--primary)]" />
    </div>

    <div v-else-if="!overview" class="flex flex-1 items-center justify-center text-sm text-[var(--text-3)]">
      加载失败
    </div>

    <div v-else class="min-h-0 flex-1 overflow-y-auto p-4">
      <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
        <div class="flex flex-wrap items-center gap-2">
          <div class="text-base font-medium text-[var(--text-1)]">{{ overview.skill.displayName }}</div>
          <span class="rounded-full px-2 py-0.5 text-xs" :class="overview.skill.installed ? 'bg-green-500/10 text-green-600' : 'bg-[var(--surface-3)] text-[var(--text-3)]'">
            {{ overview.skill.installed ? '已安装' : '未安装' }}
          </span>
        </div>
        <div class="mt-2 text-sm text-[var(--text-2)]">{{ overview.skill.description || '暂无描述' }}</div>
        <div class="mt-2 space-y-1 text-xs text-[var(--text-3)]">
          <div>skillId：{{ overview.skill.skillId }}</div>
          <div>岗位关联：{{ overview.counts.roles }} 个</div>
          <div>智能体关联：{{ overview.counts.agents }} 个</div>
        </div>
      </div>

      <div class="mt-4 grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="min-h-0 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
          <div class="mb-3 text-sm font-medium text-[var(--text-1)]">岗位关联</div>
          <div class="min-h-0 space-y-3 overflow-y-auto">
            <div v-if="overview.roles.length === 0" class="text-sm text-[var(--text-3)]">暂无岗位配置</div>
            <div v-for="role in overview.roles" :key="role.roleId" class="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3">
              <div class="flex flex-col gap-2">
                <div class="flex items-center justify-between gap-2">
                  <div class="truncate text-sm font-medium text-[var(--text-1)]">{{ role.roleName }}</div>
                  <Button size="small" variant="outlined" @click="openRole(role.roleId, role.roleName)">打开设置</Button>
                </div>
                <div class="truncate text-xs text-[var(--text-3)]">{{ role.roleId }}</div>
              </div>
              <div class="mt-2 text-xs text-[var(--text-2)]">
                {{ role.visible ? '已安装且可见' : (role.missingReason ? `已配置但${role.missingReason}` : '未进入运行时') }}
              </div>
            </div>
          </div>
        </div>

        <div class="min-h-0 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
          <div class="mb-3 text-sm font-medium text-[var(--text-1)]">智能体关联</div>
          <div class="min-h-0 space-y-3 overflow-y-auto">
            <div v-if="overview.agents.length === 0" class="text-sm text-[var(--text-3)]">暂无智能体配置</div>
            <div v-for="agent in overview.agents" :key="agent.agentId" class="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3">
              <div class="flex flex-col gap-2">
                <div class="flex items-center justify-between gap-2">
                  <div class="truncate text-sm font-medium text-[var(--text-1)]">{{ agent.agentName }}</div>
                  <Button size="small" variant="outlined" @click="openAgent(agent)">打开设置</Button>
                </div>
                <div class="truncate text-xs text-[var(--text-3)]">{{ agent.roleName }} · {{ agent.agentId }}</div>
              </div>
              <div class="mt-2 text-xs text-[var(--text-2)]">
                {{ agent.visible ? '已安装且可见' : (agent.missingReason ? `已配置但${agent.missingReason}` : `来源：${agent.source}`) }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
