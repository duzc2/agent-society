# Tools

The entry point for all agent capabilities. Built-in tool schemas assemble in `src/platform/runtime/tools_schema.js`, implementations split by domain across `tools_agent.js`, `tools_file.js`, `tools_group.js`, `tools_skill.js`, `tools_system.js`, `tools_model.js`, `tools_network.js`; the tool group mechanism lives in `extensions/tool_group_manager.js`.

## Tool Groups

- Every tool belongs to a group (built-in groups defined in ToolGroupManager's `BUILTIN_TOOL_GROUPS`; module groups registered by ModuleLoader);
- A role's `toolGroups` field is a whitelist: agents only see and call tools in their groups; null/unset = all;
- Agents can self-inspect with `list_tool_groups` and self-adjust with `update_my_tool_groups` (still constrained by role bindings).

## Built-in Tools

### Org Management Group

| Tool | Description |
|------|-------------|
| `find_role_by_name` | Find a role by name |
| `get_org_structure` | Current org structure (with agent compute states, workspace bindings) |
| `set_org_name` | Set the org display name |
| `create_role` | Create a role (name/rolePrompt required; optional orgPrompt, toolGroups) |
| `delete_role` | Delete a role (cascades to sub-agents and sub-roles; self-created only) |
| `spawn_agent_with_task` | Create an agent with a task (requires a valid TaskBrief) |
| `send_message` | Message a specific agent |
| `delete_agent` | Delete an agent (self-created only) |
| `get_org_template_org` / `list_org_template_infos` | Read / list org templates |

### Group Chat Group

`create_group`, `dissolve_group`, `invite_to_group`, `leave_group`, `send_group_message`, `get_group_info`, `list_my_groups`

### File Group

`file_read`, `file_read_lines`, `file_search`, `file_info`, `file_stats`, `file_line_count`, `file_json_tree`, `file_json_keys`, `file_jsonl_filter`, `file_create_directory`, `list_files`, `edit_file`, `replace_file`, `append_file`, `copy_file`, `move_file`, `delete_file`, `search_text`, `file_check_permission`, `file_list_authorized_folders`, `get_workspace_info`

### Skill Group

`skill_list`, `skill_get`, `load_skill_detail`, `run_skill_script`, `skill_create`, `skill_delete`, `skill_copy`, `skill_create_file`, `skill_read_file`, `skill_write_file`, `skill_create_folder`, `skill_rename_entry`, `skill_delete_entry`, `skill_set_status`, `skill_bind_to_agent`, `skill_unbind_from_agent`, `forget_skill`

### System Group

| Tool | Description |
|------|-------------|
| `get_system_prompt_appendix` / `add` / `update` / `remove_system_prompt_appendix_item` | Self-managed prompt appendix (memory layer 1) |
| `add_todo_item` / `list_todo_items` / `update_todo_item` / `delete_todo_item` | Todo list |
| `get_context_status` | Own context occupancy state |
| `run_javascript` | Sandboxed JS (precise computation, data processing; Worker + vm isolation) |
| `http_request` | HTTPS requests (https only, with timeout and truncation) |

### Module Tool Groups

| Group | Tools |
|-------|-------|
| `localcmd` | `localcmd_spawn`, `localcmd_read_output`, `localcmd_send_input`, `localcmd_get_status`, `localcmd_kill`, `localcmd_list` |
| `chrome` | `chrome_new_tab`, `chrome_navigate`, `chrome_get_text`, `chrome_get_elements`, `chrome_click`, `chrome_click_at`, `chrome_fill`, `chrome_type`, `chrome_scroll`, `chrome_screenshot`, `chrome_evaluate`, `chrome_wait_for`, `chrome_get_url`, `chrome_list_tabs`, `chrome_close_tab`, `chrome_open_devtools`, `chrome_devtools_console_logs`, `chrome_devtools_network_logs`, `chrome_devtools_cookies`, `chrome_devtools_storage`, `chrome_devtools_emulation`, `chrome_devtools_inspect_element`, `chrome_devtools_intercept_request`, `chrome_list_resources`, `chrome_save_resource` |
| `ssh` | `ssh_list_hosts`, `ssh_shell_create`, `ssh_shell_send`, `ssh_shell_read`, `ssh_shell_close`, `ssh_shell_list`, `ssh_upload`, `ssh_download`, `ssh_transfer_status`, `ssh_transfer_cancel` |
| `ui_page` | `ui_page_eval_js`, `ui_page_dom_patch`, `ui_page_get_content`, `ui_page_notify` |
| `automation` | `automation_mouse_click`, `automation_mouse_double_click`, `automation_mouse_move`, `automation_mouse_drag`, `automation_mouse_scroll`, `automation_mouse_get_position`, `automation_key_press`, `automation_key_combination`, `automation_type_text`, `automation_screen_get_size`, `automation_screen_get_info`, `automation_screenshot_region`, `automation_screenshot_control`, `automation_find_control`, `automation_get_control_tree`, `automation_control_get_children`, `automation_control_set_focus`, `automation_control_send_text`, `automation_control_click`, `automation_wait`, `automation_wait_for_control` |
| `document` | `document_read`, `document_info`, `document_search` |
| `light-ocr` | `light_ocr` |
| `message_tools` | `read_agent_messages`, `search_agent_messages` |
| `sandbox` | `sandbox_spawn`, `sandbox_read_output`, `sandbox_get_status`, `sandbox_kill` |

> The authoritative tool list is the runtime output of `tools_schema.js` and each module's `getToolDefinitions()`; the reference above reflects the current main branch.

## Execution Chain

```
LLM returns tool_calls
  └─▶ RuntimeTools (permission check: is the tool in the role's tool groups)
      └─▶ ToolExecutor
          ├─ built-in → tools_*.js implementation
          ├─ run_javascript → JavaScriptExecutor (dangerous-token prefilter → Worker + vm sandbox)
          └─ others → ModuleLoader.executeToolCall → module implementation
```

## Tool Result Management

- Tool results are written back to conversation history (assistant tool_call + tool message pairs);
- **Aging**: old-round tool results are demoted to summaries by `tool_result_aging_service`;
- **Compression**: earlier rounds are truncated by `tool_call_pair_compressor` (see [Conversation & Context](05-conversation.md)).

## Adding a Tool

1. Append the definition to the relevant group in `tools_schema.js` (LLM-facing description);
2. Add the execution method in the corresponding `tools_*.js` and wire it up;
3. For a new domain, create `tools_<domain>.js` and register the built-in group with ToolGroupManager;
4. Add tests (`test/platform/runtime/tool_executor.*.test.js` are ready examples).

Module capabilities go through the [Module Development Guide](08-module-development.md) — don't push business tools into the built-in layer.

## Related Documents

- [Module Development](08-module-development.md)
- [Messaging & Scheduling](03-messaging-scheduling.md)
