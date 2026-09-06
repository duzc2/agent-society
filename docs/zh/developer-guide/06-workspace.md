# 工作区与文件服务

工作区是任务的隔离文件环境，也是多智能体协作的共享空间。源码目录：`src/platform/services/workspace/`（有 `workspace.md` 自述）。

## 组件结构

```
services/workspace/
├── workspace_manager.js       # WorkspaceManager 单例：绑定/分配/懒创建
├── workspace.js               # Workspace 实例：文件操作 + 元数据 + MIME
└── file_access/               # 工作区之外的本地文件访问体系
    ├── workspace_file_access_service.js  # 授权服务
    ├── external_permission_manager.js    # 授权文件夹管理
    ├── external_file_service.js          # 外部文件读写
    ├── external_access_logger.js         # 访问审计日志
    ├── external_config_manager.js        # 授权配置
    ├── bigfile_service.js                # 大文件分块处理
    ├── path_resolver.js                  # 路径解析
    └── routes.js                         # /api/workspaces/file-access 路由
```

## WorkspaceManager

- 单例模式，全局经 `getWorkspaceManager()` 获取；
- `bindWorkspace(taskId, workspacePath)`：任务提交时绑定，立即创建目录；
- `assignWorkspace(workspaceId, path)`：分配路径，懒加载创建；
- 路径安全：所有操作解析后必须落在工作区根内（拒绝绝对路径、拒绝 `..`）；
- 目录位置：`config/app.json` 的 `workspacesDir`。

## Workspace 实例

- 文件读写、目录列举、删除；
- 元数据持久化（工作区元信息供界面"工件管理器"展示）；
- MIME 类型检测（联动 `utils/content/content_type_utils.js`）。

## 内容路由

智能体与文件交互经历内容路由（`utils/content/content_router.js`、`capability_router.js`）：

```
消息带附件
  └─▶ ContentRouter 判定类型（text/image/audio/file，BinaryDetector 多层检测）
      └─▶ CapabilityRouter 检查目标模型输入能力
          ├─ 支持 → 按 text / image_url / file 形态放入 LLM 请求
          └─ 不支持 → ContentAdapter 转文本描述
                        （附"可处理该类型的智能体"建议，促进协作）
```

## 对外 HTTP 服务

| 端点 | 用途 |
|------|------|
| `GET /workspace-files/<workspaceId>/<path>` | 工作区静态访问（浏览器打开 HTML 产出） |
| `GET/POST/PUT/DELETE /api/workspaces/...` | 工作区列表、文件列表、元信息、建目录（见 [HTTP API 参考](07-http-api.md)） |
| `/api/workspaces/file-access/*` | 授权文件夹 CRUD、访问日志、统计、留存设置 |

## 本地文件访问授权

智能体默认只能访问工作区。访问外部本地文件的完整链路：

1. 用户在界面添加授权文件夹（写入授权配置）；
2. 智能体用 `file_list_authorized_folders` / `file_check_permission` 发现权限；
3. `file_read` / `file_write` 等工具经 PathResolver 校验后由 ExternalFileService 执行；
4. ExternalAccessLogger 记录每次访问（谁、何时、什么路径、什么操作）——审计要求。

大文件走 `bigfile_service.js` 分块处理，避免一次性读入内存。

## 开发注意

1. 新增文件相关能力时**必须**复用路径安全校验，不要绕开 WorkspaceManager 直接拼路径；
2. 外部文件访问必须走授权体系并记审计日志；
3. 文件名/MIME 处理使用 `utils/content/content_type_utils.js` 的统一实现，不要各写各的。
