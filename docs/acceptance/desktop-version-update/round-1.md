# Round 1

## 结果

- PASS：`node docs/acceptance/desktop-version-update/scripts/verify-app-version.mjs`
  - 覆盖版本解析与比较、更新可用、同/低版本、非法 tag、断网降级、6 小时缓存与页面结构。
- PASS：`node --check platform/lib/app-version.js`、`platform/server.js`、`platform/public/app.js`。
- PASS：隔离端口 `18973` 实跑服务，`GET /api/app-version` 返回 `currentVersion=0.1.0`；GitHub 尚无正式 Release 时返回 `ok=false` 且不误报更新。
- PASS：浏览器回归，侧边栏版本入口可见，文本 `v0.1.0`，无浏览器控制台错误。
- PASS：`npm run dist:win`。
  - 安装包：`dist/ScrumWS-0.2.0-win-x64.exe`
  - 大小：99,726,351 bytes
  - SHA-256：`3266E897E6207F0DC5C109D5EA94BF492AE7BA0CB38BAE4FE3B3E4373E5D5894`
  - 独立回读：`dist/win-unpacked/resources/app/package.json` 的版本为 `0.2.0`，入口为 `electron/main.js`。

## 未完成

- GitHub Actions 的 Windows/macOS 构建和正式 Release 需在合并、推送 `v0.2.0` tag 后验证。
