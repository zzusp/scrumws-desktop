# round-1 · 2026-07-13

## 环境
- 桌面应用（旧代码）跑在 8799；本轮验证用离屏 Electron 起独立实例（新代码）：卡片测用真实数据根 `~/.scrumws`（scheduler 撞 8799 锁 → disabled-lock，只读零副作用），代理测用隔离临时数据根。
- 真 claude 已登录（`~/.claude/.credentials.json` → subscriptionType=max）；env `HTTPS_PROXY=http://127.0.0.1:10808`。

## A. 后端端点
`GET /api/claude-usage`（curl 经代理打 `api.anthropic.com/api/oauth/usage`）：
```
{"ok":true,"plan":"max","subscription":true,"tier":"default_claude_max_5x",
 "fiveHour":{"utilization":23,"resetsAt":"2026-07-13T16:09:59+00:00"},
 "sevenDay":{"utilization":66,"resetsAt":"2026-07-15T10:59:59+00:00"}}
```

## B. 代理 `-x` 生效实证（隔离数据根写 runner-config.json.proxyUrl 后调 getClaudeUsage）
| proxyUrl | 结果 | 说明 |
|---|---|---|
| `http://127.0.0.1:10808` | OK 5h=33% | 配置代理生效 |
| `http://127.0.0.1:59999` | ERR curl-failed | 坏代理必失败 = 证明 `-x` 真被应用（未回落 env） |
| 空 | OK 5h=33% | 回退系统 `HTTPS_PROXY` env |

## C. 卡片 E2E — `browser-e2e-cc-card.cjs` → 11/11 PASS
卡片存在且紧邻「任务信息」下方 / session·模型·token 三行 / MAX 徽章 / 5h+7d 两条进度条（百分比+填充宽度+距刷新）/ manual 计量真实读数 / 分身无快照显「—」/ CLI 显「不计量」。
截图 `round-1/cc-card-manual.png`：token `↑18 ↓20.2K 缓存 1.08M`、5h 25% 绿「3h 26m 后刷新」、7d 66% 琥珀「1d 22h 后刷新」。

## D. 代理设置 E2E — `browser-e2e-proxy-settings.cjs` → 10/10 PASS
「网络」区 + proxyUrl 输入框就位 / 保存落 runner-config.json + state 回传 + 回填 / 非法地址 400 拒 / 清除回退。
截图 `round-1/proxy-settings.png`：网络区输入 `http://127.0.0.1:10808` + 绿色「已保存 · 用量将经此代理拉取」。

## 结论
matrix C1–C16 全 PASS。
