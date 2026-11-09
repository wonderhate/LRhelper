# LRhelper · LR Codex Studio

A native Lightroom Classic workbench for planning color edits with Codex. Generate a target-aware grade from text, a reference image, or automatic analysis. Review the settings, preview a new virtual copy rendered by Lightroom, and restore that copy from its baseline snapshot.

[Download for Windows](https://github.com/wonderhate/LRhelper/releases/latest) · [Chinese README](README.md) · [GitHub Packages](https://github.com/wonderhate/LRhelper/pkgs/container/lrhelper)

## Quick start

1. Install Node.js 22 or later on Windows x64 and sign in to the Codex CLI. The 1.1 preview and recovery workflow was tested on Lightroom Classic 15.0.1.
2. Extract the Release ZIP and run `./Install.ps1`. The default location is `%LOCALAPPDATA%\LR Codex Studio`.
3. In Lightroom Classic, use File → Plug-in Manager to add both bundled plug-ins from `current/plugin`. Disable older entries with the same name and restart Lightroom after adding the new versions.
4. Run `current/scripts/start-studio-host.ps1` and open LR Codex Studio from File → Plug-in Extras. The native interface uses Chinese labels.

LRhelper supports multi-turn editing, saved styles, fixed XMP export, adaptive batches of 2–8 photos, and optional Subject and Sky masks for single-photo edits. Skin protection limits red and orange HSL changes when skin is visible or uncertain. The storage tab shows local usage, exports backups, and restores records from the trash.

Jobs, reference copies, and logs are stored locally. The target render and optional reference are passed to the configured Codex runtime when a plan is generated. Lightroom applies preview edits to a verified new virtual copy.

See the [Windows guide](docs/studio/RELEASE-WINDOWS.zh-CN.md) for configuration and rollback. The optional OCI package at `ghcr.io/wonderhate/lrhelper:1.1.0` mirrors the same ZIP and checksum. Development and test commands are in [CONTRIBUTING.md](CONTRIBUTING.md).

LRhelper incorporates [Automaat/lightroom-mcp](https://github.com/Automaat/lightroom-mcp) under the [MIT License](LICENSE). Its reference workflow was informed by [Ashla](https://github.com/JeremySNR/ashla-lightroom).
