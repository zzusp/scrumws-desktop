# plan · 交互会话统一为任务 + queued 自动→processing（Mode B 当执行器）

> 用户 2026-07-12 拍板：① 交互会话 = 新建任务，只保留「新建任务」入口，交互对话的处理逻辑就是任务的处理逻辑；
> ② 新建任务进 queued 后没自动进 processing，修根因。③（澄清）用 Mode B 交互引擎（跨平台）接管
> 新建/manual/交互任务的执行；chat/issue 里的分身(dws)/飞书/GitHub 交互逻辑「早该删」，一并去掉。
> ④ 一轮 claude 收敛(result)后卡片落 **awaiting-human**。

## 症状与根因（ground truth）

- **queued 不自动 processing**：`createTask` 只入队不 spawn（`task-actions.js:319/376` `spawned:false`）。
  queued→processing 的唯一推手是 `restartTask` 里 spawn 的 Windows `.ps1` worker（`task-actions.js:283`，
  `PWSH_EXE`/`manual-worker.ps1`），且只在用户手点「重新发起/确认排队」时触发。调度器去派发器后只剩
  `runner-checker` 守护 job（`scheduler.js:126`），**无任何自动 queued→processing 推手**。Mac 无 `.ps1`
  运行侧 ⇒ 任务永卡 queued。根因 = commit `965b46e` 去派发器时把「怎么跑起来」推给了手动 `.ps1`，跨平台下没有执行器。
- **两套系统各跑各的**：文件式任务生命周期（`createTask`/collect/`.ps1`）与内存式 Mode B 交互会话
  （`session-manager.js`/`/api/session/*`，跨平台、Mac 可跑、goal.md board-interactive-session Round 5–10 已验证）
  互不相通。Mode B 会话不落盘、不进桶。goal.md 末尾待决问「Mode B 并入 task 卡片 vs 独立视图」——本次拍板：**并入**。

## 目标

**让 Mode B 交互引擎成为任务的自动执行器**，桥接内存会话 ↔ 文件任务：任务进 queued 即自动起一个绑定该任务的
Mode B 会话 → processing；一轮收敛 → awaiting-human；从详情继续发消息 = 复用同一 live 会话（进程常驻）多轮，
会话已死（服务重启）则 `--resume` 重挂。一个入口「新建任务」，一套处理逻辑（Mode B）。跨平台。

## 设计

### 桥接：session ↔ 文件任务（新增 `platform/lib/task-runner.js`）

Mode B 会话绑定 taskKey，由 task-runner 订阅会话 emitter，把生命周期写回该任务的 `state.json`/`lease.json`/`meta.json`
（collect.js 读侧不改，桶由 `state.json.state` 决定）：

| 会话事件 | 写任务盘 |
|---|---|
| spawn / `system.init`（running） | state=**processing**；lease `{pid: child.pid, claimedAt, heartbeatAt}`；meta.sessionId=claudeSessionId |
| 运行中每事件 | lease.heartbeatAt 刷新（leaseAlive 保活） |
| `result`（idle，一轮收敛） | state=**awaiting-human**；outcome=null；meta.rounds++/usage/lastRoundAt；lease 保留（进程常驻） |
| `closed`/`error` | state=awaiting-human（outcome 记因）；删 lease |

- 注册表 `taskKey → sessionUiId`（内存 Map）：reply 复用 live 会话。
- 桶完全由 `state.json.state` 决定（processing/awaiting-human），**不靠 lease 活死**——idle-but-alive 也稳在 awaiting-human。
- 服务重启：内存会话没了、claude child stdin 断随之退出 → lease pid 死 → runner-checker 收孤儿标 awaiting-human
  （带 resumeSessionId）→ reply 走 `--resume` 重挂。天然恢复路径。

### task-actions 改动

- `createTask`：写完 state 后，若 initState==='queued' → 调 `startTask(taskKey)` 自动起会话；'plan' 不起（等 approve）。
- `restartTask`/approve：删 `.ps1` spawn，改 `startTask(taskKey)`（awaiting-human/queued → 起会话；plan approve → queued 起会话）。
- `replyToTask`：删 `.ps1 reply-runner`，改 `replyTask(taskKey,msg,model)`：live 会话在 → `sendUserMessage`→processing；
  会话已死 → `--resume meta.sessionId` 重挂 + 发消息。

### 移除 chat/issue 分身(dws)/飞书/GitHub + `.ps1` 残留

| 位置 | 处置 |
|---|---|
| `task-actions.js` restartTask source→`.ps1` 映射（chat/issue/manual worker）+ reply-runner.ps1 | **删**（改走 Mode B） |
| `paths.js` `quotaBlk`/`authBlk` | **删** |
| `collect.js` authBlock 读盘 + `/api/state` authBlock 字段 + chat/issue taskKey 逆推 + source==='chat' humanCc | **删** |
| `jobs/ctx.js` `recheckAuthBlock`（调 `dws auth status`）/`quotaBlockActive`/`exec` | **删**（checker 不再用） |
| `jobs/runner-checker.js` ⓪授权复查 + ①quota-block 跳过 + chat/issue 逆推 | **删**（只留孤儿收纳；含 Mode B 重启孤儿） |
| `server.js` `/api/state` 消费 authBlock | 随 collect 改 |
| `cli-actions.js` `replyCliSession`/`rewindCliSession` 的 `cli-reply-runner.ps1` | 本次**不动**（CLI watchlist=观察终端会话，另一功能；前端「继续」已走 adopt→Mode B） |

### 前端统一（`index.html`/`app.js`）

- 删「新建交互会话」按钮 `newSessionBtn` + `newSessionModal` + 其 JS（req1 只保留新建任务）。
- 新建任务成功且自动起会话 → 返回 `sessionUiId`，跳详情看 live。
- `/api/state` 任务卡补 `mbSessionId`（内存会话 id，无则 null）。
- 任务详情：有 live 会话 → 接 `/api/session/stream?id=` 实时渲染（复用 `renderDetailTab(_,true)`/mb 机制）；
  无（重启后 awaiting-human）→ 退回现有 worker-log 渲染 + composer；reply 一律走 `/api/task/reply`（内部 Mode B）。

## 验证（Mac 真 claude）

- CLI 建 manual 任务（不 plan）→ `/api/state` 该卡 queued→processing（秒级）→ 一轮完 awaiting-human；任务包有 lease/meta.sessionId。
- reply 该任务 → 复用 live 会话续一轮 → processing→awaiting-human。
- plan 任务不自动起；approve 后起。
- 删端点/字段：`/api/state` 无 authBlock；`node --check` 全过；server 正常 boot、scheduler jobs=runner-checker。
- 前端：无「新建交互会话」入口；新建任务自动跑 + 详情 live。
</content>
</invoke>
