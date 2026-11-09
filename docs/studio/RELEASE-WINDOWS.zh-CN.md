# LR Codex Studio Windows 安装

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

- `./Install.ps1 -Preflight` 或 `./current/scripts/studio.ps1 doctor --preflight` 检查 Node、Codex CLI 版本和登录、代理与 Lightroom 桥接。首次安装可先检查 Node 和 Codex，添加并启动两款插件后再检查 Lightroom 连接。
- `./current/scripts/studio-status.ps1` 显示运行状态、当前加载的 Lightroom MCP 插件版本和最近一次日志位置。原生工作台也可打开「连接状态」。
- `./current/scripts/studio.ps1 doctor` 检查当前选中的照片，并在本地保存诊断任务和 `before.jpg`。
- 默认任务目录是安装目录的 `data/jobs`。Host 启动日志位于 `logs`，保留最近五次启动的日志。任务、参考图和日志均为本机资料。

## 更新和回滚

1. 等待所有任务完成并关闭工作台，然后在安装目录运行 `./current/scripts/stop-studio-host.ps1`。
2. 解压新 ZIP，从新版解压目录运行 `./Install.ps1`。安装器保留当前和上一个版本。安装目录的 `Rollback.ps1` 可以切回上一个版本，`Repair.ps1` 可以检查并完成中断的版本切换。自定义安装路径更新时需传入同一个 `-InstallRoot`。
3. 在 Lightroom 增效工具管理器中重新载入 Studio 插件，运行 `current\scripts\start-studio-host.ps1`。`current` 下的插件路径在更新和回滚时保持稳定，设置、任务、风格和日志保存在版本目录之外。

## 卸载和校验

先停止 Host，再在 Lightroom 的增效工具管理器移除本安装目录中的两个插件条目。运行安装目录的 `Uninstall.ps1` 移除程序。默认保留设置、任务、风格、参考图、批次和日志。显式传入 `-PurgeData` 并确认后，可同时删除默认位置的数据和设置。自定义数据目录由你单独管理。

下载后可用 `Get-FileHash -Algorithm SHA256 <ZIP路径>` 与同名 `.sha256` 文件核对。带构建证明的版本可用 `gh attestation verify <ZIP路径> --repo wonderhate/LRhelper` 查验来源。
