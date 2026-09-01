# zentao-v1 Claude Code 插件

一个开源的 Claude Code 插件，内置 ZenTao REST API v1 的 MCP Server 和工作流 Skill，用于更快、更安全地查询和操作禅道。

文档语言：[English](README.md) ｜ 简体中文

## 功能

- 直接查询当前用户的任务和 Bug，不扫描所有项目、执行或产品
- 支持产品、项目、执行、需求、任务、Bug、测试、文档、问题、风险和待办事项
- 支持需求、任务和 Bug 的创建、修改及生命周期操作
- 支持任务工时的记录、查询、编辑和删除
- 对 REST API 未公开的表单字段使用禅道官方表单控制器，并在写入后回读校验
- 所有写操作默认先返回预览，避免误操作
- 删除需求、任务和 Bug 前，会校验对象标题以及创建人是否为当前账号
- 支持 API Token 登录
- 支持账号密码登录，并可选择保存密码，用于 Token 过期后的自动重新登录
- 支持 Windows、macOS 和 Linux

## 环境要求

- 支持插件的 Claude Code
- Node.js 18.20 或更高版本
- 已开放 REST API v1 的禅道实例

不同禅道版本、版本类型和权限配置可能存在路由、字段和必填项差异。公开版只实现通用的 REST API v1 行为，不包含任何公司内部字段映射或业务配置。

对于目标实例提供的自定义表单字段，插件会按官方表单控制器提交；例如 Bug 的 `deadline`、`consumed` 只有在该禅道实例实际存在对应字段时才会生效。写入后会回读验证，字段未落库时直接报告失败。

## 从 GitHub 安装

仓库发布后，执行：

```bash
claude plugin marketplace add https://github.com/vartao/zentao-v1-claude-plugin.git
claude plugin install zentao-v1@zentao-v1-marketplace --scope user
```

安装完成后，彻底退出并重新启动 Claude Code，然后打开 `/mcp` 检查插件是否已加载。

首次调用时，如果还没有配置禅道凭据，MCP 会返回一个配置命令，形式类似：

```bash
node "<插件安装目录>/scripts/configure.mjs"
```

请在终端中执行这个命令，并按提示输入：

1. 禅道 Base URL，例如 `https://zentao.example.com/zentao`
2. 认证方式：`password` 或 `token`
3. 如果选择密码方式，输入禅道账号和密码
4. 如果选择 Token 方式，输入 API Token

配置脚本会先验证连接，验证成功后将凭据保存到当前操作系统用户的：

```text
~/.config/zentao-v1/credentials.json
```

Windows 通常对应：

```text
C:\Users\你的用户名\.config\zentao-v1\credentials.json
```

凭据不会写入 `.claude.json`，也不会包含在插件或源码压缩包中。密码默认不保存；如果希望 Token 过期后自动重新登录，可以在配置时选择保存密码。

## 从发布包安装

解压 `zentao-v1-open-source-0.8.7.zip` 后执行：

```bash
claude plugin marketplace add <解压目录> --scope user
claude plugin install zentao-v1@zentao-v1-marketplace --scope user
```

随后执行 `zentao_setup_status` 返回的 `configure.mjs` 命令，并彻底重启 Claude Code。

## 卸载与清理

卸载前请先完全退出 Claude Code：

```powershell
claude plugin uninstall "zentao-v1@zentao-v1-marketplace" --scope user -y
claude plugin marketplace remove zentao-v1-marketplace
```

如果以前安装过旧的独立 MCP，请先查看并删除它：

```powershell
claude mcp list
claude mcp remove zentao-v1 --scope user
```

删除禅道登录凭据：

```powershell
$credential = "$HOME\.config\zentao-v1\credentials.json"
if (Test-Path -LiteralPath $credential) {
    Remove-Item -LiteralPath $credential -Force
}
```

检查是否清理完成：

```powershell
claude plugin list
claude plugin marketplace list
claude mcp list
```

如果要删除下载的源码、安装包或本地构建目录，请在确认不再需要后手动删除对应目录。卸载插件不会删除禅道中的任何需求、任务或 Bug。

## 使用示例

安装并完成配置后，可以直接用自然语言提出请求：

```text
列出我未完成的禅道任务。
查询我负责的、标题包含“登录”的活动 Bug。
在执行 23 中创建一个任务。
给任务 120 记录 1.5 小时工时。
创建一个禅道需求。
```

插件内置的 Skill 会指导 Claude：

- 查询个人任务时优先调用 `zentao_list_my_tasks`
- 查询个人 Bug 时优先调用 `zentao_list_my_bugs`
- 不要先把全部任务或 Bug 导出到文件再筛选
- 写入操作必须先展示预览，只有明确确认后才执行

写操作示例：

```text
先预览：在执行 23 中创建任务“优化登录接口”，负责人设置为 alice。
```

确认预览内容无误后，再明确要求执行。

## 本地开发

如果你需要修改源码或运行测试：

```bash
npm install
npm run build
npm run typecheck
npm test
npm run build:plugin
npm run smoke:plugin
```

`npm run build:plugin` 会将 TypeScript MCP Server 打包为 `plugin/server.js`，并生成无需重新编译即可安装的 Marketplace 包：

```text
release/zentao-v1-plugin-marketplace
```

自动化测试使用进程内模拟禅道服务，不会访问真实禅道实例，也不会修改任何真实数据。

## 安全建议

- 不要提交 `credentials.json`
- 不要提交 API Token、密码或私有禅道地址
- 不要把生产数据、真实用户信息或公司定制字段提交到公开仓库
- 建议为插件配置一个权限最小化的禅道账号
- 执行创建、修改、关闭和删除操作前，务必检查 MCP 返回的预览
- 如果不需要自动刷新 Token，建议不要保存密码

发现安全问题时，请通过 GitHub Security Advisory 私下报告，不要在公开 Issue 中提交真实凭据或生产数据。详细说明见 [SECURITY.md](SECURITY.md)。

## 贡献代码

提交代码前请运行：

```bash
npm run build
npm run typecheck
npm test
npm run build:plugin
npm run smoke:plugin
```

新增 API 行为时，请同时增加模拟服务测试。测试禁止连接真实禅道实例。

详细贡献要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT License
