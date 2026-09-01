# zentao-v1

This Claude Code plugin bundles a ZenTao REST API v1 MCP server and a workflow skill. Run the setup command reported by `zentao_setup_status`, enter your own ZenTao credentials, and fully restart Claude Code.

Each user must configure a separate account. This plugin contains no credentials.

Version 0.8.7 includes direct personal task and Bug queries, full story/task/Bug lifecycle tools, task effort listing/editing/deletion, official form-controller support, and read-after-write validation. The interactive setup script masks password input and reliably waits for the password-save choice. Bug `deadline` and `consumed` are forwarded when the target ZenTao instance exposes those fields.

中文说明：见 [README.zh-CN.md](README.zh-CN.md)。
