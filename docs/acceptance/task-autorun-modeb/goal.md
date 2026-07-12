# goal · 交互会话统一为任务 + Mode B 自动执行器

设计见 `plan.md`。本文件是多轮实现进度锚点。延续 `board-interactive-session`（Mode B 引擎），
resolve 其待决问「Mode B 并入 task vs 独立视图」= **并入**。

## 总目标

一个入口「新建任务」，一套处理逻辑（Mode B 交互引擎，跨平台）。任务进 queued 自动起绑定会话 → processing，
一轮收敛 → awaiting-human，详情可续多轮。去掉 chat/issue 分身(dws)/飞书/GitHub + `.ps1` 执行残留。

## 重大决策

- **D1**（用户）：交互会话 = 新建任务；只留「新建任务」入口；任务处理逻辑 = Mode B 交互引擎。
- **D2**（用户）：Mode B 接管 新建/manual/交互 任务执行；chat/issue 的 dws/飞书/GitHub + `.ps1` 残留删除。
- **D3**（用户）：一轮 claude `result` 后卡片落 **awaiting-human**（对齐 CLI 会话卡语义）。
- **D4**（技术）：桶由 `state.json.state` 决定，不靠 lease 活死；桥接层 task-runner 单写 state.json。
- **D5**（技术）：CLI watchlist（观察终端会话）不在本次范围——那是 Mode A 观察，另一功能。

## Sub Goal Matrix（唯一进度总表）

| # | Sub Goal | 状态 | 说明 |
|---|---|---|---|
| S1 | 桥接层 task-runner（start/reply + 会话事件写 state.json/lease/meta） | DONE | `lib/task-runner.js`；round-1 |
| S2 | createTask 自动起会话（queued→processing）；restart/approve/reply 改走 Mode B | DONE | `task-actions.js`；round-1 |
| S3 | 移除 dws/飞书/GitHub + quota/auth-block + chat/issue 逆推 + `.ps1` 残留 | DONE | paths/collect/ctx/runner-checker/task-actions；round-1 |
| S4 | 后端 E2E 验证（真 claude on Mac：建→processing→awaiting-human→reply 续轮） | DONE | round-1 matrix 10/10 PASS |
| S5 | 前端统一：删新建交互会话入口；新建任务 = 单入口；详情接 live 会话 | DONE | index.html/app.js；round-2 |
| S6 | 全链路验证（浏览器/端点对拍 + node --check + server boot） | DONE | round-2 浏览器 11/11 PASS |

状态：TODO / DOING / DONE / BLOCKED。用例级证据进 matrix.csv + round-N.md。

## Sub Goal 进展

- **Round 0**：读全两套系统 + 前端路由/详情，定根因（queued 无跨平台执行器）+ 统一设计（Mode B 当执行器）。
  用户答两问（执行范围=接管新建/manual/交互 + 删 chat/issue 残留；落桶=awaiting-human）。落 plan.md + 本文件。
- **Round 1（后端 S1–S4 全 DONE）**：新增 `lib/task-runner.js` 桥接层（会话事件→state.json/lease/meta），
  改 `task-actions.js`（createTask 自动起会话 + restart/approve/reply/cancel 走 Mode B、删 `.ps1`），
  清 dws/飞书/GitHub + quota/auth-block 残留（paths/collect/ctx/runner-checker）。真 claude on Mac E2E **10/10 PASS**
  （见 round-1.md / matrix.csv）：建→processing→awaiting-human、reply 复用/‑‑resume 兜底、plan gate、approve、cancel。
- **Round 2（前端 S5/S6 全 DONE）**：session 携 taskKey（session-manager）+ card 暴露 mbSessionId（collect）+ worker-log
  全局定位 jsonl（logs）；前端删「新建交互会话」入口、`openTaskModal` 按 mbSessionId 分流、新建任务跳实时会话面、
  composer 走 `/api/task/reply`、会话头加任务面包屑 + 返回、删 authBanner。真浏览器 E2E **11/11 PASS**（round-2.md）。
  文档同步：`docs/api/task-ingest.md` + `platform/cli.js` + `README.md`（去「入队不执行」，改「queued 自动执行」）。
  **全部 sub goal DONE。** 剩盲点：工具权限流详情面点击（机制已在 board-interactive-session 验过）、真·重启孤儿收纳全链路。
</content>
