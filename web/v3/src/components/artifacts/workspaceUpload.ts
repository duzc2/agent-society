/**
 * 工作区上传参数。
 * 上传与新建文件都复用同一个接口，统一在此处收口请求格式。
 */
export interface UploadWorkspaceFileParams {
  file: File;
  workspaceId: string;
  relativePath: string;
  operator?: string;
}

/**
 * 调用工作区上传接口写入文件。
 * 服务端当前通过 multipart/form-data 接收文件，因此这里统一封装 FormData 细节。
 *
 * @param params 上传参数
 * @returns 服务端返回的上传结果
 */
export async function uploadWorkspaceFile(params: UploadWorkspaceFileParams): Promise<any> {
  const formData = new FormData();
  formData.append('file', params.file);
  formData.append('workspaceId', params.workspaceId);
  formData.append('path', params.relativePath);
  formData.append('filename', params.file.name);

  if (params.operator) {
    formData.append('operator', params.operator);
  }

  const response = await fetch('/api/upload', {
    method: 'POST',
    body: formData
  });

  const result = await response.json().catch(() => ({
    error: 'upload_failed',
    message: '服务端返回了无法解析的响应'
  }));

  if (!response.ok) {
    const errorMessage = typeof result?.message === 'string' && result.message
      ? result.message
      : '上传失败';
    throw new Error(errorMessage);
  }

  return result;
}
