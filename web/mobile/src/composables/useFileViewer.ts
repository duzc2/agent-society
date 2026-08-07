/**
 * 文件查看器 composable
 * 提取 WorkspaceView / MessageBubble / FilePreviewList 中重复的 openFile 逻辑
 */
import { useAppStore } from '../stores/app';
import { apiService } from '../services/api';

export function useFileViewer() {
  const appStore = useAppStore();

  /**
   * 打开工作区文件
   * @returns null 表示成功，string 表示错误信息
   */
  async function openWorkspaceFile(file: { name: string; path: string; mimeType: string }): Promise<string | null> {
    const workspaceId = appStore.currentOrgId;
    if (!workspaceId) {
      return '缺少工作区ID';
    }

    try {
      const relativePath = file.path.replace(/^root\//, '');
      const { content, mimeType } = await apiService.getWorkspaceFileContent(workspaceId, relativePath);

      if (mimeType.startsWith('image/')) {
        appStore.openFileViewer({
          fileName: file.name,
          mimeType,
          content: '',
          src: content // content 是 URL
        });
      } else if (mimeType === 'text/html') {
        appStore.openFileViewer({
          fileName: file.name,
          mimeType,
          content,
          src: undefined,
          filePath: relativePath
        });
      } else {
        appStore.openFileViewer({
          fileName: file.name,
          mimeType,
          content,
          src: undefined
        });
      }
      return null;
    } catch (e: any) {
      return e?.message || '打开文件失败';
    }
  }

  return { openWorkspaceFile };
}
