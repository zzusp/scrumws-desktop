# round-2：手机端迭代（定时 / CLI 详情 / 按钮 / polish）

**结论：C14–C17 全绿。** 后端 6/6（直接 import relay-verbs 沙箱跑）+ UI 8/8（mock + puppeteer 375×812）。

## 四项改动

| # | 诉求 | 根因 / 现状 | 改法 |
|---|---|---|---|
| #3 | 手机查看 CLI 任务报错 | `verbTaskDetail`（relay-verbs.js:63-66）只读 `runnerRoot`/`archiveRoot` 任务包；CLI 是观察态（`collect-cli.js` 现场合成，**无任务包**）→ 必 `task not found` → 手机详情整页崩（而 `readWorkerLog` 其实认 `cli:`，输出本可展示） | 后端：`verbTaskDetail` 无包时从 `getState()` lifecycle 卡兜底合成详情（`cliDetailFromCard`，prompt=null）。前端：`viewTask` detail 失败但 workerLog 能拉时降级渲染，不整页报错（双保险） |
| #2 | 手机新建也要能定时 | `createTask` 本就支持 `scheduledAt`（本地串，给了强制 plan、到点调度器提升），中继与手机表单没透传 | relay `verbCreateTask` 透传 `scheduledAt`；手机表单加 `datetime-local` 字段，设了时间 → 底部收成单个「定时执行」，提交转 `'yyyy-MM-dd HH:mm:ss'`，toast「已定时到 …」 |
| #4 | 中断/完成/打回按钮过大不好看 | `.actrow .btn{flex:1}` + 全局 44px min-height → 单个动作占满整宽的填充大条 | `.actrow` 右对齐、按钮 `flex:0 0 auto`、38px 高、pill 圆角。实测从「375px 全宽×44px」收成「73×38px」 |
| #1 | 优化迭代手机端页面（总纲） | — | 落地为 #2/#3/#4 + `.fld-hint` 说明样式；按钮/表单视觉收敛。更大范围 polish 待用户指具体点 |

## 验证

### 后端（`scripts/round2-backend.mjs`，沙箱数据根直连 relay-verbs，无云端）

```
PASS #2 createTask ok — taskKey=mobile:20260717231313-139
PASS #2 task.json.scheduledAt 落盘 — 2026-12-31 09:00:00
PASS #2 有定时强制 plan — state=plan
PASS #2 taskDetail 回读 scheduledAt — 2026-12-31 09:00:00
PASS #3 cli: 无卡兜底优雅返回（不抛） — task not found
PASS #3 正常任务 detail 仍 ok — ok
```

### UI（`scripts/round2-ui.mjs`，mock + puppeteer，截图 `round-2/`）

```
PASS #3 CLI 任务详情渲染（有输出块、无错误占位） — holder=0 blk=9
PASS #3 CLI 来源标签 — 处理中,CLI
PASS #4 动作按钮不再全宽（宽 < 视口 60%） — w=73px
PASS #4 动作按钮高度收敛（≤40px） — h=38.0px
PASS #2 新建表单有定时字段
PASS #2 未设时间 = 存为计划/立即执行 — nPlan,nRun
PASS #2 设时间 → 单按钮「定时执行」 — nSchedBtn
PASS #2 提交 → 「已定时到 …」toast — 已定时到 2026-12-31 09:00
```

## 诚实标注

- **#3 CLI 正向合成（有卡→详情）未在活会话上实测**：沙箱无真实 CLI 会话（需 `~/.claude/sessions/<pid>.json` + jsonl，难合成且不污染真实 `~/.claude`）。已覆盖：后端兜底路径安全 + 无卡优雅返回 + async 化不破坏正常 detail；UI mock 用 CLI 任务验证详情渲染。字段映射按 `collect-cli.js:448-484` 真实卡形态逐字段对齐。
- **#2 时区**：`datetime-local` 值按浏览器本地时间，转成的本地串交 `timeutil.parse`（按本机本地时间解释）。手机与机器同时区时正确；跨时区未特别处理（与桌面端同口径）。
