<template>
  <div class="flex h-full min-h-0 flex-col bg-[var(--surface-1)] text-[var(--text-1)]">
    <!-- 顶部操作栏：导入 + 刷新 -->
    <div class="border-b border-[var(--border)] px-4 py-3">
      <div class="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div class="flex flex-wrap items-center gap-2">
          <Button size="small" @click="importDialogVisible = true">Git 导入</Button>
          <Button size="small" variant="text" :loading="loading" @click="loadAll">刷新</Button>
        </div>
      </div>
    </div>

    <!-- 错误提示 -->
    <div v-if="error" class="px-4 pt-4">
      <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{{ error }}</div>
    </div>

    <!-- 左右分栏布局 -->
    <div class="flex min-h-0 flex-1 flex-col xl:flex-row">
      <!-- 左侧：技能列表 -->
      <div class="flex min-h-0 w-full flex-col border-b border-[var(--border)] xl:w-[420px] xl:border-r xl:border-b-0">
        <div class="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <InputText v-model="searchText" placeholder="搜索名称或 git 地址" class="w-full" />
          <Select v-model="statusFilter" :options="statusOptions" optionLabel="label" optionValue="value" class="w-[120px]" />
        </div>

        <div v-if="loading && filteredSkills.length === 0" class="flex flex-1 items-center justify-center">
          <Loader2 class="h-5 w-5 animate-spin text-[var(--primary)]" />
        </div>

        <div v-else class="min-h-0 flex-1 overflow-y-auto p-3">
          <div v-if="filteredSkills.length === 0" class="flex h-full items-center justify-center text-sm text-[var(--text-3)]">
            暂无 Git 导入技能
          </div>

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
                <div class="mt-1 truncate text-xs text-[var(--text-3)]">{{ skill.gitUrl }}</div>
              </div>
              <span class="shrink-0 rounded-full px-2 py-0.5 text-xs" :class="statusClass(skill.status)">{{ statusLabel(skill.status) }}</span>
            </div>
            <div class="mt-2 flex flex-wrap gap-2 text-xs text-[var(--text-3)]">
              <span>分支：{{ skill.branch || '默认' }}</span>
              <span>提交：{{ skill.commitId ? skill.commitId.slice(0, 8) : '未知' }}</span>
            </div>
          </button>
        </div>
      </div>

      <!-- 右侧：技能详情 -->
      <div class="flex min-h-0 flex-1 flex-col">
        <div v-if="!selectedSkill" class="flex flex-1 items-center justify-center text-sm text-[var(--text-3)]">
          请选择一个 Git 导入技能
        </div>

        <div v-else class="flex min-h-0 flex-1 flex-col">
          <div class="border-b border-[var(--border)] px-4 py-4">
            <div class="flex flex-col gap-2">
              <div class="flex flex-wrap items-center gap-2">
                <div class="text-base font-medium text-[var(--text-1)]">{{ selectedSkill.displayName }}</div>
                <span class="rounded-full px-2 py-0.5 text-xs" :class="statusClass(selectedSkill.status)">{{ statusLabel(selectedSkill.status) }}</span>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <Button size="small" :loading="updatingSkillId === selectedSkill.skillId" @click="handleUpdate(selectedSkill)">
                  <RefreshCw class="h-4 w-4 mr-1" />拉取更新
                </Button>
                <Button size="small" variant="outlined" @click="toggleStatus(selectedSkill)">{{ selectedSkill.status === 'enabled' ? '停用' : '启用' }}</Button>
                <Button size="small" variant="outlined" severity="danger" @click="confirmDelete(selectedSkill)">删除</Button>
              </div>
              <div class="text-sm text-[var(--text-2)]">
                {{ selectedSkill.description || '暂无描述' }}
              </div>
              <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-3)]">
                <span>技能 ID：{{ selectedSkill.skillId }}</span>
                <span>来源：{{ selectedSkill.gitUrl }}</span>
                <span>分支：{{ selectedSkill.branch || '默认' }}</span>
                <span>提交：{{ selectedSkill.commitId ? selectedSkill.commitId.slice(0, 8) : '未知' }}</span>
                <span>最近修改：{{ formatTime(selectedSkill.updatedAt) }}</span>
              </div>
            </div>
          </div>
          <!-- SKILL.md 预览 -->
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

    <!-- 导入对话框 -->
    <Dialog
      v-model:visible="importDialogVisible"
      modal
      header="从 Git 导入技能"
      :closable="!importing"
      :closeOnEscape="false"
      :dismissableMask="!importing"
      class="w-[32rem] max-w-[92vw]"
    >
      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-2">
          <label class="text-sm font-medium text-[var(--text-1)]" for="git-url">Git 仓库地址 *</label>
          <InputText
            id="git-url"
            v-model="importForm.gitUrl"
            autocomplete="off"
            placeholder="https://github.com/user/skill-repo.git"
            :disabled="importing"
          />
        </div>
        <div class="flex flex-col gap-2">
          <label class="text-sm font-medium text-[var(--text-1)]" for="git-branch">分支（可选）</label>
          <InputText
            id="git-branch"
            v-model="importForm.branch"
            autocomplete="off"
            placeholder="默认为主分支"
            :disabled="importing"
          />
        </div>
        <div class="flex flex-col gap-2">
          <label class="text-sm font-medium text-[var(--text-1)]" for="git-subdir">子目录（可选）</label>
          <InputText
            id="git-subdir"
            v-model="importForm.subDir"
            autocomplete="off"
            placeholder="如果技能不在仓库根目录，填写子目录路径"
            :disabled="importing"
          />
        </div>
        <div class="flex flex-col gap-2">
          <label class="text-sm font-medium text-[var(--text-1)]" for="git-display-name">显示名称（可选）</label>
          <InputText
            id="git-display-name"
            v-model="importForm.displayName"
            autocomplete="off"
            placeholder="留空将使用仓库名"
            :disabled="importing"
            @keydown.enter.prevent="handleImport"
          />
        </div>
        <div v-if="importError" class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {{ importError }}
        </div>
        <div class="text-xs text-[var(--text-3)]">
          仓库根目录（或指定子目录）下必须包含 SKILL.md 文件。
        </div>
      </div>

      <template #footer>
        <div class="flex items-center justify-end gap-2">
          <Button
            label="取消"
            severity="secondary"
            text
            :disabled="importing"
            @click="importDialogVisible = false"
          />
          <Button
            label="导入"
            :loading="importing"
            :disabled="!importForm.gitUrl.trim()"
            @click="handleImport"
          />
        </div>
      </template>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import Dialog from 'primevue/dialog';
import { Loader2, RefreshCw } from 'lucide-vue-next';
import { useToast } from 'primevue/usetoast';
import { useConfirm } from 'primevue/useconfirm';
import { gitSkillApi, type GitSkillRecord } from '../../../services/gitSkillApi';
import { getMarkdownEngine } from '../../file-viewer/renderers/markdown';

const toast = useToast();
const confirm = useConfirm();
const loading = ref(false);
const error = ref('');
const searchText = ref('');
const statusFilter = ref<'all' | 'enabled' | 'disabled'>('all');
const skills = ref<GitSkillRecord[]>([]);
const selectedSkillId = ref('');
const updatingSkillId = ref('');
const skillMdContent = ref('');
const skillMdLoading = ref(false);

// 导入对话框状态
const importDialogVisible = ref(false);
const importing = ref(false);
const importError = ref('');
const importForm = ref({
  gitUrl: '',
  branch: '',
  subDir: '',
  displayName: ''
});

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
    return skill.displayName.toLowerCase().includes(keyword)
      || skill.skillId.toLowerCase().includes(keyword)
      || skill.gitUrl.toLowerCase().includes(keyword);
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
    const gitSkills = await gitSkillApi.listGitSkills();
    skills.value = gitSkills;
    if (!selectedSkillId.value || !gitSkills.some((item) => item.skillId === selectedSkillId.value)) {
      selectedSkillId.value = gitSkills[0]?.skillId || '';
    }
  } catch (loadError: any) {
    error.value = loadError?.message || '加载 Git 技能失败';
  } finally {
    loading.value = false;
  }
};

/**
 * 执行导入。
 */
const handleImport = async () => {
  const gitUrl = importForm.value.gitUrl.trim();
  if (!gitUrl) {
    return;
  }

  importing.value = true;
  importError.value = '';
  try {
    await gitSkillApi.importFromGit({
      gitUrl,
      branch: importForm.value.branch.trim() || undefined,
      subDir: importForm.value.subDir.trim() || undefined,
      displayName: importForm.value.displayName.trim() || undefined
    });
    toast.add({ severity: 'success', summary: '导入成功', detail: '已从 Git 仓库导入技能', life: 2500 });
    importDialogVisible.value = false;
    resetImportForm();
    await loadAll();
  } catch (importErr: any) {
    importError.value = importErr?.message || '导入失败';
  } finally {
    importing.value = false;
  }
};

/**
 * 重置导入表单。
 */
const resetImportForm = () => {
  importForm.value = { gitUrl: '', branch: '', subDir: '', displayName: '' };
  importError.value = '';
};

/**
 * 拉取更新。
 */
const handleUpdate = async (skill: GitSkillRecord) => {
  if (updatingSkillId.value) {
    return;
  }
  updatingSkillId.value = skill.skillId;
  try {
    await gitSkillApi.updateGitSkill(skill.skillId);
    toast.add({ severity: 'success', summary: '更新成功', detail: `${skill.displayName} 已更新到最新版本`, life: 2500 });
    await loadAll();
  } catch (updateError: any) {
    toast.add({ severity: 'error', summary: '更新失败', detail: updateError?.message || '更新失败', life: 4000 });
  } finally {
    updatingSkillId.value = '';
  }
};

/**
 * 切换技能启停状态。
 */
const toggleStatus = async (skill: GitSkillRecord) => {
  const nextStatus = skill.status === 'enabled' ? 'disabled' : 'enabled';
  try {
    await gitSkillApi.setGitSkillStatus(skill.skillId, nextStatus);
    await loadAll();
  } catch (statusError: any) {
    toast.add({ severity: 'error', summary: '更新失败', detail: statusError?.message || '更新状态失败', life: 4000 });
  }
};

/**
 * 确认删除技能。
 */
const confirmDelete = (skill: GitSkillRecord) => {
  confirm.require({
    message: `确认删除 Git 导入技能"${skill.displayName}"？本地文件将被删除。`,
    header: '删除 Git 技能',
    icon: 'pi pi-exclamation-triangle',
    rejectProps: { label: '取消', severity: 'secondary', outlined: true },
    acceptProps: { label: '删除', severity: 'danger' },
    accept: async () => {
      try {
        await gitSkillApi.deleteGitSkill(skill.skillId);
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

/**
 * 加载选中技能的 SKILL.md 内容。
 */
const markdownEngine = getMarkdownEngine();

const loadSkillMd = async (skillId: string) => {
  skillMdLoading.value = true;
  skillMdContent.value = '';
  try {
    const file = await gitSkillApi.readGitSkillFile(skillId, 'SKILL.md');
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

onMounted(() => {
  void loadAll();
});

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

/**
 * 导入对话框打开时重置表单。
 */
watch(importDialogVisible, (visible) => {
  if (visible) {
    resetImportForm();
  }
});
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

.markdown-body :deep(strong) {
  font-weight: bold;
}
</style>
