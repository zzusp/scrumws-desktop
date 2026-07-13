# 任务详情页 · Claude Code 卡片（sessionId / 模型 / token + Pro/Max 5h·7d 用量）

## 需求
任务详情页「任务信息」卡片下方新增 **Claude Code** 卡片，展示：
- sessionId、模型、token 用量；
- 若为 Pro/Max 订阅：5 小时 / 7 天滚动窗用量（横向百分比进度条 + 距下次刷新剩余时间）。

## 方案

### 数据源（关键：5h/7d 用量从哪来）
- CC statusline 的 `rate_limits`（`five_hour`/`seven_day`）由运行中的 claude 进程经 stdin 喂入，**桌面平台不常驻 claude 进程、也无任何持久化缓存文件**可读（`~/.claude` 全目录核实无 usage 缓存）。
- 真正数据源 = 官方端点 `GET https://api.anthropic.com/api/oauth/usage`（CC 的 `/usage` 即打它），用 `~/.claude/.credentials.json` 里的 `accessToken` + `anthropic-beta: oauth-2025-04-20` 鉴权。返回 `five_hour.utilization`/`resets_at`、`seven_day.utilization`/`resets_at`。
- 套餐来源 = `.credentials.json` → `claudeAiOauth.subscriptionType`（本机 = `max`）。

### 为何用 curl 而非 Node fetch（根因，非绕路）
**根因 = 代理，不是 TLS 指纹**（实测闭环）：受限地区**直连**该端点被地域拦截返回 **403 `Request not allowed`**——curl `--noproxy '*'` 与 Node 原生栈**都 403**；**走代理**则 curl 与 Node（undici `ProxyAgent`）**都 200**。差别只在：**curl 自动读 `HTTP(S)_PROXY` 环境变量走代理，Node 原生 `fetch`/核心 `https` 不认代理 env**（Node 22 无 `NODE_USE_ENV_PROXY`，那是 24+）。

让 fetch 走代理需 `undici` 的 `ProxyAgent`，但本项目**零运行时依赖**、electron-builder `build.files` 只打包 `electron+platform` 不含 `node_modules` → 生产用不了 undici。故用 curl：各桌面系统自带（Windows 10+ `curl.exe` / macOS / Linux），零依赖，`execFile`（不过 shell，token 不进命令行解析）。

### 代理配置放设置页（不依赖启动方式）
GUI 启动的桌面应用未必继承到 shell 的 `HTTP(S)_PROXY`，故把代理做成**设置页可配**：
- 设置页新增「网络」区，输入 `proxyUrl`（如 `http://127.0.0.1:10808`），存 `runner-config.json`（`writeConfig`），`/api/state.runnerConfig.proxyUrl` 回传回填。
- `claude-usage.js` 的 curl **优先用配置的 proxyUrl（`-x` 显式）**，为空则不传 `-x`、回退 curl 默认的系统 `HTTP(S)_PROXY` env。`execFile` 子进程继承 `process.env` 拿到 env。
- 存代理后 `invalidateClaudeUsage()` 清后端 60s 缓存 + 前端清 `claudeUsage`，令下次拉取立即用新代理。

### 改动
- `platform/lib/claude-usage.js`（新增）：读凭据 → 判订阅 → curl 打 usage 端点（代理 = 配置 proxyUrl `-x` 优先，空回退 env）→ 归一 `{plan, subscription, fiveHour, sevenDay}`；60s TTL 缓存 + 并发去重；失败沿用上次好数据不闪空；导出 `invalidateClaudeUsage()`。
- `platform/lib/collect.js`：`state.runnerConfig` 补 `proxyUrl`（供设置页回填）。
- `platform/server.js`：`GET /api/claude-usage`（独立端点，不塞热路径 `/api/state`）+ `POST /api/config/proxy`（存 proxyUrl，校验 `http(s)://`，清 usage 缓存）。
- `platform/public/app.js`：
  - `renderTaskSide` 内「任务信息」的 `模型` 行移入新卡片（避免重复）；
  - 新增 `claudeCodeCardHtml`（session/模型/token + 用量区）、`ccUsageBarHtml`、`compactTokens`、`fmtResetIn`；
  - token 分支：有 usage 显 `↑in ↓out 缓存X`；CLI 会话显「不计量」；分身无快照显「—」；
  - 前端 60s 缓存 + `refreshClaudeUsage` 懒加载，到货回调重画卡片（无限重画由 TTL 早返回阻断）；
  - 设置页代理：`syncProxyInput` 回填（编辑中不覆盖）+ 保存按钮 → `/api/config/proxy`，成功清前端 usage 缓存。
- `platform/public/index.html`：`.cc-bar*` / `.cc-usage*` 进度条样式（≥80% 红 / ≥50% 琥珀 / 否则绿，对齐 statusline 配色）+ 设置页「网络」区（proxyUrl 输入 + 保存）。

## 验证
真浏览器 E2E（离屏 Electron 驱动真 index.html+app.js）：
- `scripts/browser-e2e-cc-card.cjs`（真实数据根，scheduler 撞桌面应用锁自动 disabled）→ **11/11 PASS**，截图 `round-1/cc-card-manual.png`（MAX 徽章 + 5h 绿 / 7d 琥珀 + 距刷新剩余）。
- `scripts/browser-e2e-proxy-settings.cjs`（隔离临时数据根，安全写）→ **10/10 PASS**，截图 `round-1/proxy-settings.png`（网络区 + 已保存提示）。
- 代理 `-x` 生效实证：坏代理必失败、好代理 200、空回退 env 200（`round-1.md` 记录）。
