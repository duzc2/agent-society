# 工作空间服务模块

## 概述

工作空间服务模块负责任务工作空间的文件操作，确保路径安全。

## 模块职责

### workspace_manager.js
- **职责**：工作空间管理器，负责任务工作空间的文件操作
- **主要功能**：
  - 工作空间绑定和分配
  - 懒加载创建工作空间文件夹
  - 文件读写操作
  - 目录列表
  - 路径安全验证（防止路径遍历攻击）
  - 工作空间元信息管理
  - 工作空间统计信息

## 核心概念

### 工作空间绑定
- **bindWorkspace**: 为任务绑定工作空间，立即创建文件夹
- **assignWorkspace**: 为工作空间分配路径，懒加载创建文件夹
- **ensureWorkspaceExists**: 确保工作空间文件夹存在（懒加载创建）

### 路径安全
- 拒绝绝对路径
- 拒绝包含 `..` 的路径
- 验证解析后的路径是否在工作空间内

## 使用示例

### 创建工作空间管理器

```javascript
import { WorkspaceManager } from "./services/workspace/workspace_manager.js";

const manager = new WorkspaceManager({
  logger: myLogger
});
```

### 绑定和管理工作空间

```javascript
// 绑定工作空间（立即创建）
await manager.bindWorkspace(taskId, "/path/to/workspace");

// 分配工作空间（懒加载）
await manager.assignWorkspace(workspaceId, "/path/to/workspace");

// 检查工作空间是否已分配
const hasWorkspace = manager.hasWorkspace(workspaceId);

// 确保工作空间文件夹存在
await manager.ensureWorkspaceExists(workspaceId);

// 获取工作空间路径
const workspacePath = manager.getWorkspacePath(taskId);
```

### 文件操作

```javascript
// 读取文件
const result = await manager.readFile(taskId, "README.md");
if (result.content) {
  console.log(result.content);
} else {
  console.error(result.error);
}

// 写入文件（带元信息）
await manager.writeFile(
  taskId,
  "output.txt",
  "Hello, World!",
  { messageId: "msg-123", agentId: "agent-456" }
);

// 列出目录
const listResult = await manager.listFiles(taskId, ".");
if (listResult.files) {
  for (const file of listResult.files) {
    console.log(`${file.name} (${file.type}, ${file.size} bytes)`);
  }
}

// 获取工作空间统计信息
const info = await manager.getWorkspaceInfo(taskId);
console.log(`文件数: ${info.fileCount}, 总大小: ${info.totalSize} bytes`);
```

## 工作空间元信息

工作空间元信息保存在工作空间目录的上一级，文件名为 `{workspaceId}.meta.json`：

```json
{
  "workspaceId": "workspace-123",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "files": {
    "README.md": {
      "messageId": "msg-123",
      "agentId": "agent-456",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    }
  }
}
```

## 安全特性

### 路径安全
1. **拒绝绝对路径**：只允许相对路径
2. **拒绝路径遍历**：拒绝包含 `..` 的路径
3. **路径验证**：确保解析后的路径在工作空间内

## 注意事项

1. **懒加载**：使用 `assignWorkspace` 时，文件夹不会立即创建，首次写入时才创建
2. **路径规范化**：所有路径都会被规范化，确保安全
3. **元信息可选**：文件元信息是可选的，写入失败不影响主流程
