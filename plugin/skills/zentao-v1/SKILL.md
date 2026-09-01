---
name: zentao-v1
description: Use the bundled zentao-v1 MCP for ZenTao 18.x REST API v1. Trigger for products, projects, executions, stories, requirements, tasks, effort records, bugs, todos, tests, docs, issues, risks, and connection checks.
version: 0.8.7
---

# ZenTao REST API v1

Use only the MCP server bundled with this plugin. Do not call legacy ZenTao CLIs, shell scripts, ad-hoc HTTP requests, or export complete result sets to files for filtering.

## Query Routing

- For "my tasks" or tasks assigned to the current user, call `zentao_list_my_tasks` directly. Do not scan projects or executions.
- For "my bugs", unresolved bugs assigned to the current user, or equivalent requests, call `zentao_list_my_bugs` directly. Pass title or ID text through `keyword`; do not list products or download all bugs first.
- For a known bug, task, or story ID, call the matching `zentao_get_*` detail tool directly.
- For bugs in a named product, resolve that product once and call `zentao_list_bugs` with `assignedTo`, `statuses`, and `keyword` so filtering occurs inside the MCP server.
- Present matched records directly. Do not create a local file unless the user explicitly asks for an export.

## Products, Projects, Executions, And Modules

Never assume IDs from names. Resolve them with the matching list/detail tools.

Task tools require an execution ID, not a project ID. For a named project, call `zentao_list_project_executions` and use the returned execution ID. Resolve story, task, and bug modules with `zentao_list_modules` when the server requires a module.

## Writes

- Story creation requires product, title, and spec. Module and common values have stable defaults but should be resolved when the instance requires them. `mailto` and `notifyEmail` are supported when exposed by the instance form.
- Task creation normally requires execution and name; common fields have server defaults.
- Bug creation requires product, title, and module; build, severity, priority, and type have defaults. `deadline`, `consumed`, `mailto`, and `notifyEmail` are forwarded through the official form controller when the target instance exposes those fields; `consumed` is an instance-specific custom field, not a universal ZenTao field.
- Bug steps are normalized into readable HTML. Use sections such as `【现象】`, `【复现步骤】`, and `【期望】`, with one numbered reproduction step per line.
- `zentao_update_story` updates basic fields with REST PUT and spec/verify with the story change route in one MCP call.
- Task effort records can be read with `zentao_list_task_efforts`, edited with `zentao_update_task_effort`, and deleted with `zentao_delete_task_effort`. The server checks task ownership of the effort record and verifies the result after mutation.
- Surface MCP validation and permission errors directly. Never modify MCP source during a normal business operation.

All writes default to preview. Show the preview and obtain explicit user confirmation before calling again with both `dryRun=false` and `confirm=true`.

For deletion, pass the exact confirmed title/name. The server re-fetches the object and permits deletion only when the creator is the configured account.

## Setup

If a tool returns `SETUP_REQUIRED`, show its `setupCommand`. The cross-platform script securely prompts for the ZenTao URL and either a token or account/password authentication. Password persistence for automatic token refresh is optional and disabled by default. Never ask the user to paste credentials into chat.
