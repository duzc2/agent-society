# artifacts 文件夹说明

此文件夹包含与工件（Artifacts）管理相关的组件。

## 责任与功能
1.  展示工作区内的文件结构（目录树）。
2.  提供文件和目录的浏览、排序功能。
3.  支持文件上传功能。
4.  支持在当前目录新建空文本文件。
5.  支持在当前目录新建文件夹，并显示空目录。
6.  支持删除文件与文件夹，并在删除前给出确认提示。
7.  集成文件查看器，支持查看和编辑纯文本文件。

## 内部结构
- `ArtifactsList.vue`: 核心组件，展示文件列表，处理文件操作逻辑（上传、新建、排序、打开查看器）。
- `CreateDirectoryDialog.vue`: 新建文件夹弹窗，负责文件夹名称输入。
- `CreateTextFileDialog.vue`: 新建文本文件弹窗，负责文件名、类型和后缀选择。
- `FileTreeNode.vue`: 递归组件，用于渲染文件树结构。
- `createTextFileUtils.ts`: 新建文本文件的类型选项、文件名组装与输入校验工具。
- `workspaceDirectory.ts`: 工作区目录创建接口封装。
- `workspaceFile.ts`: 工作区文件删除接口封装。
- `workspaceUpload.ts`: 工作区上传接口封装，供上传与新建文件共用。

## 依赖关系
- `../file-viewer`: 用于打开文件查看器。
- `primevue`: 使用 Splitter, Button, Dialog 等 UI 组件。
- `lucide-vue-next`: 使用图标。
