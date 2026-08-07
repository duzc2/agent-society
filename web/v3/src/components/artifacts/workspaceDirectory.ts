/**
 * 创建工作区目录参数。
 */
export interface CreateWorkspaceDirectoryParams {
  workspaceId: string;
  relativePath: string;
  operator?: string;
  messageId?: string;
}

/**
 * 调用工作区目录创建接口。
 * 目录创建与文件上传是两类语义，因此单独封装，避免把目录伪装成文件写入。
 *
 * @param params 创建参数
 * @returns 服务端返回的创建结果
 */
export async function createWorkspaceDirectory(params: CreateWorkspaceDirectoryParams): Promise<any> {
  const response = await fetch(`/api/workspaces/${encodeURIComponent(params.workspaceId)}/directory`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      path: params.relativePath,
      operator: params.operator,
      messageId: params.messageId
    })
  });

  const result = await response.json().catch(() => ({
    error: 'create_directory_failed',
    message: '服务端返回了无法解析的响应'
  }));

  if (!response.ok) {
    const errorMessage = typeof result?.message === 'string' && result.message
      ? result.message
      : (typeof result?.error === 'string' && result.error ? result.error : '创建文件夹失败');
    throw new Error(errorMessage);
  }

  return result;
}

/**
 * 删除工作区目录。
 *
 * @param workspaceId 工作区 ID
 * @param relativePath 目录相对路径
 * @returns 服务端返回结果
 */
export async function deleteWorkspaceDirectory(workspaceId: string, relativePath: string): Promise<any> {
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/directory?path=${encodeURIComponent(relativePath)}`,
    {
      method: 'DELETE'
    }
  );

  const result = await response.json().catch(() => ({
    error: 'delete_directory_failed',
    message: '服务端返回了无法解析的响应'
  }));

  if (!response.ok) {
    throw new Error(result?.message || result?.error || '删除文件夹失败');
  }

  return result;
}


/**
 * 调用系统文件管理器打开工作区内容
 *
 * @param workspaceId 工作区ID
 * @param relativePath 工作区内路径
 * @returns 打开结果
 */
/**
 * 手动触发工作区同步（全量扫描磁盘）。
 *
 * @param workspaceId 工作区 ID
 * @returns 服务端返回结果，包含 syncedAt 和 fileCount
 */
export async function syncWorkspace(workspaceId: string): Promise<any> {
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sync`, {
    method: 'POST'
  });

  const result = await response.json().catch(() => ({
    error: 'sync_failed',
    message: '服务端返回了无法解析的响应'
  }));

  if (!response.ok) {
    throw new Error(result?.message || result?.error || '同步失败');
  }

  return result;
}

export async function openWorkspaceDirectory(workspaceId: string, relativePath: string): Promise<any> {
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/open`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      path: relativePath
    })
  });

  const result = await response.json().catch(() => ({
    error: 'open_directory_failed',
    message: '打开文件夹失败'
  }));

  if (!response.ok) {
    throw new Error(result?.message || result?.error || '打开文件夹失败');
  }

  return result;
}
