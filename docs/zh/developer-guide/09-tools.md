# 工具系统

智能体的全部能力入口。内置工具 schema 总装在 `src/platform/runtime/tools_schema.js`，实现按域拆在 `tools_agent.js`、`tools_file.js`、`tools_group.js`、`tools_skill.js`、`tools_system.js`、`tools_model.js`、`tools_network.js`；工具组机制在 `extensions/tool_group_manager.js`。

## 工具组

- 每个工具属于一个工具组（内置组由 ToolGroupManager 的 `BUILTIN_TOOL_GROUPS` 定义，模块组由 ModuleLoader 注册）；
- 岗位的 `toolGroups` 字段是白名单：智能体只能看到并调用组内工具；null/未设置 = 全部；
- 智能体可用 `list_tool_groups` 自查、`update_my_tool_groups` 自助调整（仍受岗位限制约束）。

## 内置工具

### 组织管理组

| 工具 | 说明 |
|------|------|
| `find_role_by_name` | 按名查岗位 |
| `get_org_structure` | 获取组织结构（含智能体运算状态、工作区绑定） |
| `set_org_name` | 设置组织显示名 |
| `create_role` | 创建岗位（name/rolePrompt 必填；可带 orgPrompt、toolGroups） |
| `delete_role` | 删除岗位（级联删除下属智能体与子岗位，限自建） |
| `spawn_agent_with_task` | 创建智能体并委派任务（必须带合法 TaskBrief） |
| `send_message` | 给指定智能体发消息 |
| `delete_agent` | 删除智能体（限自建） |
| `get_org_template_org` / `list_org_template_infos` | 读取/列出组织模板 |

### 群聊组

`create_group`、`dissolve_group`、`invite_to_group`、`leave_group`、`send_group_message`、`get_group_info`、`list_my_groups`

### 文件组

`file_read`、`file_read_lines`、`file_search`、`file_info`、`file_stats`、`file_line_count`、`file_json_tree`、`file_json_keys`、`file_jsonl_filter`、`file_create_directory`、`list_files`、`edit_file`、`replace_file`、`append_file`、`copy_file`、`move_file`、`delete_file`、`search_text`、`file_check_permission`、`file_list_authorized_folders`、`get_workspace_info`

### 技能组

`skill_list`、`skill_get`、`load_skill_detail`、`run_skill_script`、`skill_create`、`skill_delete`、`skill_copy`、`skill_create_file`、`skill_read_file`、`skill_write_file`、`skill_create_folder`、`skill_rename_entry`、`skill_delete_entry`、`skill_set_status`、`skill_bind_to_agent`、`skill_unbind_from_agent`、`forget_skill`

### 系统组

| 工具 | 说明 |
|------|------|
| `get_system_prompt_appendix` / `add` / `update` / `remove_system_prompt_appendix_item` | 自管理提示词附录（记忆第 1 层） |
| `add_todo_item` / `list_todo_items` / `update_todo_item` / `delete_todo_item` | 待办事项 |
| `get_context_status` | 查看自己的上下文占用状态 |
| `run_javascript` | 在沙箱中执行 JS（精确计算、数据处理；Worker + vm 隔离） |
| `http_request` | 发起 HTTPS 请求（仅 https 协议，带超时与截断） |

### 模块工具组

| 工具组 | 工具 |
|--------|------|
| `localcmd` | `localcmd_spawn`、`localcmd_read_output`、`localcmd_send_input`、`localcmd_get_status`、`localcmd_kill`、`localcmd_list` |
| `chrome` | `chrome_new_tab`、`chrome_navigate`、`chrome_get_text`、`chrome_get_elements`、`chrome_click`、`chrome_click_at`、`chrome_fill`、`chrome_type`、`chrome_scroll`、`chrome_screenshot`、`chrome_evaluate`、`chrome_wait_for`、`chrome_get_url`、`chrome_list_tabs`、`chrome_close_tab`、`chrome_open_devtools`、`chrome_devtools_console_logs`、`chrome_devtools_network_logs`、`chrome_devtools_cookies`、`chrome_devtools_storage`、`chrome_devtools_emulation`、`chrome_devtools_inspect_element`、`chrome_devtools_intercept_request`、`chrome_list_resources`、`chrome_save_resource` |
| `ssh` | `ssh_list_hosts`、`ssh_shell_create`、`ssh_shell_send`、`ssh_shell_read`、`ssh_shell_close`、`ssh_shell_list`、`ssh_upload`、`ssh_download`、`ssh_transfer_status`、`ssh_transfer_cancel` |
| `ui_page` | `ui_page_eval_js`、`ui_page_dom_patch`、`ui_page_get_content`、`ui_page_notify` |
| `automation` | `automation_mouse_click`、`automation_mouse_double_click`、`automation_mouse_move`、`automation_mouse_drag`、`automation_mouse_scroll`、`automation_mouse_get_position`、`automation_key_press`、`automation_key_combination`、`automation_type_text`、`automation_screen_get_size`、`automation_screen_get_info`、`automation_screenshot_region`、`automation_screenshot_control`、`automation_find_control`、`automation_get_control_tree`、`automation_control_get_children`、`automation_control_set_focus`、`automation_control_send_text`、`automation_control_click`、`automation_wait`、`automation_wait_for_control` |
| `document` | `document_read`、`document_info`、`document_search` |
| `light-ocr` | `light_ocr` |
| `message_tools` | `read_agent_messages`、`search_agent_messages` |
| `sandbox` | `sandbox_spawn`、`sandbox_read_output`、`sandbox_get_status`、`sandbox_kill` |

> 工具清单以 `tools_schema.js` 与各模块 `getToolDefinitions()` 的运行时输出为准；上面的速查基于当前 main 分支整理。

## 工具执行链

```
LLM 返回 tool_calls
  └─▶ RuntimeTools（权限校验：工具是否在岗位工具组内）
      └─▶ ToolExecutor
          ├─ 内置工具 → tools_*.js 对应实现
          ├─ run_javascript → JavaScriptExecutor（危险 token 预过滤 → Worker + vm 沙箱）
          └─ 其他 → ModuleLoader.executeToolCall → 模块实现
```

## 工具结果管理

- 工具结果写回会话历史（assistant 的 tool_call + tool 消息成对）；
- **老化**：老轮次的工具结果被 `tool_result_aging_service` 降级为摘要；
- **压缩**：更早的轮次由 `tool_call_pair_compressor` 截断（见 [会话与上下文](05-conversation.md)）。

## 新增内置工具

1. 在 `tools_schema.js` 相应分组追加定义（面向 LLM 的 description）；
2. 在对应的 `tools_*.js` 实现类中添加执行方法并接线；
3. 若属于新域，新建 `tools_<域>.js` 并在 ToolGroupManager 注册内置工具组；
4. 补测试（`test/platform/runtime/tool_executor.*.test.js` 系列是现成样例）。

模块能力的扩展则走 [模块开发指南](08-module-development.md)，不要把业务工具塞进内置层。

## 相关文档

- [模块开发指南](08-module-development.md)
- [消息与调度](03-messaging-scheduling.md)
