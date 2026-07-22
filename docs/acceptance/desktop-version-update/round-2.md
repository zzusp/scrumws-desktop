# Round 2

## 发布过程

- 首轮 run `29913609210`：Windows `npm ci` 因 `ECONNRESET` 失败；macOS 构建成功但 Bash 3 不支持 `mapfile`，上传返回 127。
- 第二轮 run `29914264572`：Node 22 与 Bash 3 上传修复生效，Windows 完整构建上传；macOS `npm ci` 因 `ECONNRESET` 失败。
- 第三轮 run `29914924716`：依赖安装有限重试生效，macOS 首次失败后重试成功；prepare、Windows、macOS、publish 全部 PASS。

## 最终证据

- Release：`https://github.com/zzusp/scrumws-desktop/releases/tag/v0.2.0`
- 状态：`isDraft=false`、`isPrerelease=false`，发布时间 `2026-07-22T11:21:58Z`。
- latest API：`tag_name=v0.2.0`，5 个产物均使用正式 `/download/v0.2.0/` URL。
- Windows：`ScrumWS-0.2.0-win-x64.exe`。
- macOS arm64：`ScrumWS-0.2.0-mac-arm64.dmg`、`.zip`。
- macOS x64：`ScrumWS-0.2.0-mac-x64.dmg`、`.zip`。
