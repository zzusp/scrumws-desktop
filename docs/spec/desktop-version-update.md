# 桌面端版本展示与更新提示

## 目标

- 桌面端常驻显示当前应用版本。
- 启动后检查 GitHub 最新正式 Release；存在更高版本时给出可点击提示。
- 点击提示由 Electron 既有外链处理交给系统浏览器，进入 Release 下载页。
- 发布 `0.2.0`，Windows 与 macOS 产物仍走现有 draft-first GitHub Actions。

## 现状

- 当前版本只存在于 `package.json`，界面没有展示。
- 发布源是 `zzusp/scrumws-desktop` 的 GitHub Release。
- 应用未接入 `electron-updater`，发布文档要求用户手动下载。
- Electron 已统一把外部 HTTPS 链接交给系统浏览器。

## 方案

新增独立的应用版本模块，读取 `package.json.version`，通过 GitHub Releases API 查询 `releases/latest`。后端提供只读 `/api/app-version`：

- 返回当前版本、最新版本、是否有更新、Release URL 和检查时间。
- 仅接受严格的 `vMAJOR.MINOR.PATCH` 正式版本；逐段数值比较。
- 查询结果缓存 6 小时，避免看板刷新造成 GitHub API 限流。
- 网络失败时仍返回当前版本，界面保持版本展示，不误报更新。

侧边栏底部新增版本入口：默认显示 `v<当前版本>`；有更新时显示“发现 v<最新版本>”，并链接 Release 页面。

## 验证

- 模块级 fixture：无更新、有更新、旧 Release、非法 tag、网络失败、缓存复用。
- 本地启动服务，读取 `/api/app-version` 并检查页面结构。
- 本地 Windows 打包，确认安装包生成且版本/文件名为 `0.2.0`。
- 发版后回查 GitHub Actions、Release 状态与全平台产物。
