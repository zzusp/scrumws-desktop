# 验收报告 · Claude Code 卡片

**结论：全绿（卡片 11/11 + 代理设置 10/10 PASS，2026-07-13 round-1）**

## 交付
1. 任务详情页「任务信息」下方新增 Claude Code 卡片：session / 模型 / token 用量；Pro/Max 账号额外渲染 5 小时 / 7 天滚动窗横向进度条 + 百分比 + 距刷新剩余时间。
2. 设置页新增「网络」区：出网代理 `proxyUrl` 可配（拉取用量经此代理访问 api.anthropic.com），空则回退系统 `HTTP(S)_PROXY`。

## 证据
- 后端：`GET /api/claude-usage` 实测返回
  `{"ok":true,"plan":"max","subscription":true,"fiveHour":{"utilization":23,"resetsAt":...},"sevenDay":{"utilization":66,"resetsAt":...}}`。
- 前端：离屏 Electron 真浏览器 E2E —— 卡片 `browser-e2e-cc-card.cjs` **11/11 PASS**；代理设置 `browser-e2e-proxy-settings.cjs` **10/10 PASS**。
- 代理 `-x` 生效实证：坏代理(59999)必失败 / 好代理 200 / 空回退 env 200。
- 视觉：`round-1/cc-card-manual.png`（MAX 徽章、token `↑18 ↓20.2K 缓存 1.08M`、5h 25% 绿「3h 26m 后刷新」、7d 66% 琥珀「1d 22h 后刷新」）；`round-1/proxy-settings.png`（网络区 + 「已保存」提示）。

## 关键决策（根因存档）
5h/7d 用量无本地持久化，只能打官方 `oauth/usage` 端点。**根因 = 代理非 TLS**（实测：直连 curl 与 Node 都 403 地域拦截，走代理都 200）——curl 自动读 `HTTP(S)_PROXY` env、Node 原生 fetch/https 不读（Node 22 无 `NODE_USE_ENV_PROXY`）。让 fetch 走代理需 undici `ProxyAgent`，但项目零运行时依赖、打包不含 `node_modules` → 用不了，故 `claude-usage.js` 走 `curl`。GUI 启动未必继承 shell 代理 env → 把代理做成**设置页可配**（`-x` 优先，空回退 env）。详见 `plan.md`。

## 复现
```
# 卡片（需真 claude 已登录，真实数据根，零副作用）
node_modules/.bin/electron docs/acceptance/task-detail-claude-usage-card/scripts/browser-e2e-cc-card.cjs
# 代理设置（隔离临时数据根，安全写）
node_modules/.bin/electron docs/acceptance/task-detail-claude-usage-card/scripts/browser-e2e-proxy-settings.cjs
```
