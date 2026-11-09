# LR Codex Studio 1.0 Windows 安装

需要 Lightroom Classic、Windows Node.js 22 或更新版本，以及已登录且可从 PowerShell 调用的 Codex CLI。ZIP 已包含 Studio Host、Lightroom MCP 服务端的生产依赖和两个 Lightroom 插件。

## 安装

1. 解压 ZIP，在解压目录运行 `./Install.ps1`。默认装到 `%LOCALAPPDATA%\LR Codex Studio`，也可以传入 `-InstallRoot` 指定路径。
2. 在 Lightroom「文件 → 增效工具管理器 → 添加」中，从安装目录的 `current\plugin` 添加 `LRCodexStudio.lrplugin` 与 `LightroomMCP.lrplugin`。已有同名开发版、上游版或其他版本时，先停用旧条目，再添加本安装包的版本并重启 Lightroom。新版桥接会核对实际加载的版本，确认兼容后才允许写入。
3. 运行安装目录下的 `current\scripts\start-studio-host.ps1`。在 Lightroom 的「增效工具额外信息」打开 LR Codex Studio 工作台。

## 配置和诊断

设置文件位于安装目录的 `settings.json`。从安装目录运行 `./current/scripts/studio.ps1 config` 可查看生效的值。以下是完整的可选字段示例，路径请替换为自己的绝对路径。

```json
{
  "codexPath": "C:/Tools/codex.exe",
  "jobsDirectory": "D:/LightroomStudio/jobs",
  "useSystemProxy": true
}
```

还可设置 `model` 和 `mcpEntry`。已有 `STUDIO_CODEX_PATH`、`STUDIO_CODEX_MODEL`、`STUDIO_DATA_DIR`、`STUDIO_MCP_ENTRY` 和 `STUDIO_USE_SYSTEM_PROXY` 环境变量优先生效。更改配置后重启 Host。要继续使用开发版历史，可将 `jobsDirectory` 指向原 `.studio/jobs` 的绝对路径。风格和批次位于任务目录旁。

- `./current/scripts/studio-status.ps1` 显示运行状态和最近一次 stderr 日志位置。
- `./current/scripts/studio.ps1 doctor` 检查当前 Lightroom 选中照片、MCP 能力、源文件和渲染。
- 默认任务目录是安装目录的 `data/jobs`。Host 启动日志位于 `logs`，保留最近五次启动的日志。任务、参考图和日志均为本机资料。

## 更新和回滚

1. 等待所有任务完成并关闭工作台，然后在安装目录运行 `./current/scripts/stop-studio-host.ps1`。
2. 解压新 ZIP，从新版解压目录运行 `./Install.ps1`。从任一保留的解压目录运行 `./Install.ps1 -Rollback` 可切回上一次安装版本。若安装时指定了 `-InstallRoot`，更新和回滚也需传入同一路径。
3. 在 Lightroom 增效工具管理器中重新载入 Studio 插件，运行 `current\scripts\start-studio-host.ps1`。`current` 下的插件路径在更新和回滚时保持稳定，设置、任务、风格和日志保存在版本目录之外。

下载后可用 `Get-FileHash -Algorithm SHA256 <ZIP路径>` 与同名 `.sha256` 文件核对。许可证随包附带。
