# 0.4 XMP 预设导出

在工作台的「风格库」选择已保存的风格，点击「导出 XMP…」，指定一个新的 `.xmp` 文件。0.3 保存的风格可直接导出。导出只读取本地风格记录。升级时先关闭工作台并重启 Studio Host，然后在 Lightroom 增效工具管理器里重新载入 LR Codex Studio。

在 Lightroom 的「修改照片 → 预设 → + → 导入预设」选择导出的文件。预设组名称是「LR Codex Studio」，预设名称取自风格名。导入后可在 Lightroom 中预览或应用该预设。重复导出同一风格会保留同一个预设 UUID。[Adobe 导入预设说明](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/apply-presets.html)

XMP 面向常规 SDR 彩色照片，记录上次预览中可复用的固定值，覆盖全局影调、HSL、曲线、颜色分级、颗粒和暗角的受支持项目。应用时沿用目标照片的曝光、白平衡及相机配置。Lightroom 可能为已选的调色组补充默认值，实测包括颜色分级的混合度。参考图、分析、提示词、照片路径和本地任务记录留在风格库。要让模型按新照片重新决定参数，选择「适配此风格」。

命令行也可离线导出。输出目录需已存在，文件名须与同目录的照片区分。已有文件会保留。

```powershell
./scripts/studio.ps1 styles
./scripts/studio.ps1 export-xmp STYLE_ID --output 'C:/Presets/我的海岸.xmp'
```

如果某个风格只调整了曝光、白平衡等逐张设定，导出按钮会禁用。该风格仍可按新照片适配。

Windows 的 Lightroom Classic 15.0.1 已实测导出、导入、应用及恢复。[验收记录](VALIDATION.md)
