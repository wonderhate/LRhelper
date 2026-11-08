# LRhelper · LR Codex Studio

Lightroom Classic 原生调色工作台。用文字、参考图或自动分析生成方案，在 Lightroom 渲染的前后图中检查效果，再决定是否保留虚拟副本。

[下载 Windows 版](https://github.com/wonderhate/LRhelper/releases/latest) · [安装与更新](docs/studio/RELEASE-WINDOWS.zh-CN.md) · [GitHub Packages](https://github.com/wonderhate/LRhelper/pkgs/container/lrhelper) · [English](README.en.md)

[![Windows CI](https://github.com/wonderhate/LRhelper/actions/workflows/ci.yml/badge.svg)](https://github.com/wonderhate/LRhelper/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 安装与开始

当前发布包面向 **Windows x64**。需要 Lightroom Classic、Node.js 22 或更新版本，以及已登录、可从 PowerShell 调用的 Codex CLI。1.0 在 Lightroom Classic 15.0.1 上实机验证。

1. 从 [Releases](https://github.com/wonderhate/LRhelper/releases/latest) 下载 Windows ZIP，解压后运行 `./Install.ps1`。
2. 在 Lightroom 的「文件 → 增效工具管理器」添加安装目录下的 `current/plugin/LRCodexStudio.lrplugin`。若尚未安装 Lightroom MCP，也添加同目录的 `LightroomMCP.lrplugin` 并启动其服务。
3. 运行 `current/scripts/start-studio-host.ps1`，从 Lightroom 的「增效工具额外信息」打开 **LR Codex Studio**。
4. 选中一张照片并读取，生成方案后查看「参数差异」。点「预览副本」才会在新虚拟副本上执行。每份预览有独立快照，可通过「恢复副本」回到基线。

默认安装位置为 `%LOCALAPPDATA%\LR Codex Studio`。安装、配置、更新和回滚的完整步骤见 [Windows 安装指南](docs/studio/RELEASE-WINDOWS.zh-CN.md)。

## 功能

| 功能 | 工作方式 |
| --- | --- |
| 文字、参考图、自动调色 | Codex 分析目标画面和可选参考图，按目标的光线、白平衡与当前参数生成方案。 |
| 真实预览 | 比较 Lightroom 渲染的前后图，查看中文滑块名称和实际差异。 |
| 多轮调整 | 在同一会话中基于上轮预览细调，也可打开历史轮次。 |
| 风格库与 XMP | 保存调色意图和参考图副本，应用时适配新照片，也可导出固定参数的 XMP。 |
| 批量适配 | 对选中的 2–8 张照片独立生成全局方案，再逐张或整批预览。 |
| 主体与天空 | 单张照片可选局部蒙版。检测到肤色或判断不确定时，会限制红橙 HSL 的改动幅度。 |

## 数据与恢复

任务、参考图副本和日志保存在本机。生成方案会将 Lightroom 的目标渲染图和可选参考图交给已配置的 Codex 运行时分析。工作台通过带本机令牌的回环地址连接 Host。预览前会核对源照片，写入范围是新虚拟副本。

若某张副本的自动恢复失败，工作台会显示副本 ID 和错误。处理前可在 Lightroom 核对该副本及快照。

## 从源码开发

```powershell
./scripts/setup-studio.ps1
npm --prefix studio test
npm --prefix server test -- --runInBand
./scripts/build-studio-release.ps1
```

- `plugin/LRCodexStudio.lrplugin/` 是 Lightroom 原生界面。
- `studio/` 包含 Host、Codex 规划、验证和任务恢复。
- `server/` 和 `plugin/LightroomMCP.lrplugin/` 是本项目复用的 Lightroom MCP 桥接。
- `scripts/` 包含运行、安装和发布打包脚本。

[贡献指南](CONTRIBUTING.md) · [变更记录](CHANGELOG.md) · [验收范围](docs/VALIDATION.md) · [安全问题](SECURITY.md)

## 分发与来源

Windows ZIP 与 SHA-256 校验文件在 [Releases](https://github.com/wonderhate/LRhelper/releases/latest) 提供。GitHub Packages 的 OCI 制品镜像相同的安装文件，适合自动化下载。

```powershell
oras pull ghcr.io/wonderhate/lrhelper:1.0.0
```

项目以 [Automaat/lightroom-mcp](https://github.com/Automaat/lightroom-mcp) 的 `b0899c5` 为桥接基线。参考图适配流程借鉴了 [Ashla](https://github.com/JeremySNR/ashla-lightroom) 的交互思路。源代码采用 [MIT](LICENSE) 许可。
