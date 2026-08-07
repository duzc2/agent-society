<template>
  <div class="flex h-full min-h-0 flex-col bg-[var(--surface-1)] text-[var(--text-1)]">
    <div class="border-b border-[var(--border)] px-4 py-3">
      <div class="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div class="flex flex-wrap items-center gap-2">
          <Button size="small" @click="createSkillDialogVisible = true">空白创建</Button>
          <Button size="small" variant="text" :loading="loading" @click="loadAll">刷新</Button>
        </div>
      </div>
    </div>

    <div v-if="error" class="px-4 pt-4">
      <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{{ error }}</div>
    </div>

    <div class="flex min-h-0 flex-1 flex-col xl:flex-row">
      <div class="flex min-h-0 w-full flex-col border-b border-[var(--border)] xl:w-[420px] xl:border-r xl:border-b-0">
        <div class="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <InputText v-model="searchText" placeholder="搜索名称或 skillId" class="w-full" />
          <Select v-model="statusFilter" :options="statusOptions" optionLabel="label" optionValue="value" class="w-[120px]" />
        </div>

        <div v-if="loading && filteredSkills.length === 0" class="flex flex-1 items-center justify-center">
          <Loader2 class="h-5 w-5 animate-spin text-[var(--primary)]" />
        </div>

        <div v-else class="min-h-0 flex-1 overflow-y-auto p-3">
          <div v-if="filteredSkills.length === 0" class="flex h-full items-center justify-center text-sm text-[var(--text-3)]">暂无自定义技能</div>

          <button
            v-for="skill in filteredSkills"
            :key="skill.skillId"
            type="button"
            class="mb-2 flex w-full flex-col rounded-lg border p-3 text-left transition-colors"
            :class="selectedSkillId === skill.skillId ? 'border-[var(--primary)] bg-[var(--primary)]/5' : 'border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--text-3)]'"
            @click="selectedSkillId = skill.skillId"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium text-[var(--text-1)]">{{ skill.displayName }}</div>
                <div class="mt-1 truncate text-xs text-[var(--text-3)]">{{ skill.skillId }}</div>
              </div>
              <span class="rounded-full px-2 py-0.5 text-xs" :class="statusClass(skill.status)">{{ statusLabel(skill.status) }}</span>
            </div>
            <div class="mt-2 text-xs text-[var(--text-3)]">最近修改：{{ formatTime(skill.updatedAt) }}</div>
          </button>
        </div>
      </div>

      <div class="flex min-h-0 flex-1 flex-col">
        <div v-if="!selectedSkill" class="flex flex-1 items-center justify-center text-sm text-[var(--text-3)]">请选择一个自定义技能</div>

        <div v-else class="flex min-h-0 flex-1 flex-col">
          <div class="border-b border-[var(--border)] px-4 py-4">
            <div class="flex flex-col gap-2">
              <div class="flex flex-wrap items-center gap-2">
                <div class="text-base font-medium text-[var(--text-1)]">{{ selectedSkill.displayName }}</div>
                <span class="rounded-full px-2 py-0.5 text-xs" :class="statusClass(selectedSkill.status)">{{ statusLabel(selectedSkill.status) }}</span>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <Button size="small" @click="openEditor(selectedSkill.skillId, 'skill_manager_tab')">编辑</Button>
                <Button size="small" variant="outlined" @click="openOverviewDialog(selectedSkill.skillId)">查看配置</Button>
                <Button size="small" variant="outlined" @click="toggleStatus(selectedSkill)">{{ selectedSkill.status === 'enabled' ? '停用' : '启用' }}</Button>
                <Button size="small" variant="outlined" @click="openCopyDialog(selectedSkill)">
                  <Copy class="h-4 w-4 mr-1" />复制
                </Button>
                <Button size="small" variant="outlined" severity="danger" @click="confirmDelete(selectedSkill)">删除</Button>
              </div>
              <div class="text-sm text-[var(--text-2)]">
                {{ selectedSkill.description || '暂无描述' }}
              </div>
              <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-3)]">
                <span>技能 ID：{{ selectedSkill.skillId }}</span>
                <span>最近修改：{{ formatTime(selectedSkill.updatedAt) }}</span>
              </div>
            </div>
          </div>
          <div v-if="skillMdLoading" class="flex items-center justify-center py-8">
            <Loader2 class="h-5 w-5 animate-spin text-[var(--primary)]" />
          </div>
          <div v-else-if="skillMdContent" class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
              <div class="markdown-body" v-html="skillMdContent"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <CreateSkillDialog
      v-model:visible="createSkillDialogVisible"
      :creating="creatingSkill"
      @confirm="handleCreateSkill"
    />

    <CopySkillDialog
      v-model:visible="copyDialogVisible"
      :source-skill-name="copySourceSkillName"
      @confirm="handleCopyConfirm"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import { Loader2, Copy } from 'lucide-vue-next';
import { useToast } from 'primevue/usetoast';
import { useConfirm } from 'primevue/useconfirm';
import { useDialog } from 'primevue/usedialog';
import { customSkillApi, type CustomSkillRecord } from '../../../services/customSkillApi';
import { openCustomSkillEditorWindow } from './customSkillWindow';
import { openSkillOverviewDialog } from '../skillOverviewWindow';
import CreateSkillDialog from './CreateSkillDialog.vue';
import CopySkillDialog from '../CopySkillDialog.vue';
import { getMarkdownEngine } from '../../file-viewer/renderers/markdown';

const props = defineProps<{
  newlyCopiedSkillId?: string;
}>();

const emit = defineEmits<{
  (e: 'skill-selected'): void;
}>();

const toast = useToast();
const confirm = useConfirm();
const dialog = useDialog();
const loading = ref(false);
const error = ref('');
const searchText = ref('');
const statusFilter = ref<'all' | 'enabled' | 'disabled'>('all');
const skills = ref<CustomSkillRecord[]>([]);
const selectedSkillId = ref('');
const copyingSkillId = ref('');
const copyDialogVisible = ref(false);
const copySourceSkillName = ref('');
const createSkillDialogVisible = ref(false);
const creatingSkill = ref(false);
const skillMdContent = ref('');
const skillMdLoading = ref(false);

const statusOptions = [
  { label: '全部', value: 'all' },
  { label: '启用', value: 'enabled' },
  { label: '停用', value: 'disabled' }
];

const filteredSkills = computed(() => {
  const keyword = searchText.value.trim().toLowerCase();
  return skills.value.filter((skill) => {
    if (statusFilter.value !== 'all' && skill.status !== statusFilter.value) {
      return false;
    }
    if (!keyword) {
      return true;
    }
    return skill.displayName.toLowerCase().includes(keyword) || skill.skillId.toLowerCase().includes(keyword);
  });
});

const selectedSkill = computed(() => skills.value.find((item) => item.skillId === selectedSkillId.value) || null);

/**
 * 加载列表。
 */
const loadAll = async () => {
  loading.value = true;
  error.value = '';
  try {
    const customSkills = await customSkillApi.listCustomSkills();
    skills.value = customSkills;
    // 如果有刚复制的新技能，先选中它
    if (props.newlyCopiedSkillId && customSkills.some((item) => item.skillId === props.newlyCopiedSkillId)) {
      selectedSkillId.value = props.newlyCopiedSkillId;
      emit('skill-selected');
    } else if (!selectedSkillId.value || !customSkills.some((item) => item.skillId === selectedSkillId.value)) {
      // 如果新技能还没准备好，先选中列表第一个，同时设置重试定时器
      selectedSkillId.value = customSkills[0]?.skillId || '';
      if (props.newlyCopiedSkillId) {
        setTimeout(() => {
          void retrySelectNewlyCopied();
        }, 1000);
      }
    }
  } catch (loadError: any) {
    error.value = loadError?.message || '加载自定义技能失败';
  } finally {
    loading.value = false;
  }
};

/**
 * 重试选中刚复制的新技能。
 */
const retrySelectNewlyCopied = async () => {
  if (!props.newlyCopiedSkillId) return;
  const skillExists = skills.value.some((item) => item.skillId === props.newlyCopiedSkillId);
  if (skillExists) {
    selectedSkillId.value = props.newlyCopiedSkillId;
    emit('skill-selected');
  } else {
    // 再等一秒后重试
    setTimeout(() => {
      void retrySelectNewlyCopied();
    }, 1000);
  }
};

/**
 * 创建空白技能并打开编辑窗口。
 */
const handleCreateSkill = async ({ displayName }: { displayName: string }) => {
  creatingSkill.value = true;
  try {
    const result = await customSkillApi.createCustomSkill(displayName || undefined);
    toast.add({ severity: 'success', summary: '创建成功', detail: '已创建空白自定义技能', life: 2500 });
    await loadAll();
    openEditor(result.skill.skillId, 'skill_manager_tab');
  } catch (createError: any) {
    toast.add({ severity: 'error', summary: '创建失败', detail: createError?.message || '创建失败', life: 4000 });
  } finally {
    creatingSkill.value = false;
  }
};

/**
 * 复制指定技能为自定义技能并打开编辑器。
 */
const copySelectedSkill = async (skill: CustomSkillRecord, displayName?: string) => {
  if (copyingSkillId.value) {
    return;
  }
  copyingSkillId.value = skill.skillId;
  try {
    const result = await customSkillApi.copySkillAsCustom(skill.skillId, displayName || undefined);
    toast.add({ severity: 'success', summary: '复制成功', detail: '已创建新的自定义技能', life: 2500 });
    await loadAll();
    openEditor(result.skill.skillId, 'skill_manager_tab');
  } catch (copyError: any) {
    toast.add({ severity: 'error', summary: '复制失败', detail: copyError?.message || '复制失败', life: 4000 });
  } finally {
    copyingSkillId.value = '';
  }
};

/**
 * 打开复制对话框。
 */
const openCopyDialog = (skill: CustomSkillRecord) => {
  copySourceSkillName.value = skill.displayName;
  copyDialogVisible.value = true;
};

/**
 * 打开查看配置对话框。
 */
const openOverviewDialog = (skillId: string) => {
  openSkillOverviewDialog(dialog, skillId);
};

/**
 * 处理复制对话框确认。
 */
const handleCopyConfirm = ({ displayName }: { displayName: string }) => {
  const skill = selectedSkill.value;
  if (!skill) return;
  void copySelectedSkill(skill, displayName || undefined);
};

/**
 * 打开编辑窗口。
 */
const openEditor = (skillId: string, sourceContext: string) => {
  openCustomSkillEditorWindow(dialog, { skillId, sourceContext });
};

/**
 * 切换技能启停状态。
 */
const toggleStatus = async (skill: CustomSkillRecord) => {
  const nextStatus = skill.status === 'enabled' ? 'disabled' : 'enabled';
  try {
    await customSkillApi.setCustomSkillStatus(skill.skillId, nextStatus);
    await loadAll();
  } catch (statusError: any) {
    toast.add({ severity: 'error', summary: '更新失败', detail: statusError?.message || '更新状态失败', life: 4000 });
  }
};

/**
 * 确认删除技能。
 */
const confirmDelete = (skill: CustomSkillRecord) => {
  confirm.require({
    message: `确认删除自定义技能"${skill.displayName}"？`,
    header: '删除自定义技能',
    icon: 'pi pi-exclamation-triangle',
    rejectProps: { label: '取消', severity: 'secondary', outlined: true },
    acceptProps: { label: '删除', severity: 'danger' },
    accept: async () => {
      try {
        await customSkillApi.deleteCustomSkill(skill.skillId);
        await loadAll();
      } catch (deleteError: any) {
        toast.add({ severity: 'error', summary: '删除失败', detail: deleteError?.message || '删除失败', life: 4000 });
      }
    }
  });
};

/**
 * 返回状态文本。
 */
const statusLabel = (status: string) => status === 'enabled' ? '启用' : '停用';

/**
 * 返回状态样式。
 */
const statusClass = (status: string) => status === 'enabled' ? 'bg-green-500/10 text-green-600' : 'bg-[var(--surface-3)] text-[var(--text-3)]';

/**
 * 格式化时间。
 */
const formatTime = (value: string) => value ? new Date(value).toLocaleString('zh-CN') : '未知';

onMounted(() => {
  void loadAll();
});

watch(() => props.newlyCopiedSkillId, (newVal) => {
  if (newVal) {
    void loadAll();
  }
});

/**
 * 加载选中技能的 SKILL.md 内容。
 */
const markdownEngine = getMarkdownEngine();

const loadSkillMd = async (skillId: string) => {
  skillMdLoading.value = true;
  skillMdContent.value = '';
  try {
    const file = await customSkillApi.readCustomSkillFile(skillId, 'SKILL.md');
    const content = file.content || '';
    if (content) {
      const result = markdownEngine.render(content, { filePath: `/${skillId}/SKILL.md` });
      skillMdContent.value = result.html;
    }
  } catch {
    // 读取失败时不显示内容
  } finally {
    skillMdLoading.value = false;
  }
};

/**
 * 监听选中技能变化，加载 SKILL.md 内容。
 */
watch(selectedSkillId, (newSkillId) => {
  if (newSkillId) {
    void loadSkillMd(newSkillId);
  } else {
    skillMdContent.value = '';
  }
}, { immediate: true });
</script>

<style scoped>
.markdown-body {
  color: var(--text-1);
  line-height: 1.6;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4),
.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  color: var(--text-1);
  font-weight: bold;
  margin-top: 1.2em;
  margin-bottom: 0.5em;
}

.markdown-body :deep(h1) {
  font-size: 1.5em;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.3em;
}

.markdown-body :deep(h2) {
  font-size: 1.25em;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.2em;
}

.markdown-body :deep(h3) {
  font-size: 1.1em;
}

.markdown-body :deep(p) {
  margin-bottom: 0.8em;
}

.markdown-body :deep(code) {
  background: var(--surface-1);
  padding: 0.15em 0.4em;
  border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.9em;
  color: var(--text-1);
}

.markdown-body :deep(pre) {
  background: var(--surface-1);
  padding: 1em;
  border-radius: 6px;
  overflow-x: auto;
  margin-bottom: 1em;
}

.markdown-body :deep(pre code) {
  background: none;
  padding: 0;
  font-size: 0.85em;
}

.markdown-body :deep(blockquote) {
  border-left: 3px solid var(--primary);
  padding-left: 1em;
  margin-left: 0;
  margin-bottom: 0.8em;
  color: var(--text-2);
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin-bottom: 0.8em;
  padding-left: 1.5em;
}

.markdown-body :deep(li) {
  margin-bottom: 0.25em;
}

.markdown-body :deep(a) {
  color: var(--primary);
  text-decoration: none;
}

.markdown-body :deep(a:hover) {
  text-decoration: underline;
}

.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 1em 0;
}

.markdown-body :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
}

.markdown-body :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 0.8em;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  padding: 0.5em 1em;
  border: 1px solid var(--border);
}

.markdown-body :deep(th) {
  background: var(--surface-1);
  font-weight: bold;
}

.markdown-body :deep(tr:nth-child(even)) {
  background: var(--surface-1);
}

.markdown-body :deep(strong) {
  font-weight: bold;
}

.markdown-body :deep(em) {
  font-style: italic;
}
</style>