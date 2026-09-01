# zentao-v1 Claude Code Plugin

An open-source Claude Code plugin that bundles an MCP server and workflow skill for ZenTao REST API v1.

Documentation: [简体中文](README.md)

## Supported Versions

- **Verified: ZenTao 18.6** with REST API v1.
- **Compatibility target: standard REST API v1 portions of ZenTao 18.x**. Other minor versions, editions, permissions, and custom fields may differ; full compatibility is not guaranteed outside 18.6.

## Features

- Direct current-user task and bug queries without scanning every project or product
- Product, project, execution, story, task, bug, test, document, issue, risk, and todo tools
- Story, task, and bug create/update/lifecycle operations
- Task effort recording, listing, editing, and deletion
- Official form-controller support for deployments whose forms expose extra fields such as Bug `deadline` or `consumed`
- Preview-first writes and guarded deletion of objects created by the configured account
- Token authentication or account/password login with optional automatic token refresh
- Cross-platform setup on Windows, macOS, and Linux

## Requirements

- Claude Code with plugin support
- Node.js 18.20 or newer
- A ZenTao installation exposing REST API v1

ZenTao editions and versions can differ in routes, permissions, and required custom fields. The public plugin implements standard REST API v1 behavior and cannot include organization-specific field mappings.

The plugin also uses official ZenTao form controllers where REST v1 does not expose a form field. Custom fields are passed through only when the target deployment supports them; the server verifies fields after a write and reports a mismatch instead of claiming success.

## Install From GitHub

After this repository is published:

```text
claude plugin marketplace add https://github.com/vartao/zentao-v1-claude-plugin.git
claude plugin install zentao-v1@zentao-v1-marketplace --scope user
```

Fully restart Claude Code. Ask Claude to check the ZenTao connection, or open `/mcp`. On first use, the MCP returns a setup command similar to:

```text
node "<installed-plugin-path>/scripts/configure.mjs"
```

Run that exact command in a terminal. The script prompts for the ZenTao base URL and either:

- an API token; or
- account and password, exchanges them for a token, and optionally saves the password for automatic token refresh.

Credentials are saved per OS user at `~/.config/zentao-v1/credentials.json`. They are not written to `.claude.json` and are never included in the plugin.

## Install From The Release Package

Extract `zentao-v1-open-source-0.8.7.zip`, then run:

```text
claude plugin marketplace add <extracted-folder> --scope user
claude plugin install zentao-v1@zentao-v1-marketplace --scope user
```

Run the `configure.mjs` command returned by `zentao_setup_status`, then fully restart Claude Code.

## Uninstall And Clean Up

Fully exit Claude Code before uninstalling:

```powershell
claude plugin uninstall "zentao-v1@zentao-v1-marketplace" --scope user -y
claude plugin marketplace remove zentao-v1-marketplace
```

If an older standalone MCP registration was installed, inspect and remove it:

```powershell
claude mcp list
claude mcp remove zentao-v1 --scope user
```

To delete the ZenTao credentials:

```powershell
$credential = "$HOME\.config\zentao-v1\credentials.json"
if (Test-Path -LiteralPath $credential) {
    Remove-Item -LiteralPath $credential -Force
}
```

Verify the cleanup:

```powershell
claude plugin list
claude plugin marketplace list
claude mcp list
```

You may manually delete downloaded source, release, or build directories after confirming they are no longer needed. Uninstalling the plugin does not delete any ZenTao stories, tasks, or bugs.

## Usage

Natural-language requests are preferred:

```text
List my unfinished ZenTao tasks.
Find my active bugs containing "login".
Create a task in execution 23.
Record 1.5 hours on task 120.
```

The bundled skill directs Claude to use `zentao_list_my_tasks` and `zentao_list_my_bugs` directly for personal work. Write tools return a preview by default and require explicit confirmation before execution.

## Development

```text
npm install
npm run build
npm run typecheck
npm test
npm run build:plugin
npm run smoke:plugin
```

`npm run build:plugin` bundles the MCP into `plugin/server.js` and creates a standalone marketplace under `release/zentao-v1-plugin-marketplace`.

All automated tests use an in-process mock ZenTao server. They do not access a real ZenTao instance.

## Security

Do not commit `credentials.json`, tokens, passwords, private URLs, or organization-specific reports. See [SECURITY.md](SECURITY.md) for reporting security issues.

## License

MIT

## Notes

This project is in early development and may introduce breaking changes. It is released under the MIT License and must be used lawfully within that license.

Stars, pull requests, and issue reports are welcome. The project is an independent third-party Claude Code plugin and MCP tool, with no official affiliation with ZenTao. ZenTao and related marks belong to their respective owners.
