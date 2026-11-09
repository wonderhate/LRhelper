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
./scripts/test-studio-release.ps1
```

实际显影测试使用练习照片和新虚拟副本。保留快照，读回源照片和副本，再判断是否恢复成功。功能与安全性相关的回归应覆盖旧任务记录和现有 Lightroom MCP 能力。

## 发布维护

将标签构建生成的 Windows x64 ZIP 和同名 `.sha256` 文件附到对应的 GitHub Release。发布事件触发 **Publish Windows Package**，它验证 SHA-256 与构建证明，发布相同文件到 GHCR，再按不可变引用拉取复验。需要重试时，从 Actions 手动运行同一工作流并指定标签。

## 维护桥接分支

Lightroom MCP 桥接以 Automaat/lightroom-mcp 0.26.0 为基线。同步上游时保留原许可和历史，在单独分支合入并复验下面的本地改动。

- 请求仅接受已发布的工具契约。桥接对帧大小、进度、最终响应和断线结果做校验。
- LRhelper 的协议握手区分加载中的插件、旧桥接和其他分支。更新协议时同步检查 Lua 身份、TypeScript 能力校验和 MCP 清单。
- 虚拟副本恢复依赖目录身份、完整副本名和快照核对。更新照片元数据或快照处理器时同时跑 Studio 恢复测试。
- Node 22 是最低支持版本。Windows 发布使用 Node 24.19.0。Windows CI 执行类型检查、lint 和工作台测试，Linux CI 执行 Lua 5.1 和 Selene。

发布由 Git 标签触发。带证明的 ZIP 和校验文件来自 Windows 发布工作流的构建制品。GitHub Packages 校验标签、提交和 ZIP 后镜像，并在工作流摘要记录不可变 digest。
