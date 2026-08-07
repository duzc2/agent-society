<script setup lang="ts">
import { FileCode, Folder, Info, Loader2, Upload, ArrowUpDown, ArrowUp, ArrowDown, Plus, FolderPlus, Trash2, FolderOpen, Search, X, RefreshCw } from 'lucide-vue-next';
import Button from 'primevue/button';
import Splitter from 'primevue/splitter';
import SplitterPanel from 'primevue/splitterpanel';
import Select from 'primevue/select';
import { ref, inject, onMounted, computed, watch } from 'vue';
import { useDialog } from 'primevue/usedialog';
import { useToast } from 'primevue/usetoast';
import ConfirmDialog from '../common/ConfirmDialog.vue';
import FileTreeNode from './FileTreeNode.vue';
import CreateDirectoryDialog from './CreateDirectoryDialog.vue';
import CreateTextFileDialog from './CreateTextFileDialog.vue';
import { openFileViewer } from '../file-viewer';
import { createEmptyTextFile } from './createTextFileUtils';
import { uploadWorkspaceFile } from './workspaceUpload';
import { createWorkspaceDirectory, deleteWorkspaceDirectory, openWorkspaceDirectory, syncWorkspace } from './workspaceDirectory';
import { openFileMetaDialog } from './fileMetaDialog';
import { deleteWorkspaceFile } from './workspaceFile';
import type { TextFileTypeOption } from './createTextFileUtils';

const dialogRef = inject<any>('dialogRef');
const dialog = useDialog();
const toast = useToast();
const orgId = ref<string | undefined>();
const files = ref<any[]>([]);
const directories = ref<any[]>([]);
const loading = ref(false);
const uploading = ref(false);
const creatingFile = ref(false);
const creatingDirectory = ref(false);
const openingDirectory = ref(false);
const syncing = ref(false);
const deletingFilePath = ref('');
const deletingDirectoryPath = ref('');
const deleteConfirmVisible = ref(false);
const pendingDeleteTarget = ref<any>(null);
const createDialogVisible = ref(false);
const createDirectoryDialogVisible = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);
const expandedDirs = ref<Set<string>>(new Set());

// 搜索状态
const searchQuery = ref('');
const searchType = ref<'filename' | 'fulltext'>('filename');
const searchResults = ref<any[]>([]);
const searchLoading = ref(false);
const searchActive = computed(() => searchQuery.value.trim().length > 0);
let searchTimer: ReturnType<typeof setTimeout> | null = null;

const searchTypeOptions = [
  { label: '文件名', value: 'filename' },
  { label: '全文搜索', value: 'fulltext' }
];

// 排序状态
// sortField: 当前排序字段，可选值 'name' | 'size' | 'modifiedAt'
// sortOrder: 当前排序方向，可选值 'asc' 升序 | 'desc' 降序
const STORAGE_KEY = 'artifacts-sort-settings';

// 从 sessionStorage 读取排序设置
const loadSortSettings = () => {
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) {
      const settings = JSON.parse(saved);
      return {
        field: settings.field || 'name',
        order: settings.order || 'asc'
      };
    }
  } catch {
    // 忽略解析错误
  }
  return { field: 'name', order: 'asc' };
};

const initialSettings = loadSortSettings();
const sortField = ref<'name' | 'size' | 'modifiedAt'>(initialSettings.field as any);
const sortOrder = ref<'asc' | 'desc'>(initialSettings.order as any);

// 保存排序设置到 sessionStorage
const saveSortSettings = () => {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      field: sortField.value,
      order: sortOrder.value
    }));
  } catch {
    // 忽略存储错误
  }
};

// 监听排序变化并保存
watch([sortField, sortOrder], saveSortSettings, { immediate: false });

// 树形结构转换
const fileTree = computed(() => {
  const workspaceRoot: any = { 
    name: 'Workspace', 
    type: 'directory', 
    children: [], 
    path: 'root' // 使用 'root' 作为根路径标识
  };

  /**
   * 向树中插入目录节点。
   * 空目录无法从文件路径推导，因此需要先把服务端返回的目录显式灌入树结构。
   */
  const ensureDirectoryNode = (directoryPath: string) => {
    const cleanPath = directoryPath.startsWith('/') ? directoryPath.slice(1) : directoryPath;
    if (!cleanPath) {
      return;
    }

    const parts = cleanPath.split('/');
    let current = workspaceRoot;
    let currentPath = '';

    parts.forEach((part: string) => {
      const partPath = currentPath ? `${currentPath}/${part}` : part;
      const fullPath = `root/${partPath}`;

      let directoryNode = current.children.find((child: any) => child.type === 'directory' && child.name === part);
      if (!directoryNode) {
        directoryNode = { name: part, type: 'directory', children: [], path: fullPath };
        current.children.push(directoryNode);
      }

      current = directoryNode;
      currentPath = partPath;
    });
  };

  directories.value.forEach((directory: any) => {
    ensureDirectoryNode(directory.path);
  });
  
  files.value.forEach((file: any) => {
    // 确保 path 不以 / 开头，方便 split
    const cleanPath = file.path.startsWith('/') ? file.path.slice(1) : file.path;
    const parts = cleanPath.split('/');
    let current = workspaceRoot;
    let currentPath = '';
    
    parts.forEach((part: string, index: number) => {
      // 构建当前部分的路径，相对于 workspaceRoot
      const partPath = currentPath ? `${currentPath}/${part}` : part;
      const fullPath = `root/${partPath}`; // 保持全局唯一路径
      
      if (index === parts.length - 1) {
        // 检查是否已经存在同名文件，防止重复
        if (!current.children.find((c: any) => c.type === 'file' && c.name === part)) {
          current.children.push({ ...file, type: 'file', name: part, path: fullPath });
        }
      } else {
        let dir = current.children.find((c: any) => c.type === 'directory' && c.name === part);
        if (!dir) {
          dir = { name: part, type: 'directory', children: [], path: fullPath };
          current.children.push(dir);
        }
        current = dir;
        currentPath = partPath;
      }
    });
  });

  // 排序：目录在前，文件在后，按名称排序
  const sortNodes = (nodes: any[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((node: any) => {
      if (node.children) sortNodes(node.children);
    });
  };
  
  sortNodes(workspaceRoot.children);
  return [workspaceRoot]; // 返回包含根目录的数组
});

const selectedId = ref('root'); // 默认选中根目录

// 当前选中的目录
const currentDir = ref<any>(null);

/**
 * 工作区总条目数。
 * 左侧目录树是否显示不能只看文件数量，否则纯目录工作区会被错误判定为空。
 */
const workspaceEntryCount = computed(() => files.value.length + directories.value.length);

// 当前目录下的文件列表（过滤掉文件夹，并按当前排序状态排序）
const currentItems = computed(() => {
  let items = [];
  if (currentDir.value) {
    items = currentDir.value.children || [];
  } else {
    // 默认显示根目录下的内容
    items = fileTree.value[0]?.children || [];
  }
  // 仅保留文件类型
  items = items.filter((item: any) => item.type === 'file');
  
  // 应用排序
  items.sort((a: any, b: any) => {
    let comparison = 0;
    switch (sortField.value) {
      case 'name':
        comparison = a.name.localeCompare(b.name);
        break;
      case 'size':
        comparison = (a.size || 0) - (b.size || 0);
        break;
      case 'modifiedAt':
        comparison = new Date(a.modifiedAt || 0).getTime() - new Date(b.modifiedAt || 0).getTime();
        break;
    }
    // 根据排序方向调整结果
    return sortOrder.value === 'asc' ? comparison : -comparison;
  });
  
  return items;
});

/**
 * 当前目录已有的文件和文件夹名称。
 * 新建文件/文件夹时用于前端即时重名提示，避免用户触发额外的重型交互。
 */
const currentEntryNames = computed(() => {
  const items = currentDir.value?.children || fileTree.value[0]?.children || [];
  return items.map((item: any) => String(item.name || '')).filter(Boolean);
});

// 点击表头进行排序
// 如果点击的是当前排序字段，则切换排序方向
// 如果点击的是新的排序字段，则设置为该字段并默认升序
const handleSort = (field: 'name' | 'size' | 'modifiedAt') => {
  if (sortField.value === field) {
    // 切换排序方向
    sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc';
  } else {
    // 切换排序字段，默认升序
    sortField.value = field;
    sortOrder.value = 'asc';
  }
  // 保存设置（watch 会自动处理，但为了确保立即生效可以手动调用）
  saveSortSettings();
};

const toggleDir = (node: any) => {
  const path = node.path;
  if (expandedDirs.value.has(path)) {
    expandedDirs.value.delete(path);
  } else {
    expandedDirs.value.add(path);
  }
};

const selectFile = async (file: any) => {
  if (file.type === 'directory') {
    // 切换选中的目录
    currentDir.value = file;
    selectedId.value = file.path;
    // 自动展开父级目录
    const parts = file.path.split('/');
    let pathAcc = '';
    parts.forEach((part: string) => {
      pathAcc = pathAcc ? `${pathAcc}/${part}` : part;
      expandedDirs.value.add(pathAcc);
    });
    return;
  }
  
  // 点击文件时使用文件查看器打开
  if (orgId.value) {
    const apiPath = file.path.replace(/^root\//, '');
    await openFileViewer({
      dialog,
      workspaceId: orgId.value,
      filePath: apiPath,
      width: '85vw',
      height: '80vh'
    });
  }
  
  // 更新选中状态
  selectedId.value = file.path;
};

/**
 * 在树结构中按路径查找节点。
 * 刷新文件列表后需要恢复当前目录上下文，避免上传或新建后跳回根目录。
 */
const findNodeByPath = (nodes: any[], targetPath: string): any | null => {
  for (const node of nodes) {
    if (node.path === targetPath) {
      return node;
    }

    if (node.children && node.children.length > 0) {
      const matchedNode = findNodeByPath(node.children, targetPath);
      if (matchedNode) {
        return matchedNode;
      }
    }
  }

  return null;
};

/**
 * 展开指定节点的所有父级路径。
 * 目录刷新后重新展开父路径，保证用户仍停留在刚才操作的目录上下文中。
 */
const expandNodeAncestors = (node: any) => {
  const pathParts = String(node?.path || '').split('/');
  let accumulatedPath = '';

  expandedDirs.value.clear();

  pathParts.forEach((pathPart: string) => {
    accumulatedPath = accumulatedPath ? `${accumulatedPath}/${pathPart}` : pathPart;
    expandedDirs.value.add(accumulatedPath);
  });
};

/**
 * 拉取工作区文件列表，并尽量保持当前目录上下文。
 * @param preferredDirPath 刷新后优先恢复的目录路径
 */
const fetchData = async (preferredDirPath: string = currentDir.value?.path || 'root') => {
  if (!orgId.value) return;
  
  loading.value = true;
  try {
    const res = await fetch(`/api/workspaces/${orgId.value}`);
    if (res.ok) {
      const data = await res.json();
      files.value = data.files || [];
      directories.value = data.directories || [];
      const rootNode = fileTree.value[0];
      if (!rootNode) {
        return;
      }

      const preferredNode = findNodeByPath(fileTree.value, preferredDirPath) || rootNode;
      currentDir.value = preferredNode;
      selectedId.value = preferredNode.path;
      expandNodeAncestors(preferredNode);
    }
  } catch (err) {
    console.error('获取工作空间文件失败:', err);
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  if (dialogRef && dialogRef.value) {
    orgId.value = dialogRef.value.data?.orgId;
    fetchData();
  }
});

const formatTime = (ts: string) => {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
};

// 获取当前目录在 workspace 中的相对路径
const getCurrentRelativePath = () => {
  if (!currentDir.value || currentDir.value.path === 'root') {
    return '';
  }
  // 移除开头的 'root/'
  return currentDir.value.path.replace(/^root\//, '');
};

// 触发文件选择
const triggerFileSelect = () => {
  fileInputRef.value?.click();
};

const handleOpenCurrentDirectory = async () => {
  if (!orgId.value || openingDirectory.value) {
    return;
  }

  openingDirectory.value = true;
  const currentPath = getCurrentRelativePath();

  try {
    await openWorkspaceDirectory(orgId.value, currentPath);
  } catch (err: any) {
    console.error('打开文件夹失败:', err);
    toast.add({
      severity: 'error',
      summary: '打开文件夹失败',
      detail: err?.message || '打开文件夹失败',
      life: 3500
    });
  } finally {
    openingDirectory.value = false;
  }
};

const handleSync = async () => {
  if (!orgId.value || syncing.value) {
    return;
  }

  syncing.value = true;
  const currentDirPath = currentDir.value?.path || 'root';
  try {
    await syncWorkspace(orgId.value);
    await fetchData(currentDirPath);
    toast.add({
      severity: 'success',
      summary: '同步完成',
      detail: '工作区文件列表已更新',
      life: 2500
    });
  } catch (err: any) {
    console.error('同步工作区失败:', err);
    toast.add({
      severity: 'error',
      summary: '同步失败',
      detail: err?.message || '同步工作区失败',
      life: 3500
    });
  } finally {
    syncing.value = false;
  }
};

/**
 * 打开新建文件弹窗。
 * 当前组件负责目录上下文，因此由这里统一发起新建操作。
 */
const openCreateFileDialog = () => {
  createDialogVisible.value = true;
};

/**
 * 打开新建文件夹弹窗。
 */
const openCreateDirectoryDialog = () => {
  createDirectoryDialogVisible.value = true;
};

/**
 * 处理新建空文本文件。
 * 复用上传接口，把空字符串写成一个 0 字节文本文件。
 *
 * @param payload 新建文件的表单数据
 */
const handleCreateFile = async (payload: { baseName: string; typeOption: TextFileTypeOption }) => {
  if (!orgId.value) {
    console.error('未找到组织ID');
    toast.add({
      severity: 'error',
      summary: '创建失败',
      detail: '未找到当前组织，无法创建文件',
      life: 3000
    });
    return;
  }

  creatingFile.value = true;
  const currentDirPath = currentDir.value?.path || 'root';
  const currentPath = getCurrentRelativePath();
  const file = createEmptyTextFile(payload.baseName, payload.typeOption);
  const relativePath = currentPath ? `${currentPath}/${file.name}` : file.name;

  try {
    await uploadWorkspaceFile({
      file,
      workspaceId: orgId.value,
      relativePath
    });

    createDialogVisible.value = false;
    await fetchData(currentDirPath);
    toast.add({
      severity: 'success',
      summary: '创建成功',
      detail: `已创建 ${file.name}`,
      life: 2500
    });
  } catch (err: any) {
    console.error('创建文件失败:', err);
    toast.add({
      severity: 'error',
      summary: '创建失败',
      detail: err?.message || '创建文件失败',
      life: 3500
    });
  } finally {
    creatingFile.value = false;
  }
};

/**
 * 获取树路径的父目录路径。
 * 用于删除目录后恢复一个稳定的选中位置，避免界面停留在已删除节点上。
 */
const getParentTreePath = (treePath: string) => {
  if (!treePath || treePath === 'root') {
    return 'root';
  }

  const segments = treePath.split('/');
  if (segments.length <= 2) {
    return 'root';
  }

  return segments.slice(0, -1).join('/');
};

/**
 * 处理新建文件夹。
 * 目录创建由独立接口承载，以便工作区显式记录空目录。
 *
 * @param payload 新建目录表单数据
 */
const handleCreateDirectory = async (payload: { name: string }) => {
  if (!orgId.value) {
    console.error('未找到组织ID');
    toast.add({
      severity: 'error',
      summary: '创建失败',
      detail: '未找到当前组织，无法创建文件夹',
      life: 3000
    });
    return;
  }

  creatingDirectory.value = true;
  const currentDirPath = currentDir.value?.path || 'root';
  const currentPath = getCurrentRelativePath();
  const relativePath = currentPath ? `${currentPath}/${payload.name}` : payload.name;

  try {
    await createWorkspaceDirectory({
      workspaceId: orgId.value,
      relativePath
    });

    createDirectoryDialogVisible.value = false;
    await fetchData(currentDirPath);
    toast.add({
      severity: 'success',
      summary: '创建成功',
      detail: `已创建文件夹 ${payload.name}`,
      life: 2500
    });
  } catch (err: any) {
    console.error('创建文件夹失败:', err);
    toast.add({
      severity: 'error',
      summary: '创建失败',
      detail: err?.message || '创建文件夹失败',
      life: 3500
    });
  } finally {
    creatingDirectory.value = false;
  }
};

/**
 * 删除右侧文件列表中的文件。
 * 删除完成后保持当前目录上下文，仅刷新列表。
 *
 * @param file 文件节点
 */
const handleDeleteFile = async (file: any) => {
  if (!orgId.value || !file?.path || deletingFilePath.value) {
    return;
  }

  const currentDirPath = currentDir.value?.path || 'root';
  const relativePath = String(file.path).replace(/^root\//, '');
  deletingFilePath.value = file.path;

  try {
    await deleteWorkspaceFile(orgId.value, relativePath);
    await fetchData(currentDirPath);
    toast.add({
      severity: 'success',
      summary: '删除成功',
      detail: `已删除 ${file.name}`,
      life: 2500
    });
  } catch (err: any) {
    console.error('删除文件失败:', err);
    toast.add({
      severity: 'error',
      summary: '删除失败',
      detail: err?.message || '删除文件失败',
      life: 3500
    });
  } finally {
    deletingFilePath.value = '';
  }
};

/**
 * 删除左侧目录树中的文件夹。
 * 如果当前选中目录位于被删目录内，则自动回退到其父目录。
 *
 * @param directory 目录节点
 */
const handleDeleteDirectory = async (directory: any) => {
  if (!orgId.value || !directory?.path || directory.path === 'root' || deletingDirectoryPath.value) {
    return;
  }

  const relativePath = String(directory.path).replace(/^root\//, '');
  const currentSelectedPath = currentDir.value?.path || 'root';
  const fallbackDirPath = currentSelectedPath === directory.path || currentSelectedPath.startsWith(`${directory.path}/`)
    ? getParentTreePath(directory.path)
    : currentSelectedPath;

  deletingDirectoryPath.value = directory.path;

  try {
    await deleteWorkspaceDirectory(orgId.value, relativePath);
    await fetchData(fallbackDirPath);
    toast.add({
      severity: 'success',
      summary: '删除成功',
      detail: `已删除文件夹 ${directory.name}`,
      life: 2500
    });
  } catch (err: any) {
    console.error('删除文件夹失败:', err);
    toast.add({
      severity: 'error',
      summary: '删除失败',
      detail: err?.message || '删除文件夹失败',
      life: 3500
    });
  } finally {
    deletingDirectoryPath.value = '';
  }
};

/**
 * 打开删除确认提示。
 * 删除动作在用户确认前不直接执行，避免误触带来不可恢复的影响。
 *
 * @param target 待删除的文件或目录节点
 * @param targetType 目标类型
 */
const requestDelete = (target: any, targetType: 'file' | 'directory') => {
  if (!target) {
    return;
  }

  pendingDeleteTarget.value = {
    ...target,
    targetType
  };
  deleteConfirmVisible.value = true;
};

/**
 * 关闭删除确认提示并清理上下文。
 */
const closeDeleteConfirm = () => {
  if (deletingFilePath.value || deletingDirectoryPath.value) {
    return;
  }

  deleteConfirmVisible.value = false;
  pendingDeleteTarget.value = null;
};

/**
 * 执行已确认的删除动作。
 */
const confirmDelete = async () => {
  const target = pendingDeleteTarget.value;
  if (!target) {
    return;
  }

  if (target.targetType === 'directory') {
    await handleDeleteDirectory(target);
  } else {
    await handleDeleteFile(target);
  }

  if (!deletingFilePath.value && !deletingDirectoryPath.value) {
    closeDeleteConfirm();
  }
};

/**
 * 删除确认文案。
 * 文件夹提示额外强调会同时删除内部内容，但保持文案简洁。
 */
const deleteConfirmMessage = computed(() => {
  const target = pendingDeleteTarget.value;
  if (!target) {
    return '';
  }

  if (target.targetType === 'directory') {
    return `确定要删除文件夹“${target.name}”吗？其中的文件和子文件夹也会被一起删除。`;
  }

  return `确定要删除文件“${target.name}”吗？`;
});

/**
 * 执行工作空间文件搜索。
 * 文件名模式下直接从本地文件列表过滤；全文搜索模式调用后端接口。
 */
const performSearch = async () => {
  const q = searchQuery.value.trim();
  if (!q || !orgId.value) {
    searchResults.value = [];
    return;
  }

  // 文件名搜索：前端本地过滤，归一化为搜索结果格式
  if (searchType.value === 'filename') {
    searchResults.value = files.value
      .filter((f: any) => f.name.toLowerCase().includes(q.toLowerCase()))
      .map((f: any) => ({
        file: f.path,
        name: f.name,
        size: f.size,
        modifiedAt: f.modifiedAt,
        extension: f.extension,
        mimeType: f.mimeType,
        matchType: 'filename',
        contentMatches: null
      }));
    return;
  }

  // 全文搜索：调用后端接口
  searchLoading.value = true;
  try {
    const url = `/api/workspaces/${orgId.value}/search?q=${encodeURIComponent(q)}&type=fulltext&maxResults=200`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      searchResults.value = data.results || [];
    }
  } catch (err) {
    console.error('搜索失败:', err);
    searchResults.value = [];
  } finally {
    searchLoading.value = false;
  }
};

/**
 * 搜索输入防抖处理。
 */
const onSearchInput = () => {
  if (searchTimer) {
    clearTimeout(searchTimer);
  }
  searchTimer = setTimeout(() => {
    performSearch();
  }, 300);
};

/**
 * 清除搜索状态。
 */
const clearSearch = () => {
  searchQuery.value = '';
  searchResults.value = [];
  if (searchTimer) {
    clearTimeout(searchTimer);
  }
};

/**
 * 打开搜索结果中的文件。
 */
const openSearchResult = async (item: any) => {
  if (!orgId.value || !item.file) return;
  await openFileViewer({
    dialog,
    workspaceId: orgId.value,
    filePath: item.file,
    width: '85vw',
    height: '80vh'
  });
};

/**
 * 切换搜索类型时重新触发搜索。
 */
watch(searchType, () => {
  if (searchQuery.value.trim()) {
    performSearch();
  }
});

// 处理文件上传
const handleFileUpload = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const selectedFiles = input.files;
  
  if (!selectedFiles || selectedFiles.length === 0) return;
  if (!orgId.value) {
    console.error('未找到组织ID');
    return;
  }

  uploading.value = true;
  const currentDirPath = currentDir.value?.path || 'root';
  const currentPath = getCurrentRelativePath();

  try {
    for (const file of Array.from(selectedFiles)) {
      const relativePath = currentPath ? `${currentPath}/${file.name}` : file.name;

      try {
        const result = await uploadWorkspaceFile({
          file,
          workspaceId: orgId.value,
          relativePath
        });
        console.log(`上传文件 ${file.name} 成功:`, result);
      } catch (uploadError) {
        console.error(`上传文件 ${file.name} 失败:`, uploadError);
      }
    }

    // 上传完成后刷新文件列表
    await fetchData(currentDirPath);
  } catch (err) {
    console.error('上传文件失败:', err);
  } finally {
    uploading.value = false;
    // 清空 input 值，允许重复选择同一文件
    if (fileInputRef.value) {
      fileInputRef.value.value = '';
    }
  }
};

</script>

<template>
  <div class="flex flex-col h-[600px] bg-transparent overflow-hidden rounded-b-xl text-[var(--text-1)]">
    <Splitter class="flex-grow border-none">
      <!-- 左侧列表 -->
      <SplitterPanel :size="30" :minSize="20" class="flex flex-col border-r border-[var(--border)] bg-[var(--surface-2)] relative">
        <div class="p-3 border-b border-[var(--border)] bg-[var(--surface-1)] shrink-0 space-y-2">
          <div class="flex flex-col">
            <span class="text-xs font-bold text-[var(--text-3)] uppercase tracking-wider">项目工作区 ({{ workspaceEntryCount }})</span>
            <span v-if="orgId" class="text-[10px] text-[var(--text-3)] opacity-70 mt-0.5">组织: {{ orgId }}</span>
          </div>
          <!-- 搜索栏（搜索整个工作区） -->
          <div class="flex flex-col gap-1.5">
            <div class="relative">
              <Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--text-3)] opacity-50" />
              <input
                v-model="searchQuery"
                type="text"
                placeholder="搜索文件..."
                class="w-full pl-7 pr-6 py-1 text-[11px] border border-[var(--border)] rounded-md bg-[var(--bg)] text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)] transition-all"
                @input="onSearchInput"
                @keydown.escape="clearSearch"
              />
              <button
                v-if="searchQuery"
                class="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-[var(--surface-3)] text-[var(--text-3)]"
                @click="clearSearch"
              >
                <X class="w-2.5 h-2.5" />
              </button>
            </div>
            <Select
              v-model="searchType"
              :options="searchTypeOptions"
              optionLabel="label"
              optionValue="value"
              class="w-full"
            />
          </div>
        </div>
        
        <div class="flex-grow relative overflow-hidden">
          <div class="absolute inset-0 overflow-y-auto p-2">
            <div v-if="loading" class="flex flex-col items-center justify-center py-10 text-[var(--text-3)] opacity-50">
              <Loader2 class="w-6 h-6 animate-spin mb-2" />
              <span class="text-xs">加载文件列表中...</span>
            </div>
            <div v-else-if="workspaceEntryCount === 0" class="flex flex-col items-center justify-center py-10 text-[var(--text-3)] opacity-50">
              <Folder class="w-8 h-8 mb-2" />
              <span class="text-xs">暂无文件或文件夹</span>
            </div>
            <div v-else class="space-y-0.5">
              <!-- 递归渲染文件树 -->
              <FileTreeNode 
                v-for="node in fileTree" 
                :key="node.path" 
                :node="node" 
                :depth="0"
                :selected-id="selectedId"
                :expanded-dirs="expandedDirs"
                :deleting-path="deletingDirectoryPath"
                @select="selectFile"
                @toggle="toggleDir"
                @delete="requestDelete($event, 'directory')"
              />
            </div>
          </div>
        </div>
      </SplitterPanel>

      <!-- 右侧预览与列表 -->
      <SplitterPanel :size="70" class="flex flex-col bg-[var(--bg)]">
        <!-- 面包屑导航 -->
        <div class="p-3 border-b border-[var(--border)] bg-[var(--surface-1)] flex items-center justify-between">
          <div class="flex items-center text-xs text-[var(--text-2)] overflow-hidden">
            <Folder class="w-3.5 h-3.5 mr-2 text-[var(--primary)] opacity-70" />
            <span class="font-medium truncate">{{ currentDir ? currentDir.path : '根目录' }}</span>
          </div>
          <div class="flex items-center gap-1">
            <Button
              variant="text"
              size="small"
              class="!p-1.5"
              :disabled="creatingFile || creatingDirectory"
              title="在当前目录新建文件夹"
              @click="openCreateDirectoryDialog"
            >
              <FolderPlus class="w-4 h-4 text-[var(--primary)]" />
            </Button>
            <Button
              variant="text"
              size="small"
              class="!p-1.5"
              :disabled="creatingFile || creatingDirectory"
              title="在当前目录新建文件"
              @click="openCreateFileDialog"
            >
              <Plus class="w-4 h-4 text-[var(--primary)]" />
            </Button>
            <!-- 上传按钮 -->
            <Button
              variant="text"
              size="small"
              class="!p-1.5"
              :loading="openingDirectory"
              :disabled="creatingFile || creatingDirectory"
              title="打开文件夹"
              @click="handleOpenCurrentDirectory"
            >
              <FolderOpen class="w-4 h-4 text-[var(--primary)]" />
            </Button>
            <Button
              variant="text"
              size="small"
              class="!p-1.5"
              :loading="uploading"
              :disabled="creatingFile || creatingDirectory || openingDirectory"
              title="上传文件到当前目录"
              @click="triggerFileSelect"
            >
              <Upload class="w-4 h-4 text-[var(--primary)]" />
            </Button>
            <!-- 手动同步按钮：重新扫描工作区发现外部写入的文件 -->
            <Button
              variant="text"
              size="small"
              class="!p-1.5"
              :loading="syncing"
              :disabled="creatingFile || creatingDirectory || openingDirectory || uploading"
              title="同步工作区文件列表"
              @click="handleSync"
            >
              <RefreshCw class="w-4 h-4 text-[var(--primary)]" />
            </Button>
          </div>
          <!-- 隐藏的文件输入框 -->
          <input
            ref="fileInputRef"
            type="file"
            class="hidden"
            multiple
            @change="handleFileUpload"
          />
        </div>

        <!-- 文件列表 -->
        <div class="flex-grow overflow-hidden relative">
          <div class="absolute inset-0 flex flex-col bg-[var(--bg)]">
            <!-- 搜索进行中提示 -->
            <div v-if="searchActive && searchLoading" class="flex items-center justify-center py-6 text-[var(--text-3)]">
              <Loader2 class="w-4 h-4 animate-spin mr-2" />
              <span class="text-xs">搜索中...</span>
            </div>

            <!-- 搜索结果 -->
            <div v-else-if="searchActive" class="flex-grow overflow-y-auto">
              <div v-if="searchResults.length === 0" class="flex flex-col items-center justify-center py-20 text-[var(--text-3)] opacity-50">
                <Search class="w-12 h-12 mb-3" />
                <p class="text-sm">未找到匹配的文件</p>
                <p class="text-xs mt-1">尝试其他关键词或搜索类型</p>
              </div>
              <table v-else class="w-full text-left border-collapse min-w-[500px]">
                <thead>
                  <tr class="border-b border-[var(--border)] bg-[var(--surface-1)] sticky top-0 z-10 shadow-sm">
                    <th class="py-2.5 px-4 text-[10px] font-bold text-[var(--text-3)] uppercase tracking-wider w-10"></th>
                    <th class="py-2.5 px-2 text-[10px] font-bold text-[var(--text-3)] uppercase tracking-wider">文件路径</th>
                    <th class="py-2.5 px-4 text-[10px] font-bold text-[var(--text-3)] uppercase tracking-wider w-20">匹配类型</th>
                    <th class="py-2.5 px-4 text-[10px] font-bold text-[var(--text-3)] uppercase tracking-wider w-32">匹配位置</th>
                    <th class="py-2.5 px-4 text-[10px] font-bold text-[var(--text-3)] uppercase tracking-wider w-20">大小</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="item in searchResults"
                    :key="item.file"
                    @click="openSearchResult(item)"
                    class="border-b border-[var(--border)] hover:bg-[var(--surface-3)] transition-colors cursor-pointer group"
                  >
                    <td class="py-2.5 px-4">
                      <FileCode class="w-4 h-4 text-[var(--text-3)] opacity-70 group-hover:text-[var(--primary)]" />
                    </td>
                    <td class="py-2.5 px-2 min-w-0">
                      <span class="text-sm font-medium text-[var(--text-1)] truncate block">{{ item.file }}</span>
                    </td>
                    <td class="py-2.5 px-4">
                      <span v-if="item.matchType === 'filename'" class="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400">文件名</span>
                      <span v-else-if="item.matchType === 'content'" class="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400">内容</span>
                      <span v-else class="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400">两者</span>
                    </td>
                    <td class="py-2.5 px-4">
                      <span v-if="item.contentMatches" class="text-xs text-[var(--text-3)]">
                        共 {{ item.contentMatches.length }} 处匹配，首处: L{{ item.contentMatches[0].line }}
                      </span>
                      <span v-else class="text-xs text-[var(--text-3)] opacity-50">-</span>
                    </td>
                    <td class="py-2.5 px-4">
                      <span class="text-xs text-[var(--text-3)]">
                        {{ (item.size / 1024).toFixed(1) + ' KB' }}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- 正常文件列表（非搜索模式） -->
            <div v-else class="flex-grow overflow-y-auto">
              <div v-if="currentItems.length === 0" class="flex flex-col items-center justify-center py-20 text-[var(--text-3)] opacity-50">
                <FileCode class="w-16 h-16 mb-4" />
                <p>该目录下暂无文件</p>
              </div>
              <table v-else class="w-full text-left border-collapse min-w-[500px]">
                <thead>
                  <tr class="border-b border-[var(--border)] bg-[var(--surface-1)] sticky top-0 z-10 shadow-sm">
                    <th class="py-2.5 px-4 text-[10px] font-bold text-[var(--text-3)] uppercase tracking-wider w-10"></th>
                    <th
                      class="py-2.5 px-2 text-[10px] font-bold text-[var(--text-3)] uppercase tracking-wider cursor-pointer select-none hover:bg-[var(--surface-3)] transition-colors group"
                      @click="handleSort('name')"
                    >
                      <div class="flex items-center gap-1">
                        名称
                        <ArrowUpDown v-if="sortField !== 'name'" class="w-3 h-3 opacity-40" />
                        <ArrowUp v-else-if="sortOrder === 'asc'" class="w-3 h-3 text-[var(--primary)]" />
                        <ArrowDown v-else class="w-3 h-3 text-[var(--primary)]" />
                      </div>
                    </th>
                    <th
                      class="py-2.5 px-4 text-[10px] font-bold text-[var(--text-3)] uppercase tracking-wider w-24 cursor-pointer select-none hover:bg-[var(--surface-3)] transition-colors"
                      @click="handleSort('size')"
                    >
                      <div class="flex items-center gap-1">
                        大小
                        <ArrowUpDown v-if="sortField !== 'size'" class="w-3 h-3 opacity-40" />
                        <ArrowUp v-else-if="sortOrder === 'asc'" class="w-3 h-3 text-[var(--primary)]" />
                        <ArrowDown v-else class="w-3 h-3 text-[var(--primary)]" />
                      </div>
                    </th>
                    <th
                      class="py-2.5 px-4 text-[10px] font-bold text-[var(--text-3)] uppercase tracking-wider w-40 cursor-pointer select-none hover:bg-[var(--surface-3)] transition-colors"
                      @click="handleSort('modifiedAt')"
                    >
                      <div class="flex items-center gap-1">
                        修改时间
                        <ArrowUpDown v-if="sortField !== 'modifiedAt'" class="w-3 h-3 opacity-40" />
                        <ArrowUp v-else-if="sortOrder === 'asc'" class="w-3 h-3 text-[var(--primary)]" />
                        <ArrowDown v-else class="w-3 h-3 text-[var(--primary)]" />
                      </div>
                    </th>
                    <th class="py-2.5 px-4 text-[10px] font-bold text-[var(--text-3)] uppercase tracking-wider w-16 text-right">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="item in currentItems"
                    :key="item.path"
                    @click="selectFile(item)"
                    class="border-b border-[var(--border)] hover:bg-[var(--surface-3)] transition-colors cursor-pointer group"
                  >
                    <td class="py-2.5 px-4">
                      <FileCode class="w-4 h-4 text-[var(--text-3)] opacity-70 group-hover:text-[var(--primary)]" />
                    </td>
                    <td class="py-2.5 px-2 min-w-0">
                      <span class="text-sm font-medium text-[var(--text-1)] truncate">{{ item.name }}</span>
                    </td>
                    <td class="py-2.5 px-4">
                      <span class="text-xs text-[var(--text-3)]">
                        {{ (item.size / 1024).toFixed(1) + ' KB' }}
                      </span>
                    </td>
                    <td class="py-2.5 px-4 text-right sm:text-left">
                      <span class="text-xs text-[var(--text-3)] whitespace-nowrap">{{ formatTime(item.modifiedAt) }}</span>
                    </td>
                    <td class="py-2.5 px-4 text-right">
                      <div class="flex items-center justify-end gap-1">
                        <button
                          class="rounded p-1 text-[var(--text-2)] opacity-0 transition-all hover:bg-[var(--surface-3)] hover:text-[var(--primary)] group-hover:opacity-100"
                          title="属性"
                          @click.stop="openFileMetaDialog(dialog, orgId!, item.path.replace(/^root\//, ''), item.name)"
                        >
                          <Info class="h-4 w-4" />
                        </button>
                        <button
                          class="rounded p-1 text-red-400 opacity-0 transition-all hover:bg-[var(--surface-3)] group-hover:opacity-100"
                          :disabled="Boolean(deletingFilePath || deletingDirectoryPath)"
                          @click.stop="requestDelete(item, 'file')"
                        >
                          <Loader2 v-if="deletingFilePath === item.path" class="h-4 w-4 animate-spin text-[var(--text-3)]" />
                          <Trash2 v-else class="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </SplitterPanel>
    </Splitter>
    <CreateDirectoryDialog
      v-model:visible="createDirectoryDialogVisible"
      :creating="creatingDirectory"
      :current-directory-path="currentDir ? currentDir.path : 'root'"
      :existing-names="currentEntryNames"
      @confirm="handleCreateDirectory"
    />
    <ConfirmDialog
      v-model:visible="deleteConfirmVisible"
      title="确认删除"
      :message="deleteConfirmMessage"
      confirm-label="删除"
      cancel-label="取消"
      confirm-severity="danger"
      :loading="Boolean(deletingFilePath || deletingDirectoryPath)"
      @confirm="confirmDelete"
      @cancel="closeDeleteConfirm"
    />
    <CreateTextFileDialog
      v-model:visible="createDialogVisible"
      :creating="creatingFile"
      :current-directory-path="currentDir ? currentDir.path : 'root'"
      :existing-names="currentEntryNames"
      @confirm="handleCreateFile"
    />
  </div>
</template>
