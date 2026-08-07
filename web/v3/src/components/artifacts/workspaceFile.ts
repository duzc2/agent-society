/**
 * 删除工作区文件。
 *
 * @param workspaceId 工作区 ID
 * @param relativePath 文件相对路径
 * @returns 服务端返回结果
 */
export async function deleteWorkspaceFile(workspaceId: string, relativePath: string): Promise<any> {
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(relativePath)}`,
    {
      method: 'DELETE'
    }
  );

  const result = await response.json().catch(() => ({
    error: 'delete_file_failed',
    message: '服务端返回了无法解析的响应'
  }));

  if (!response.ok) {
    throw new Error(result?.message || result?.error || '删除文件失败');
  }

  return result;
}
