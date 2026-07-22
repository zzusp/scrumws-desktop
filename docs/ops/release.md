# 发版流程（Windows + macOS）

桌面端通过 **GitHub Actions** 打包发布：本地打 tag → CI 并行打 Windows/macOS 安装包 → 自动发 GitHub Release，Release 正文取自 `CHANGELOG.md`。

- 触发：push `vX.Y.Z` tag（或 Actions 页手动 `workflow_dispatch`）
- 产物：Windows `nsis` 安装包；macOS `dmg` + `zip`（arm64 + x64）
- workflow：[`.github/workflows/release.yml`](../../.github/workflows/release.yml)

## 为什么 mac 必须走 CI

macOS 安装包只能在 macOS 上构建，本地 Windows 开发机做不到。所以发版一律走 CI（macOS runner 打 mac、Windows runner 打 win），**本地只负责 bump 版本 + 打 tag + push**，不在本地打包。

## 一次发版（常规路径）

```powershell
# 1. 把本次变更写进 CHANGELOG.md 的 [Unreleased] 段落（Added / Changed / Fixed …）

# 2. 一键发版：finalize changelog + bump package.json + commit + tag + push
npm run release 0.1.1

# 3. push tag 后自动触发 Actions，去这里看构建 & Release：
#    https://github.com/zzusp/scrumws-desktop/actions
#    https://github.com/zzusp/scrumws-desktop/releases
```

`npm run release <版本号>` 做的事（[`scripts/release.mjs`](../../scripts/release.mjs)）：

1. 校验版本号格式、与当前版本不同、工作区干净（tracked 无改动）。
2. 把 `CHANGELOG.md` 的 `[Unreleased]` 段落 finalize 成 `[0.1.1] - <日期>`，顶部补空的 `[Unreleased]`，更新底部 compare 链接。
   - `[Unreleased]` 段落**为空会直接报错**——断开「发了版却没记录变更」的路径。
3. 改 `package.json` 的 `version`。
4. `git commit -m "release: v0.1.1"` → `git tag v0.1.1` → push 分支 + tag。

**发版前先自检（零副作用）**：

```powershell
npm run release 0.1.1 --dry-run   # 只打印将做的改动与 Release 正文，不写文件、不 push
```

## CI 流水线做了什么

`prepare` → `{build-win, build-mac}` 并行 → `publish`：

1. **prepare**（ubuntu）：校验 `tag 版本 == package.json 版本`（不等即 fail，防版本漂移）；`node scripts/extract-changelog.mjs <版本>` 抽 CHANGELOG 段落作 Release 正文；建 **draft** release。
2. **build-win / build-mac**（windows-latest / macos-latest 并行）：Node 22 → `npm ci` → `electron-builder --win` / `--mac` → 把 `*.exe` / `*.dmg` / `*.zip` 直传 draft release。
   - mac 未签名：`CSC_IDENTITY_AUTO_DISCOVERY=false` 关闭签名自动发现。
3. **publish**（ubuntu）：把 draft 转正式并标 `--latest`。

**draft-first** 的意义：任一平台构建失败，release 停在 draft，不会把半套安装包当正式版放出去；修好重跑即可。

## macOS 未签名安装包：用户端首次运行

未做 Apple 代码签名 + 公证，macOS Gatekeeper 会拦。给用户的说明（建议写进 Release 正文或下载页）：

- **图形方式**：在「访达」里右键 `.app` → 打开 → 再点「打开」（只需一次）。
- **命令行方式**（若提示"已损坏，无法打开"）：

  ```bash
  xattr -cr /Applications/ScrumWS.app
  ```

后续若购买 Apple 开发者证书（$99/年），在 `release.yml` 的 build-mac 步骤接入 `CSC_LINK` / `CSC_KEY_PASSWORD` 等 secrets 并开启 notarize，即可免除上述步骤。

## workflow_dispatch 手动补发

tag 已存在但 CI 没跑成（或想重跑）时，去 Actions → Release → Run workflow，填版本号（须与 `package.json` 一致）。draft-first + `--clobber` 上传，可安全重跑覆盖同名产物。

## 版本号约定

遵循 [语义化版本](https://semver.org/lang/zh-CN/) `MAJOR.MINOR.PATCH`：破坏性改动进 MAJOR，向后兼容的功能进 MINOR，修 bug 进 PATCH。tag 一律带 `v` 前缀（`v0.1.1`），`package.json` 的 `version` 不带前缀（`0.1.1`）。

## 更新提示

桌面端启动后通过本地 `/api/app-version` 查询 GitHub 最新正式 Release，结果缓存 6 小时。存在更高版本时，侧边栏底部显示可点击更新提示并打开系统浏览器下载；当前不静默下载或安装。

## 待办 / 已知限制

- **应用图标**：当前托盘用占位 bitmap（`electron/tray.js`），未提供 `build/icon.ico` / `build/icon.icns`，打包会回退默认 Electron 图标。UI 风格定稿后补图标资源到 `build/`。
- **自动安装**：当前只提示并引导用户打开 GitHub Release 手动下载，未接入 `electron-updater` 静默下载或安装。
