# 贡献指南

欢迎提交问题和拉取请求。请说明 Lightroom Classic、Windows、Node.js 和 LRhelper 版本，给出可复现的操作及预期结果。分享日志或截图前请移除路径、身份信息、令牌和私人照片。

## 构建与测试

```powershell
./scripts/setup-studio.ps1
npm --prefix studio test
npm --prefix server run check
npm --prefix server test -- --runInBand
python -m pip install lupa==2.8
python studio/tests/lua-workbench.py
```

发布包可在 Windows 上生成和检查。安装测试使用独立目录，实机读取可选传入 `-PhotoId`。

```powershell
./scripts/build-studio-release.ps1
powershell.exe -NoProfile -File studio/tests/windows-release-smoke.ps1 -Package build/studio/LR-Codex-Studio-1.0.0-Windows-x64.zip
```

实际显影测试使用练习照片和新虚拟副本。保留快照，读回源照片和副本，再判断是否恢复成功。功能与安全性相关的回归应覆盖旧任务记录和现有 Lightroom MCP 能力。

## 发布维护

将测试过的 Windows x64 ZIP 和同名 `.sha256` 文件附到对应的 GitHub Release，使用 `vX.Y.Z` 标签。发布事件触发 **Publish Windows Package**，它校验 Release 的 SHA-256，发布同样的文件到 GHCR，再拉取并复验。需要重试时，从 Actions 手动运行同一工作流并指定标签。
