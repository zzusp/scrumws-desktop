# cloud P2（云端下发队列 / 意图下行）· round-1 验收记录

**结论：18/19 PASS，唯一 FAIL = C13b「真 agent 单轮内自我声明完成」——这是决策 15 的一个真实端到端缺陷（时序卫语句），
非我引入、非环境问题，已用真 claude 亲跑取到铁证，根因 + 候选修复见 §4。其余（迁移、真云端下发、白名单拒收、
owner-only 闸门、幂等、决策 15 的注入与上行、真 claude 在机器上执行代码）全部实证 PASS。**

- 日期：2026-07-18
- 契约：`docs/spec/cloud-p2-dispatch-contract.md`；权威设计：`docs/spec/cloud-control-plane.md` §9 决策 8/9/10/13/14/15/16
- 状态总表：`matrix.csv`（状态以它为准）
- 脚本：`scripts/e2e-real.mjs`（真云端 + 真 claude，本轮主证据）；`../cloud-p2/scripts/verify-local-dispatch.mjs`（假云端 + stub，补丢包/off·on/门铃）
- 全程日志：`round-1/e2e-real.log` + `round-1/e2e-real-results.json`

---

## 0. 环境与隔离（红线全程守住）

| 项 | 值 | 说明 |
|---|---|---|
| 一次性验收库 | `scrumws_p2_e2e`（001+002），用完 `DROP … WITH (FORCE)` | 绝不就地用生产 `scrumws`；`DATABASE_URL` 只经 `process.env` 注入，未进任何源码/文档/日志/提交 |
| 真云端 | `127.0.0.1:8791`，真 `cloud/src/server.js`（fastify+pg+@fastify/static） | **不是 mock**；不设 `CLOUD_INSECURE_COOKIE`→绊线 off、下行放行；Node 客户端手工带 cookie |
| 本地沙箱看板 | `127.0.0.1:8797`，`SCRUMWS_DATA_ROOT=.sandbox/p2e-stub`（phase1）/`.sandbox/p2e-real`（phase2） | **不是 8799** |
| 用户真实桌面 app | `127.0.0.1:8799` | 全程只读探活，一次没碰；收尾 `GET /api/state` → 200 |
| 生产云端 | **远端** `115.159.161.47:8790` | 全程不碰（本地 8790 本就无服务）；只连 127.0.0.1:8791 的一次性云端 |

**收尾独立只读复核（非工具回执，见 §6）**：一次性库已删；生产 `scrumws` = `{app_user:1, machine:1}`（与契约基线一致）、
`task` 表**无** P2 列（`auto_run` 列数=0 → 002 从未对生产执行）；`claude_center`/`novel_writer` 未碰；8799 仍 200；零残留进程。

---

## 1. 前置 + PHASE 1：真云端 + stub claude（`e2e-real.mjs --run`）

> stub claude 只挂子进程 PATH（不改系统 PATH、不拉起真 claude），用于**确定性**验证下发/闸门/注入，
> 不烧 token。真云端 + 真 DB + 真 connector 全链在跑。

```
PASS C01 迁移 001+002 落地：information_schema 命中 task 列 = auto_run, dispatch, dispatched_at, origin, reject_reason（origin 未删）
PASS C02 真 cloud/src/server.js 起在 8791：GET /api/health 200 · GET / → 200 <!DOCTYPE html>…（index.html，非 mock）
PASS C03 bootstrap 两用户 + 各自登录：A=孙鹏(59e1b6d6…) · B=同事乙(5993954b…)（同 workspace scrumws）
PASS C04 enroll→机器 online（真心跳）+ identity.ownerUserId=会话用户：machineId=a5576f35… status=online owner=孙鹏 ownerUserId=59e1b6d6…
```

### 剧本 3（最硬防线）· C05/C06 白名单拒收

```
PASS C05 白名单默认空 → 云端派活被本地拒收，云端见 rejected+原因，本地零任务零 link
     云端 dispatch=rejected rejectReason="工作目录不在本机白名单：…\.sandbox\p2e-stub\work" · 本地 links={} runner-state=[]
PASS C06 白名单外 cwd 被拒（work-evil 与白名单 work 前缀相邻，未被误放行）
     rejectReason="工作目录不在本机白名单：…\.sandbox\p2e-stub\work-evil"
```
这条是**唯一不依赖云端诚实**的防线：云端只递交 `cwd`，判定全在本地 `cwd-allow.js`。空白名单硬拒一切，
且相邻前缀（`work` vs `work-evil`）没被裸 `startsWith` 误放行（补分隔符生效）。

### 剧本 4+5 · C07/C08 落地 + owner-only 闸门

```
PASS C07 白名单内+owner-only+自己派+autoRun → autoExec 直接跑（不落 plan），云端 delivered+回填 localTaskKey
     云端 dispatch=delivered localTaskKey=cloud:20260718014855-395 · 本地 state=processing（≠plan）
PASS C08 owner-only+别人(B)派+autoRun → 落 plan 等人确认（云端上报 createdBy=B ≠ 机器主人 A）
     intent.createdBy=B · 本地 state=plan · 云端 dispatch=delivered
```
C07 走通了**真云端派意图 → 本地 connector 取件 → 闸门算 autoExec → createTask(plan=false) → ack 回填 localTaskKey**全链。
C08 证 owner-only 判据真的用「云端上报的 createdBy vs 本机 ownerUserId」比对：同一台机、同样 autoRun，A 派直接跑、B 派落 plan。

### 剧本 6/7/取消 · C09-C12

```
PASS C09 自然幂等：等 2 轮 tick，runner-state 数不增、link 无重复 taskKey、iOwn.localTaskKey 恒 = cloud:20260718014855-395
PASS C10 决策15：2/2 次真云端派的自动执行任务 spawn 命中 --disallowedTools AskUserQuestion(挂 bypass) + 注入 SCRUMWS_TASK_KEY/API_BASE
PASS C11 awaiting-human→done(by=agent) 且对账把 by=agent 上行到云端 task_history（云端 status.state=done、history 末条 by=agent）
PASS C12 取消已下发意图 → HTTP 409 ALREADY_DISPATCHED dispatch=delivered
```
> ⚠ C11 只证「**若**任务已 awaiting-human，agent 完成 + 上行都对」——它是决策 15 的**上行半**。
> 真 agent 单轮里能否走到 awaiting-human 再完成，是另一回事，见 §2 的 C13b（那里 FAIL）。C11 与 block-B 的 R9 一样，
> 都**手动先把 state 摆成 awaiting-human** 再调 complete，所以掩盖了真实时序问题——这正是「自写期望值全绿≠修对」的坑。

---

## 2. PHASE 2：真 claude —— P2 首次让云端指令真在机器上执行代码

沙箱2（真 claude，不 stub）enroll 到真云端、白名单指向 `…\p2e-real\work`（内置 3 个文件）、owner-only。
A 在**真云端**派最小任务：`{title:'真跑·数文件', prompt:'数一下当前工作目录下有几个文件…', cwd:work, autoRun:true, model:haiku-4-5}`。

### C13a（剧本 8 核心）· PASS —— 真 claude 真在机器上执行了代码

```
PASS C13a 云端派的任务真在机器上执行代码：真 claude 在白名单目录跑起来，数出 3 个文件
     本地 taskKey=cloud:20260718015014-382 · 迁移轨迹=[0s]processing→[26s]awaiting-human
     claude 输出="任务完成。答案：**当前工作目录下有 3 个文件**。" · 云端对账 status.state=awaiting-human
```
CC transcript 铁证（`~/.claude/projects/…-p2e-real-work/1936282f-….jsonl`）：
```
TOOL PowerShell: Get-ChildItem -File | Measure-Object | … Count   → RESULT: 3
TEXT: 当前工作目录下有 3 个文件。
```
**云端一条指令 → 真 claude 在指定机器的指定目录里真跑了 PowerShell、数出真实文件数、状态经对账回到云端。**
决策 13 绊线、决策 10 白名单、决策 8 闸门这几道闸之后，P2 第一次把「云端建的任务」变成「机器上真执行的代码」——达成。

### C13b（剧本 8 · 决策 15）· FAIL —— 真 agent 单轮内**无法**自我声明完成

```
FAIL C13b 真 agent 单轮内自我声明完成 → 被 completeTask 的 awaiting-human 卫语句拒（当时 state=processing），
     任务卡 awaiting-human 永不 done。终态 state=awaiting-human resolvedBy=undefined
```
同一条 transcript 的下一步铁证（agent **确实**按完成协议调了本机端点，拿到 400）：
```
TOOL PowerShell: Invoke-RestMethod -Method Post "$env:SCRUMWS_API_BASE/api/task/complete?taskKey=$env:SCRUMWS_TASK_KEY&resolvedBy=agent"
RESULT: Exit code 1  Invoke-RestMethod: { "ok": false, "error": "只有 awaiting-human 任务可人工确认完成（当前 processing）" }
TEXT: 任务完成。答案：**当前工作目录下有 3 个文件**。
```
根因与候选修复见 §4。**这不是 haiku 不听话**——它一字不差地执行了协议里的命令；是端点在那一刻拒了它。

---

## 3. 补充证据：block-B（假云端 + stub）覆盖真云端复现不了的丢包/off·on/门铃

真云端不会「ack 丢包」「一台机上瞬时切 off/on」，这些确定性/注入型用例由 `../cloud-p2/scripts/verify-local-dispatch.mjs`
覆盖（本轮实跑 **15/15 PASS**，摘录）：
```
PASS R4  同一 intentId 拉两次（首 ack 被注入 500 丢包）→ 只建一个任务、凭 link 重 ack：ack×2（500→200）localTaskKey 恒 cloud:…-696、任务目录数 4→4
PASS R5  闸门 off → 自己派的 autoRun 也落 plan
PASS R6  闸门 on → 别人派的 autoRun 也直接跑
PASS R10 门铃：pendingIntents=0 时 connector 跳过 GET /api/machine/intents（等 2 轮 tick 增量=0）
```
> R4 是幂等的**丢包路径**（C09 只覆盖了自然路径「delivered 不再被取件」）；两者合起来才完整。

---

## 4. 唯一 FAIL 的根因 + 候选修复（决策 15 自我声明完成，端到端不生效）

### 4.1 根因（三处约束在真跑时对不上）

1. **完成协议假设** agent 能自我声明完成：`completion-protocol.js` 让 agent `POST /api/task/complete?resolvedBy=agent`。
2. **completeTask 的卫语句** 只接受 `awaiting-human`（`task-actions.js:137`：`if (state.state !== 'awaiting-human') return {ok:false,…}`）。
3. **runner 生命周期**：任务在 agent **整个能执行代码的时段内都是 `processing`**（`markProcessing`），只有 agent 这一轮
   结束、CC 发 `result` 事件后，`task-runner.js:122` 才把它翻到 `awaiting-human`——**而单轮 `-p` 的 agent 此时已经跑完、无法再动作**。

于是：agent 在本轮里调 complete（state=processing）→ 被 2 拒（400）→ 本轮结束 → 3 翻 awaiting-human → **没有人再来完成它** →
永远停在 awaiting-human。决策 15 想消掉的「等人来判」反而必然发生。

**为什么 C11/block-B R9「PASS」却没暴露**：两处都是测试脚本**手动**把 state 先改成 `awaiting-human` 再调 complete——
绕开了真实时序。这是典型的「自写期望值把 bug 写成期望」的假绿（记忆 `false-green-self-written-expectations`）。
只有 §2 用真 claude 单轮实跑才现形。

**附加坑（影响修法选择）**：`task-runner.js:122/126` 的 `result`/`closed` 处理器**无条件**写 `awaiting-human`，
不看当前 state。所以即便放宽 completeTask 让它在 processing 时落 `done`，紧随其后的 `result` 事件也会把 `done` 覆盖回 `awaiting-human`。
单纯「放宽 completeTask」不够。

### 4.2 候选修复（≥3，含排除理由；均触及承重墙 `task-runner.js`，需契约作者拍板——契约 §8.2 明写「状态机一个字节不改」）

- **候选 1（推荐）· 延迟落地**：agent 在 `processing` 时调 complete?resolvedBy=agent → 不拒，落一个「agent 已声明完成」标记
  （如 `state.json` 的 `outcomeDetail.agentRequestedDone=true`）并回 `ok:true`；`task-runner.js` 的 `result` 处理器在**将翻
  awaiting-human 前**检查该标记：命中则改落 `done`(by=agent) 而非 awaiting-human。语义上「终态转换仍发生在本轮收敛的边界」，
  与「人在 awaiting-human 点完成」同一时刻发生，只是判定人换成 agent 的预声明。改 2 文件（`task-actions.js` + `task-runner.js`）。
- **候选 2 · 放宽 + 防覆盖**：completeTask 对 resolvedBy=agent 接受 `processing` 直接落 done；同时在 `result`/`closed` 处理器加
  「已是终态就不覆盖」的卫。排除理由：会话进程本轮还在吐 token 时就落 done，语义别扭（done 早于本轮真正结束），且防覆盖卫仍要加，
  比候选 1 更侵入 runner 不变量。
- **候选 3 · 末条消息哨兵**：改协议为「在最后一条回复里放固定哨兵（如 `[[TASK-DONE]]`）」；`result` 处理器扫末条 assistant 文本，
  命中哨兵则落 done(by=agent)。排除理由：靠文本匹配，agent 若引用/复述该串会误判；不如显式端点稳。
- **（否决）候选 4/5**：让 agent「先结束本轮再调 complete」——单发任务无自触发第二轮机制，不可行；「协议里让 agent 循环重试
  complete 直到成功」——本轮不结束 complete 就不会成功、循环又让本轮不结束，死锁。

**本轮处置**：不擅自改状态机（触承重墙 + 违契约 §8.2 明定不变量，遵 CLAUDE.md「发现问题可反馈，但不要直接改」）。
如实标 FAIL + 根因 + 候选，交主 session / 契约作者定夺。P2 的**其余能力不被它阻断**：云端派活能真在机器上执行代码
（C13a），只是「跑完自动收敛到 done」这一步暂时要人在看板点一下「人工完成」（任务确实停在 awaiting-human，人看得见、点得动）。

---

## 5. 自查发现处置：`links.js` 归属（minor，非 blocker）

自查指出本 worktree 建了 `platform/lib/cloud/links.js`，而契约把该文件划给 #67（决策 14 对账过滤）。**本轮不删它**，理由：
- B 块 connector `import { readLinks, writeLinks } from './links.js'` 是硬依赖，删了 E2E 起不来（C05-C13 全依赖它落 link 幂等）。
- 内容就是契约 §7.3 钉死的**与 #67 共享的双向格式**（`readLinks/writeLinks/linkedTaskKeys`），非本文私造。
- 它不在「明确不碰」集合里（`reconcile.js`/`machine-relay.js`/`dispatch-gate.js`/外部 API 均未改，已核）。
- 唯一风险是 #67 也落同名文件时 git「both added」冲突。**处置建议**：合并时让恰好一条 PR 引入该文件、保持字节一致
  （两侧都照 §7.3 写，格式已对齐）。这是协调项，不是代码缺陷。

---

## 6. 收尾（独立只读复核，非工具回执）

脚本 `finally` 报了收尾，但按「工具的成功回执不算证据」，另用独立命令复核 ground-truth：

```
一次性库 scrumws_p2_e2e            → 已删除（pg_database 无此行）
生产 scrumws（只读）               → app_user=1 machine=1（与契约基线一致）；task 无 auto_run 列（002 未对生产执行）
claude_center / novel_writer       → 仍在，未碰
端口 8790(远端生产,本地无)/8791/8797 → 本地均无监听（自起进程已按 PID 收）
用户真实 app 8799                  → GET /api/state HTTP 200（全程只读探活）
残留 p2e 进程（node/claude）        → 0
```
- 自起进程全部 `taskkill /PID <自己的> /T /F` + 按命令行含沙箱路径的 PID 定点补收，**从未按进程名/路径杀** node/claude。
- 真 claude 是常驻 `-p` 会话进程，靠 `taskkill /T` 连 `node→cmd→claude` 整树收掉，复核 8797 空闲 + 0 残留证明收干净。
- 未 `git commit`/`git push`（收口由主 session 做）。

---

## 7. 未收敛 / 观察项（不强凑结论）

1. **决策 15 端到端缺陷（C13b）**：见 §4，需契约作者定候选修复。**这是本轮最重要的产出**——真跑之前它被两处假绿盖住。
2. **C13a 云端对账时 status.state=awaiting-human**：因 C13b，真跑任务停在 awaiting-human 而非 done，云端如实镜像了这个（错误的）终态。
   一旦 §4 修好，云端就会看到 done(by=agent)。当前云端镜像**没错**，是本地真相本身停在了 awaiting-human。
3. **owner-only 信任云端上报的 createdBy**（契约 §12 缺口 2，风险接受项）：C08 证了判据链通，但「云端被攻破可伪造 createdBy」
   仍需 `off` 档才能完全不信云端。本轮未触碰，如实沿用契约结论。
4. **本轮未验 §5.7c 云端看板 LEFT JOIN 的 UI 呈现**（pending/rejected 意图在看板列表/详情的样子）：C05/C06/C07/C08 已从
   `GET /api/tasks/:id` 拿到 dispatch/rejectReason/status 字段，证明 LEFT JOIN 后 pending/rejected 意图查得出、dispatch 面回得全；
   纯前端渲染（卡片如何显示 rejectReason）未走浏览器截图，列为观察项。
