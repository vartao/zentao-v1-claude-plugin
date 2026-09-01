# zentao-v1

这是一个 Claude Code 插件，内置：

- ZenTao REST API v1 MCP Server
- 禅道操作工作流 Skill
- 跨平台账号和 Token 配置脚本

安装插件后，首次调用时运行 MCP 返回的配置命令，例如：

```bash
node "<插件安装目录>/scripts/configure.mjs"
```

按提示输入禅道地址以及 Token，或者输入账号和密码。凭据保存在当前用户的 `~/.config/zentao-v1/credentials.json` 中，不会写入插件目录，也不会包含在安装包中。

每位使用者都应该配置自己的禅道账号。插件默认对写操作使用预览模式，确认无误后才会真正执行。

卸载插件前请完全退出 Claude Code。执行 `claude plugin uninstall "zentao-v1@zentao-v1-marketplace" --scope user -y`，如不再使用该来源，再执行 `claude plugin marketplace remove zentao-v1-marketplace`。

删除登录凭据：`$HOME\.config\zentao-v1\credentials.json`。删除它会清除本插件的禅道登录信息；不会删除禅道中的业务数据。

0.8.7 版本支持直接查询我的任务和 Bug、需求/任务/Bug 生命周期操作、任务工时查询/编辑/删除、官方表单控制器以及写入后的回读校验。配置脚本会以星号掩码显示密码输入，并稳定等待“是否保存密码”的确认。Bug 的 `deadline` 和 `consumed` 会在目标禅道实例提供对应表单字段时提交；`consumed` 不是所有禅道实例都具备的标准字段。

完整中文文档请查看仓库根目录的 [README.zh-CN.md](../README.zh-CN.md)。
