# 1.0 验收范围

## Lightroom 实机

在 Windows 和 Lightroom Classic 15.0.1 上检查了照片读取、生成方案、前后图、参数读回和快照恢复。还分别检查了主体和天空蒙版、多轮调整及 XMP 导入。测试使用练习照片的虚拟副本。原始显影与恢复后的副本经读回核对。

## 安装包

Windows x64 ZIP 在独立目录中验证安装、启动、重复启动、配置保留、版本切换和回滚。回滚使用有独立版本号的安装测试夹具。安装版连接真实 Lightroom 取得渲染，并复用已登录的 Codex CLI 生成了新方案。

## 自动化

GitHub Actions 在 Windows 上运行 Studio Node 测试、Lightroom MCP 检查与测试、Lua 5.1 SDK 桩测试及无目录写入的 Windows 安装测试。实机覆盖范围与 CI 的模拟范围分别记录。源照片、调色任务、日志与私人截图保留在本机。
