# 统一任务来源处理（拆掉 source 特判，按状态走）

> 落实 README「任务来源不变量」：`source`（cli / manual / api …）只是来源元数据，所有来源的任务共享同一套
> 状态机与处理逻辑。本文是收敛工作的前置分析 + 设计 + 子目标拆解（开工快照，不回头维护）。

## 现状根因

CLI 会话与其它来源任务的**唯一物理差别**：CLI 会话是「被旁观」的——数据源是 CC 官方 jsonl，靠 `cli-watchlist.json`
里一条 sid 元数据出卡（`collect-cli.js`），**没有 `runner-state/<key>/` 任务包**；而 manual/api 任务有任务包
（task.json + state.json + meta.json）。所有任务动作（complete/uncomplete/toPlan/archive/rename/edit）都读写任务包的
`state.json`，CLI 没有包 → 于是历史代码到处按 `startsWith('cli:')` 分叉到「watchlist 平行管理面」或直接拒绝。

## 设计：物化（materialize）

给 CLI 会话补上任务包，让平行管理面收敛成同一条路径：

- **`materializeCliTask(taskKey, {state})`**（task-actions.js）：从 watchlist 找全量 sid → `readCcSessionForAdopt` 取
  会话 cwd/model/gitBranch/messages → 写 `runner-state/cli__<sid8>/`（task.json `source:'cli'` 仅元数据、title 取首条
  用户消息、prompt 取末条用户消息作续跑起点；meta.json `sessionId=全量 sid` 供 `--resume`；state.json 给定 state）→
  **从 watchlist 摘除该 sid**（去重：collect-cli 不再出卡，改由 collect.js 按包出卡）。终端仍占用该会话时拒绝
  （复用 `/api/session/adopt` 的 guard：两个 claude 抢同一 session 会撞车 → [[modeb-adopt-terminal-collision]]）。
- **package-first 路由**：所有原本 `startsWith('cli:')` 的分叉改判「**有没有任务包**」——`hasTaskPackage(taskKey)`
  （logs.js）/ `!fs.existsSync(taskDir)`（task-actions）：有包走统一路径、无包才回落 watchlist。未物化的 CLI 行为不变、
  非 CLI 不受影响、物化后的 CLI 走统一路径。

## 特判点清单（grep `startsWith('cli:')` / `isCli` / `source==='cli'`）

| 位置 | 类别 | 处置 |
|---|---|---|
| task-actions moveTaskToPlan | 行为·拒绝 | ✅ 物化落 plan |
| task-actions complete/uncomplete | 行为·拒绝 | ✅ package-first + 无包回落 watchlist |
| server complete/uncomplete 路由 | 行为·分派 | ✅ 直接调 completeTask/uncompleteTask（内部分派）|
| logs rename/archive/unarchive | 行为·分派 | ✅ package-first（`hasTaskPackage`）|
| app.js toPlanBtn（卡片 + 详情）| 展示·门控 | ✅ 去掉 isCli 门控 |
| collect-cli CC_PROJECTS / cli-actions | 环境 | ✅ 加 `SCRUMWS_CC_PROJECTS` 覆盖（验证隔离）|
| task-actions replyToTask → replyCliSession | 行为·分派 | ⏳ 待办：物化后走 Mode B `--resume`（reply UI 现对 cli 隐藏，不 broken）|
| app.js canReply/reply UI（1064/1105/3146）| 展示·门控 | ⏳ 待办：随 reply 统一放开 |
| app.js cancel 按钮（446/1534）| 展示·门控 | ⏳ 待办：物化 CLI 在 processing 应可中断（现隐藏=限制非 broken）|
| app.js rewind（1949/1998）| 行为·分派 | ⏳ 待办：rewind 统一（现仍走 rewindCli，jsonl 在、不 broken）|
| app.js archived「从看板移除」（454/1525）| 展示·分派 | ⏳ 待办：物化后归档走包，未物化仍 watchlist remove |
| task-actions deleteTask cli guard（79）| 行为·拒绝 | ⏳ 低优：物化 CLI 有 sessionId 本就拒删→改归档，guard 冗余无害 |
| logs worker-log 路由（388）| 行为·分派 | ⏳ 待办：详情 worker-log 源特定，物化后应按包/Mode B |
| collect.js cliCount(273)/platformSids(305) | 展示/聚合 | 273 展示保留；305 待复核（物化 CLI 有 sessionId 但被排除出 platformSids）|

## 子目标矩阵

| # | 子目标 | 状态 |
|---|---|---|
| 0 | `SCRUMWS_CC_PROJECTS` 覆盖（验证隔离） | ✅ done |
| 1 | 终态动作统一：materialize + toPlan/complete/uncomplete/archive/unarchive/rename/edit 按包统一 | ✅ done（17/17）|
| 2 | reply 统一：物化 CLI 走 Mode B `--resume`；放开 reply/cancel UI 门控 | ⏳ |
| 3 | rewind / worker-log / archived-remove 统一按包 | ⏳ |
| 4 | 清扫剩余 UI isCli 门控 + deleteTask guard + platformSids 复核 | ⏳ |

## 风险 / 盲点

- **去重**：物化必须摘 watchlist，否则 collect.js（包）+ collect-cli（watchlist）出两张卡。已验证：摘除后 collect 只出 1 张（source cli）。
- **--resume 定位**：task.cwd 取会话原 cwd，approve 时 startTask 在该 cwd `--resume`，claude 才能在对应项目目录找到 session。cwd 已失效的会话续跑会失败（属既有 --resume 局限，非本次引入）。
- **终端占用**：物化 guard 复用 adopt 的 att 判据；终端没关就拒绝。
- **验证局限**：`readAttachedSessions` 读真实 CC sessions 注册表，沙箱里假 sid 恒未占用——「终端占用拒绝」分支未单测（逻辑与 adopt 同源，adopt 已线上验证）。
</content>
