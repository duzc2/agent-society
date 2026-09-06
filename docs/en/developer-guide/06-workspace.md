# Workspace & File Services

The workspace is each task's isolated file environment and the shared collaboration space. Source directory: `src/platform/services/workspace/` (with `workspace.md`).

## Component Structure

```
services/workspace/
├── workspace_manager.js       # WorkspaceManager singleton: bind/assign/lazy-create
├── workspace.js               # Workspace instance: file ops + metadata + MIME
└── file_access/               # Out-of-workspace local file access
    ├── workspace_file_access_service.js  # Authorization service
    ├── external_permission_manager.js    # Authorized folder management
    ├── external_file_service.js          # External file read/write
    ├── external_access_logger.js         # Access audit log
    ├── external_config_manager.js        # Authorization config
    ├── bigfile_service.js                # Chunked large-file handling
    ├── path_resolver.js                  # Path resolution
    └── routes.js                         # /api/workspaces/file-access routes
```

## WorkspaceManager

- Singleton, obtained globally via `getWorkspaceManager()`;
- `bindWorkspace(taskId, workspacePath)`: binds at requirement submission, creating the directory immediately;
- `assignWorkspace(workspaceId, path)`: assigns a path, created lazily;
- Path safety: every resolved path must land inside the workspace root (absolute paths and `..` rejected);
- Location: `workspacesDir` in `config/app.json`.

## Workspace Instance

- File read/write, directory listing, deletion;
- Metadata persistence (workspace info feeds the UI's artifacts manager);
- MIME detection (via `utils/content/content_type_utils.js`).

## Content Routing

File interactions pass through content routing (`utils/content/content_router.js`, `capability_router.js`):

```
message carries attachments
  └─▶ ContentRouter classifies (text/image/audio/file; BinaryDetector multi-layer)
      └─▶ CapabilityRouter checks target model's input capabilities
          ├─ supported → embed as text / image_url / file in the LLM request
          └─ unsupported → ContentAdapter converts to a text description
                            (with suggestions of agents that can handle the type)
```

## Outbound HTTP Services

| Endpoint | Purpose |
|----------|---------|
| `GET /workspace-files/<workspaceId>/<path>` | Static workspace access (browser-openable HTML deliverables) |
| `GET/POST/PUT/DELETE /api/workspaces/...` | Workspace list, file list, metadata, mkdir (see [HTTP API Reference](07-http-api.md)) |
| `/api/workspaces/file-access/*` | Authorized folder CRUD, access logs, stats, retention settings |

## Local File Access Authorization

Agents can only touch their workspace by default. The full chain for external local files:

1. The user adds an authorized folder in the UI (written to authorization config);
2. Agents discover permissions via `file_list_authorized_folders` / `file_check_permission`;
3. `file_read` / `file_write` and friends go through PathResolver checks, then ExternalFileService executes;
4. ExternalAccessLogger records every access (who, when, which path, which operation) — the audit requirement.

Large files go through `bigfile_service.js` chunking, avoiding whole-file memory loads.

## Developer Notes

1. New file capabilities **must** reuse the path-safety checks — never bypass WorkspaceManager with hand-built paths;
2. External file access must pass the authorization system and write audit logs;
3. Use the unified MIME helpers in `utils/content/content_type_utils.js` — don't reimplement.
