# 更新日志

本项目所有值得记录的版本变更都记在这里。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

发版流程见 [`docs/ops/release.md`](docs/ops/release.md)。发版时把本次改动写进下面的 `[Unreleased]`，再跑 `npm run release <版本号>`。

## [Unreleased]

### Added
- GitHub Actions 发版流水线：`vX.Y.Z` tag 触发，并行打包 Windows(nsis) + macOS(dmg/zip, arm64+x64)，自动读 `CHANGELOG.md` 对应段落填 Release 正文。

## [0.1.0] - 2026-07-15

### Added
- 桌面端首个基线版本：Electron 托盘常驻壳 + 进程内调度平台，从 `dashboard/` 迁移而来，平台核逻辑与磁盘契约不变。
- 任务执行走 Mode B 交互会话引擎（`session-manager` 直起 `claude` stream-json，跨平台）。

[Unreleased]: https://github.com/zzusp/scrumws-desktop/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/zzusp/scrumws-desktop/releases/tag/v0.1.0
