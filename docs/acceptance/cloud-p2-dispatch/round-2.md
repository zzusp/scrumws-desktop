# round-2 · C13b 修复（决策 15 延迟落地）+ 与 #67 合并

**结论：14/14 PASS，C13b 从 FAIL 转 PASS。** 真 claude 端到端验证（`scripts/e2e-real.mjs --run`）。

日期：2026-07-18

---

## 1. 本轮改了什么

round-1 唯一 FAIL 是 C13b：决策 15 的 agent 单轮内自我声明完成被拒。根因（round-1 §4）有两处：
`completeTask` 只认 `awaiting-human`，而 agent 调用时任务仍 `processing`；且即便放宽，`task-runner.js`
的 `result`/`closed` 处理器**无条件**写 `awaiting-human`，会把 `done` 覆盖回去。

采用 round-1 §4 的**候选 1（延迟落地）**：

- **`task-actions.js` `completeTask`**：`resolvedBy='agent'` ∧ `state==='processing'` 时**不拒**——落
  `outcomeDetail.agentRequestedDone=true` 标记，返回 `{ok:true, deferred:true}`，状态仍 processing。
- **`task-runner.js` `convergeAwaitingOrDone(taskKey)`**（新助手，`result`/`closed` 共用）：本轮收敛时，
  命中标记 → 落 `done(by=agent)` 并消费标记；否则 → `awaiting-human`（原行为）。`closed` 紧随 `result`：
  已是 `done` 直接返回，不覆盖。会话 `error` 不走这里（error 优先，不认预声明）。

**为什么忠于「状态机结构不变」**：终态转换仍发生在**本轮 `result` 收敛的边界**——与「人在 awaiting-human
点完成」同一时刻，只是判定人从「人点」换成「agent 的预声明」。没有新增转换、没有新状态。

## 2. 附带：与 #67（决策 14）合并，统一 links.js

跑 P2 期间 #67 合入 master，双方都建了 `platform/lib/cloud/links.js`：本分支用**单文件 map**，#67 用
**目录+每 intent 一个文件**。**采用 #67 的目录格式**（它已合、`reconcile.js` 依赖 `readCloudLinks` 读该目录），
把 connector 的链接读写改成每-文件操作（`readLink`/`writeLink`/`deleteLink`），删掉死代码 `readLinks`。

**e2e 脚本连带修**：`e2e-real.mjs` 的 `links()` 助手原读旧单文件 `links.json`，格式切换后读空 →
`ownKey=undefined` → 下游 `.replace(undefined)` 崩（本轮首次重跑的 7/11 就崩在这）。改为读目录后恢复。
**这是测试 fixture 滞后于格式决策，非生产 bug**——生产侧 connector 写的、#67 reconcile 读的都是目录格式。

## 3. 14/14 全绿（真 claude + 真一次性库 + 真沙箱）

```
PASS C01 迁移 001+002：task 有 auto_run/dispatch/dispatched_at/reject_reason，origin 未删
PASS C02 真 cloud/src/server.js 起 8791（非 mock）
PASS C03 bootstrap 两用户 + 各自登录（同 workspace）
PASS C04 enroll→online + identity.ownerUserId=会话用户（owner-only 判据）
PASS C05 白名单默认空 → 云端任务被本地拒收，云端见 rejected+原因
PASS C06 白名单外 cwd 被拒（work-evil 与白名单 work 前缀相邻，不误放行）
PASS C07 白名单内+owner-only+自己派+autoRun → autoExec 直接跑（不落 plan）
PASS C08 owner-only+别人派+autoRun → 落 plan 等确认（createdBy≠机器主人）
PASS C09 自然幂等：delivered 意图不再取件，每意图恰一个本地任务
PASS C10 决策15 注入：spawn 命中 --disallowedTools AskUserQuestion + SCRUMWS_TASK_KEY/API_BASE
PASS C11 awaiting-human→done(by=agent) 且对账把 by=agent 上行云端
PASS C12 取消已下发意图 → 409 ALREADY_DISPATCHED（已下发撤回是 P3）
PASS C13a 云端派的任务真在机器上执行代码：真 claude 数出 3 个文件
PASS C13b ★ 真 agent 自我声明完成 → done(by=agent)（round-1 此项 FAIL，本轮修复）
```

收尾：一次性库 `scrumws_p2_e2e` 已 `DROP WITH(FORCE)`；生产 `scrumws`（1用户/1机器/无 P2 列）、
`claude_center`/`novel_writer`、8790、8799 全程未碰（8799 探活 HTTP 200）。

## 4. 已知边界（不阻断，记录）

- agent 声明完成后若任务被 `to-plan` 再重跑，`agentRequestedDone` 标记会残留在 `outcomeDetail`——
  极不寻常的操作序列，未处理。真出现时下一轮收敛会误落 done，人可 `uncomplete` 撤回。
