<template>
  <div class="flex flex-col space-y-4">
    <!-- Loading state -->
    <div v-if="loading" class="flex items-center justify-center py-8">
      <Loader2 class="h-5 w-5 animate-spin text-[var(--primary)]" />
      <span class="ml-2 text-sm text-[var(--text-2)]">加载待办列表中...</span>
    </div>

    <!-- Error state -->
    <div v-else-if="error" class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
      {{ error }}
    </div>

    <!-- Main content -->
    <div v-else>
      <!-- Add form -->
      <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
        <div class="mb-2 text-xs font-medium text-[var(--text-2)]">新增待办事项</div>
        <div class="flex items-center gap-2">
          <InputText
            v-model="newTitle"
            placeholder="输入待办事项标题..."
            class="flex-1 !bg-[var(--surface-1)] !text-sm"
            :disabled="saving"
            @keyup.enter="addTodo"
          />
          <Select
            v-model="newPriority"
            :options="priorityOptions"
            option-label="label"
            option-value="value"
            class="w-24 !bg-[var(--surface-1)]"
            :disabled="saving"
          />
          <Button
            size="small"
            :loading="saving"
            :disabled="!newTitle.trim() || saving"
            @click="addTodo"
          >
            <Plus class="h-4 w-4" />
            添加
          </Button>
        </div>
      </div>

      <!-- Empty state -->
      <div
        v-if="items.length === 0"
        class="mt-4 rounded-lg border border-dashed border-[var(--border)] py-8 text-center text-sm text-[var(--text-3)]"
      >
        暂无待办事项。你可以在上方添加，或让智能体通过对话创建。
      </div>

      <!-- Item list -->
      <div v-else class="mt-3 space-y-2">
        <TransitionGroup name="todo-list">
          <div
            v-for="item in items"
            :key="item.id"
            class="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3 transition-colors"
          >
            <div class="flex items-start gap-2">
              <!-- Grip handle -->
              <GripVertical class="mt-0.5 h-4 w-4 shrink-0 cursor-grab text-[var(--text-3)]" />

              <!-- Main content -->
              <div class="min-w-0 flex-1">
                <div class="flex items-start justify-between gap-2">
                  <!-- Title (inline editable) -->
                  <div class="min-w-0 flex-1">
                    <input
                      v-if="editingId === item.id"
                      :ref="setEditInputRef"
                      v-model="editTitle"
                      class="w-full rounded border border-[var(--primary)] bg-[var(--surface-1)] px-2 py-0.5 text-sm text-[var(--text-1)] outline-none"
                      @keyup.enter="saveEdit(item)"
                      @keyup.escape="cancelEdit"
                      @blur="saveEdit(item)"
                    />
                    <div
                      v-else
                      class="cursor-pointer text-sm font-medium text-[var(--text-1)] hover:text-[var(--primary)]"
                      :class="{ 'line-through text-[var(--text-3)]': item.status === 'completed' || item.status === 'cancelled' }"
                      @click="startEdit(item)"
                    >
                      {{ item.title }}
                    </div>
                  </div>

                  <!-- Action buttons -->
                  <div class="flex shrink-0 items-center gap-1">
                    <Button
                      variant="text"
                      rounded
                      class="!p-1 !text-[var(--text-3)] hover:!bg-[var(--surface-3)]"
                      title="编辑"
                      @click="startEdit(item)"
                    >
                      <Pencil class="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="text"
                      rounded
                      class="!p-1 !text-red-500 hover:!bg-red-50"
                      title="删除"
                      :disabled="saving"
                      @click="confirmDelete(item)"
                    >
                      <Trash2 class="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <!-- Badges and metadata row -->
                <div class="mt-2 flex flex-wrap items-center gap-2">
                  <!-- Priority badge -->
                  <Badge
                    :value="priorityLabel(item.priority)"
                    :class="priorityBadgeClass(item.priority)"
                  />

                  <!-- Status badge -->
                  <Badge
                    :value="statusLabel(item.status)"
                    :class="statusBadgeClass(item.status)"
                  />

                  <!-- Status dropdown (quick change) -->
                  <Select
                    :model-value="item.status"
                    :options="statusOptions"
                    option-label="label"
                    option-value="value"
                    class="!h-6 !w-28"
                    :disabled="saving"
                    @change="(e) => updateItemStatus(item, e.value)"
                  />

                  <!-- Priority dropdown (quick change) -->
                  <Select
                    :model-value="item.priority"
                    :options="priorityOptions"
                    option-label="label"
                    option-value="value"
                    class="!h-6 !w-24"
                    :disabled="saving"
                    @change="(e) => updateItemPriority(item, e.value)"
                  />

                  <!-- Timestamp -->
                  <span class="text-xs text-[var(--text-3)]">
                    更新于 {{ formatTime(item.updatedAt) }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </TransitionGroup>
      </div>

      <!-- Save status -->
      <div v-if="saveError" class="mt-2 text-xs text-red-500">{{ saveError }}</div>
      <div v-if="saveSuccess" class="mt-2 text-xs text-green-600">{{ saveSuccess }}</div>
    </div>

    <!-- Delete confirmation dialog -->
    <Dialog
      v-model:visible="deleteDialogVisible"
      header="确认删除"
      :modal="true"
      :style="{ width: '400px' }"
    >
      <p class="text-sm text-[var(--text-2)]">
        确定要删除待办事项 <strong>"{{ deleteTarget?.title }}"</strong> 吗？此操作不可撤销。
      </p>
      <template #footer>
        <Button label="取消" variant="text" @click="deleteDialogVisible = false" />
        <Button
          label="确认删除"
          severity="danger"
          :loading="saving"
          @click="executeDelete"
        />
      </template>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import Button from 'primevue/button';
import Badge from 'primevue/badge';
import Select from 'primevue/select';
import InputText from 'primevue/inputtext';
import Dialog from 'primevue/dialog';
import { Loader2, Plus, Trash2, Pencil, GripVertical } from 'lucide-vue-next';
import type { TodoItem } from '../../types';
import { apiService } from '../../services/api';

const props = defineProps<{
  agentId: string;
}>();

// State
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const saveError = ref('');
const saveSuccess = ref('');
const items = ref<TodoItem[]>([]);
const newTitle = ref('');
const newPriority = ref<'high' | 'medium' | 'low'>('medium');
const editingId = ref<string | null>(null);
const editTitle = ref('');
const deleteDialogVisible = ref(false);
const deleteTarget = ref<TodoItem | null>(null);

// Edit input ref
const editInputRef = ref<HTMLInputElement | null>(null);
const setEditInputRef = (el: any) => {
  editInputRef.value = el as HTMLInputElement | null;
};

// Options
const priorityOptions = [
  { label: '高', value: 'high' },
  { label: '中', value: 'medium' },
  { label: '低', value: 'low' },
];

const statusOptions = [
  { label: '待处理', value: 'pending' },
  { label: '进行中', value: 'in_progress' },
  { label: '已完成', value: 'completed' },
  { label: '已取消', value: 'cancelled' },
];

// Helpers
const priorityLabel = (p: string) => {
  const map: Record<string, string> = { high: '高优先级', medium: '中优先级', low: '低优先级' };
  return map[p] || p;
};

const priorityBadgeClass = (p: string) => {
  const map: Record<string, string> = {
    high: '!bg-red-100 !text-red-700',
    medium: '!bg-yellow-100 !text-yellow-700',
    low: '!bg-blue-100 !text-blue-700',
  };
  return map[p] || '';
};

const statusLabel = (s: string) => {
  const map: Record<string, string> = {
    pending: '待处理',
    in_progress: '进行中',
    completed: '已完成',
    cancelled: '已取消',
  };
  return map[s] || s;
};

const statusBadgeClass = (s: string) => {
  const map: Record<string, string> = {
    pending: '!bg-gray-100 !text-gray-600',
    in_progress: '!bg-indigo-100 !text-indigo-700',
    completed: '!bg-green-100 !text-green-700',
    cancelled: '!bg-gray-100 !text-gray-400',
  };
  return map[s] || '';
};

const formatTime = (iso: string) => {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
};

// Data loading
const loadTodoList = async () => {
  if (!props.agentId) {
    loading.value = false;
    return;
  }

  loading.value = true;
  error.value = '';

  try {
    const response = await apiService.getAgentTodoList(props.agentId);
    items.value = response.todoList || [];
  } catch (err: any) {
    console.error('加载待办列表失败:', err);
    error.value = err?.message || '加载待办列表失败。';
  } finally {
    loading.value = false;
  }
};

// Auto-save
const saveTodoList = async () => {
  saveError.value = '';
  saveSuccess.value = '';
  saving.value = true;

  try {
    const response = await apiService.updateAgentTodoList(props.agentId, items.value);
    items.value = response.todoList || [];
  } catch (err: any) {
    console.error('保存待办列表失败:', err);
    saveError.value = err?.message || '保存失败。';
  } finally {
    saving.value = false;
  }
};

// Actions
const addTodo = async () => {
  const title = newTitle.value.trim();
  if (!title) return;

  const now = new Date().toISOString();
  const newItem: TodoItem = {
    id: crypto.randomUUID(),
    title,
    priority: newPriority.value,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };

  items.value.push(newItem);
  newTitle.value = '';
  newPriority.value = 'medium';
  saveSuccess.value = '已添加待办事项。';
  await saveTodoList();
};

const startEdit = (item: TodoItem) => {
  editingId.value = item.id;
  editTitle.value = item.title;
  nextTick(() => {
    editInputRef.value?.focus();
    editInputRef.value?.select();
  });
};

const cancelEdit = () => {
  editingId.value = null;
  editTitle.value = '';
};

const saveEdit = (item: TodoItem) => {
  if (editingId.value !== item.id) return;

  const title = editTitle.value.trim();
  if (!title) {
    cancelEdit();
    return;
  }

  if (title !== item.title) {
    item.title = title;
    item.updatedAt = new Date().toISOString();
    saveSuccess.value = '已更新待办事项。';
    saveTodoList();
  }

  cancelEdit();
};

const updateItemStatus = (item: TodoItem, status: string) => {
  if (status === item.status) return;
  item.status = status as TodoItem['status'];
  item.updatedAt = new Date().toISOString();
  saveSuccess.value = '已更新状态。';
  saveTodoList();
};

const updateItemPriority = (item: TodoItem, priority: string) => {
  if (priority === item.priority) return;
  item.priority = priority as TodoItem['priority'];
  item.updatedAt = new Date().toISOString();
  saveSuccess.value = '已更新优先级。';
  saveTodoList();
};

const confirmDelete = (item: TodoItem) => {
  deleteTarget.value = item;
  deleteDialogVisible.value = true;
};

const executeDelete = async () => {
  if (!deleteTarget.value) return;

  const index = items.value.findIndex((i) => i.id === deleteTarget.value!.id);
  if (index !== -1) {
    items.value.splice(index, 1);
  }

  deleteDialogVisible.value = false;
  deleteTarget.value = null;
  saveSuccess.value = '已删除待办事项。';
  await saveTodoList();
};

// Auto-clear success message after 3 seconds
watch(saveSuccess, (val) => {
  if (val) {
    setTimeout(() => {
      saveSuccess.value = '';
    }, 3000);
  }
});

onMounted(() => {
  loadTodoList();
});
</script>

<style scoped>
.todo-list-enter-active,
.todo-list-leave-active {
  transition: all 0.3s ease;
}

.todo-list-enter-from {
  opacity: 0;
  transform: translateY(-10px);
}

.todo-list-leave-to {
  opacity: 0;
  transform: translateX(20px);
}

.todo-list-move {
  transition: transform 0.3s ease;
}
</style>
