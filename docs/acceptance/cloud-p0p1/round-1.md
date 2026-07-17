# cloud P0+P1 · round-1 验收记录

**结论：matrix.csv 全绿（C01–C27），4 个自查发现全部修复并实证；1 条与编排指令的口径出入 + 2 条观察项标在 §9，未强凑结论。**

- 日期：2026-07-16/17
- 契约：`docs/spec/cloud-p0p1-contract.md`；设计权威：`docs/spec/cloud-control-plane.md`
- 状态总表：`matrix.csv`（状态以它为准）
- 脚本：`scripts/`（跨轮复用）；本轮证据：`round-1/`

## 0. 环境与隔离

| 项 | 值 | 为什么这么定 |
|---|---|---|
| 云端 | `127.0.0.1:8790`，pid 25372 | 本地联调走 http（`http.js` 明确支持 `http:` 仅供本地联调；生产强制 HTTPS 不变） |
| 本地沙箱看板 | `127.0.0.1:8798`，`SCRUMWS_DATA_ROOT=<repo>/.sandbox/p1` | **不是** 8799 |
| 用户真实桌面 app | `127.0.0.1:8799` | **全程只读探活，一次没碰**。收尾 `GET /` → HTTP 200 |
| 验收库 | `scrumws_p1_verify`（一次性，用完 DROP） | 见下 |

**为什么另建库而不就地用 `.env` 的 `scrumws`**：开局只读探得该库已有 `{app_user:1, machine:6, task:6}`（其它 agent 的残留）。多 worktree 共用同一远程 dev 库，就地验会把验收数据混进去，且残留行会让「云端看到 5 个任务」这类断言失去意义。
→ `scripts/db-sandbox.mjs --check|--create|--drop`（破坏性脚本带零副作用自检）。
**顺带收获**：`001_p0p1_init.sql` 在全新库上跑通、12 张表齐全 —— 独立复核了契约 §10「迁移已应用」的说法。

收尾复核真实库未被写：`{app_user:1, machine:6, task:6}` 与开局逐字相同。
`DATABASE_URL` 全程只经 `process.env` 注入，未进任何源码/文档/日志/提交。

---

## 1. 修的 4 个问题（自查发现）

### ① [blocker] 云端前端从未被真实服务端托管 — `cloud/src/server.js`

**根因**：`buildServer()` 只注册 `/api/health` + userRoutes + machineRoutes，`setNotFoundHandler` 把一切非 API 路径回成 JSON 404；`@fastify/static` 压根没装。全仓只有 `docs/acceptance/cloud-p0p1/round-1/mock-baseline/mock-cloud-server.mjs:189` 托管过静态文件 —— 那是 mock。前端 agent 全程对着 mock 验，**没碰过真 server.js**，所以一路绿灯。

**修**：`cloud/package.json` 加 `@fastify/static@^8.3.0`（cloud/ 是独立服务，与根隔离），`cloud/src/server.js:43` 注册静态根。
前端是 hash 路由（`cloud/public/app.js:478` 读 `location.hash`），浏览器只请求 `/` 与 `/app.js` → **不需要 SPA history 回退**，取不到的资源照常 404（不堆兜底）。

**证据**（改前该路径必然是 JSON 404）：
```
GET /         → 200  text/html               27567 bytes  = index.html 实际大小
GET /app.js   → 200  application/javascript  26862 bytes  = app.js 实际大小
GET /api/nope → 404  {"error":{"code":"NOT_FOUND","message":"端点不存在"}}   ← API 语义不变
```
浏览器实跑：`round-1/shots/01-login.png`（登录页由真实 server.js 吐出）。

### ② [blocker] 缓存层破坏 read-your-writes — `platform/lib/collect.js` + `platform/server.js`

**根因**：`/api/state` 走 `getState({maxAgeMs:3000})`（`server.js:183`），而前端每个 mutation 都是 `await api(POST…)` 紧跟 `await refreshState()`（`app.js:752/768/785/820/837…` 27 处），`refreshState` 是裸 `api('/api/state')`（`app.js:2190`）、无 cache-buster。mutation 前 3s 内发生过任何扫描（UI 上一轮轮询 / connector tick）→ 回拉命中缓存 → 返回 mutation **之前**的快照。原注释（`collect.js:373`）的安全论证只覆盖轮询节拍（>5s），漏了事件驱动的回拉。
非纯显示问题：`app.js:1446` `await refreshState(); // 让 mbSessionId 现身` 是功能性依赖。

**修**：写代次（generation）。
- `collect.js`：`invalidateState()` 推进代次；`getState` 的缓存命中与 single-flight 搭车**都要求同代**；`collectState()` 按**扫描开始时**的代次记账（扫描途中的写入不算进本次）。
- `server.js:180`：**一个挂钩覆盖全部写端点** —— `if (req.method === 'POST') res.on('finish', invalidateState)`。挂 `finish` 是因为响应发出时磁盘写必已完成（各 handler 都是 await 动作后才 sendJson），且新增写端点不会漏。

顺带把 minor「`maxAgeMs=0` 语义与注释不符」一并解掉：代次判定后，写之前起飞的那次扫描不会再被搭车返回。

**证据 —— 真实跑着的看板进程**（`round-1/read-your-writes.txt`，脚本 `scripts/verify-read-your-writes.mjs`）：
```
POST /api/task/rename → HTTP 200
紧接着 GET /api/state（距上次扫描 17ms，在 3s TTL 窗口内）
  回拉标题 = "RENAMED-BY-USER"   期望 "RENAMED-BY-USER"   ✅
  连续 mutation：写 "第二次改名-AAA" → 回拉 "第二次改名-AAA"  ✅
  连续 mutation：写 "第三次改名-BBB" → 回拉 "第三次改名-BBB"  ✅
```
（脚本刻意先打一次 `/api/state` 把缓存焐热 —— 否则缓存早过期、自然重扫，等于绕开 bug 测了个寂寞。）

### ③ [major] 归档任务混进 done 列 — `cloud/src/routes/user.js:338`

**根因**：`collect.js:204` 是「isArchive 优先」分桶，归档任务 `state` 仍是底层态（`done`），只有 `isArchive=true`。`/api/tasks` 的过滤是裸 `ts.state = $3`，**不看 is_archive**；而同文件 `user.js:240` 的 taskCounts 却已按 `case when ts.is_archive then 'archived' else ts.state end` 派生 —— 作者知道这条规则，只是没应用到 `/api/tasks`。

**修**：`/api/tasks` 的 state 谓词改成与 taskCounts **同口径**的派生桶。

**证据**（同一份真实数据，两个谓词对拍）：
```
看板 done 列 total：
  修复前谓词 (ts.state = 'done')               → 2   ← 混入归档任务
  修复后谓词 (case when is_archive … = 'done') → 1   ← 与机器页一致
机器页 taskCounts：{"archived":1,"done":1,"plan":1,"processing":1,"queued":1}
→ 修复前同一界面两个矛盾数字（看板 done=2 vs 机器页 done=1）；修复后均 = 1
```
且数据来自**真实本地归档**（`POST /api/archive` → 目录移进 `runner-archive/` → 对账上行），不是手工 UPDATE ——
这同时证明 rev 指纹的 `isArchive` 补丁（契约 §5.2）有效：归档不写 history、不动任何时间戳，靠它才被感知。
UI 实拍：`round-1/shots/02-board.png`（done 列只有 1 张，归档那张不在）。

### ④ [major] enroll 绕过 scheduler.lock 闸门 → 双份上报 — `platform/lib/cloud/connector.js`

**根因**：boot 闸在 `server.js:652`（`if (mode === 'running')`），但 `enroll()` 内的 `startConnector()` 无任何判断，且 `/api/cloud/enroll` 在每个实例上都注册。副实例（同 dataRoot、不同端口 → `mode='disabled-lock'`）从设置页点「连接」就会起自己的 connector，与主实例用同一 token 双份 heartbeat + upsert。

**修**：闸门下沉到 `startConnector()`（`connector.js:113`）—— 它是唯一启动入口，boot 与 enroll 两条路径都得过，invariant 从此不可能被新调用方绕开。副实例 enroll 照常写 `identity.json`，主实例空转的 tick 会在 15s 内捡起来接管上报（UX 不变）。

**证据 —— A/B 实跑**（用云端日志数 45s 窗口内到达的心跳；1 个上报者≈3 次，2 个≈6 次）：
```
有闸门（修复后）：45s 内心跳 = 3    8797 副实例 lastHeartbeatAt = null（enrolled=true 但从不上报）
无闸门（临时移除复现）：45s 内心跳 = 6    8797 与 8798 双方 lastHeartbeatAt 均新鲜 ← 正是「互相打架」
```
> A/B 中途踩坑并已纠正：第一次「移除闸门」的复现用 Git Bash `kill` 停旧进程 **没杀掉**（Windows），新进程 `EADDRINUSE` 没起来，8797 仍是旧的带闸门进程 → 测出 3 次、险些当成「无闸门也没问题」的假结论。改用 PowerShell `Stop-Process -Id` 后才真复现出 6 次。
> 闸门已还原并复核：`connector.js:113` `if (scheduler.status().mode !== 'running') return;`，临时注释残留数 = 0，`node --check` 通过。

---

## 2. 端到端剧本（每步真实输出见下）

### ①② 起云端 → 首用户 → swuk_ → 登录 → swrk_ → 配对码

```
[create] <DATABASE_URL 同主机>/scrumws_p1_verify 就绪，public 表数 = 12
bootstrap --check：零副作用自检完成，未写任何行
bootstrap：workspace=scrumws (slug=scrumws)  user=孙鹏  登录密钥 swuk_（明文只打印一次，48 字符）
POST /api/auth/login → 200 {"user":{"name":"孙鹏"},"workspace":{"name":"scrumws","slug":"scrumws"}} + Set-Cookie swsession
GET  /api/auth/me   → 200（同上）
POST /api/registration-keys → 201 prefix=swrk__zc7 长度=48 label="P1 验收"
POST /api/machines/enrollment-codes → 201 {"code":"J8K4G9AS","ttlSec":600}
```

### ②b 负例（`round-1/enroll-negative.txt`）

```
PASS ① 不带注册密钥        → HTTP 400 {"code":"BAD_REQUEST","message":"body must have required property 'registrationKey'"}
     └ 该配对码随后配好 rk 仍可用 → 201（缺 rk 那次**没消费掉配对码** —— rk 确实在 code 之前校验）
PASS ② 带错注册密钥        → HTTP 401 {"code":"UNAUTHORIZED","message":"注册密钥或配对码无效／已过期，…"}
PASS ③ 带已撤销注册密钥    → HTTP 401（与②逐字节相同 = true）
PASS ④ rk 对但配对码错     → HTTP 401（与②逐字节相同 = true）  ← §6.5 反 oracle 红线
```
> ① 实测 **400 而非 401**：这是契约 §6.5 第 0 步明写的口径（「只校验形状，绝不校验凭据内容」），不是实现走样。与编排指令「三种都必须 401」有出入 → 见 §9 未收敛-1（含我的判断与理由），未擅自改契约行为。

**撤销 rk 不影响已在线机器**（`round-1/rk-revoke-online.txt`）：
```
撤销 rk（prefix=swrk__zc7）→ 200
撤销后 · 用这把 rk 拉新机器入场 → 401（新机器进不来）
等 40s（>2 个心跳周期）：
  撤销前 lastSeenAt = 2026-07-16T16:16:54.523Z
  撤销后 lastSeenAt = 2026-07-16T16:17:39.559Z   ← 仍在前进
  已在线机器仍 online ✅   心跳仍在前进 ✅
→ rk 只管入场，不管在场；要踢机器得撤 machine_token（§6.8），别混。
```

### ③ 本地沙箱 5 个 state 任务包

```
造卡 plan            manual:20260716100000-001
造卡 queued          manual:20260716100100-002
造卡 processing      manual:20260716100200-003  (+lease pid=324)
造卡 awaiting-human  manual:20260716100300-004
造卡 done            cli:20260716100400-005
本地 /api/state：plan=1 queued=1 processing=1 awaitingHuman=1 done=1  scheduler.mode=running
```
> **踩坑并已修**：processing 卡第一次被 runner-checker 收成了 awaiting-human —— 它把「state=processing 但 lease pid 已死」当孤儿收走（`jobs/runner-checker.js:69`，判据 `lease.js:17`）。**这是对的系统行为，不是 bug**，是我的假数据不真实。改为起一个 keepalive 子进程持有 lease（pid 写进 `keepalive.pid`，收尾按 pid 定点杀）。
> 造数脚本带护栏：`SCRUMWS_DATA_ROOT` 含 `.scrumws` 直接拒绝 —— 实测 `Error: 拒绝写用户真实数据根`，用户真实数据根零污染。

### ④ enroll → identity.json（`POST /api/cloud/enroll` → `{"ok":true,"workspaceName":"scrumws"}`）

```
identity.json 字段全集: machineUid, cloudUrl, machineId, token, workspaceId, workspaceName, enrolledAt
  ← 与契约 §7.1 的穷举逐字一致，**没有 registrationKey**
红线复核：
  沙箱数据根全文搜 rk 明文      → ✅ 无命中
  本地看板日志 / 云端日志搜 rk  → ✅ 无命中
  /api/cloud/status 含 rk       → ✅ 不含
```

### ⑤ 心跳 → 机器 online

```
机器: 百部 | status = online
   hostname = 百部 | platform = win32 | arch = x64
   appVersion = 0.1.0 | claudeVersion = 2.1.211      ← 与本地 /api/state runtime.version 一致
   load = {"processing":1,"queued":1,"cap":5}        ← 与本地各桶 + maxConcurrentRunners 一致
   owner = 孙鹏 | taskCounts = {"plan":1,"queued":1,"processing":1,"awaitingHuman":1,"done":1,"archived":0}
```
UI 实拍：`round-1/shots/03-machines.png`。

### ⑥ 对账 → 云端 5 任务，state 与本地逐张一致

```
taskKey                          本地state        云端state        mirror     一致
manual:20260716100000-001         plan             plan             live       PASS
manual:20260716100100-002         queued           queued           live       PASS
manual:20260716100200-003         processing       processing       live       PASS
manual:20260716100300-004         awaiting-human   awaiting-human   live       PASS
cli:20260716100400-005            done             done             live       PASS
本地 5 张 / 云端 5 张 → PASS 全部一致
```
详情抽查（`GET /api/tasks/:id`）：prompt 全文、model/effort/cwd/worktree/baseBranch、rounds=2/numTurns=8/totalCostUsd=0.213456、sessionId、worktreeBranch、usage 原样透传、history `0:queued@create:manual → 1:processing@session`。

### ⑦ 改本地 state.json → 云端新 state + history 追加

```
改前：state=awaiting-human outcome=null history=3 条
改后：state=done outcome=success history=4 条（新增 done@user @2026-07-16 23:46:20）
20s 后云端：
  state = done | outcome = success
  resolvedAt = 2026-07-16T15:46:20.000Z          ← 本地 23:46:20（东八）→ UTC 15:46:20，**+8 换算正确**
  history = 0:queued@create:manual → 1:processing@session → 2:awaiting-human@session → 3:done@user
  mirror = live
```
这条同时验掉契约 §4 那个「最容易两端写岔」的时区坑：裸串塞 timestamptz 会静默偏 8 小时，实测没偏。

### ⑧ 删本地 plan 任务 → 全量 digest → local_missing（`round-1/digest-local-missing.txt`）

```
[0s]…[166s] mirror=live   （增量对账不感知「消失」，符合设计：只有 digest 报全集）
[181s] mirror=local_missing
✅ state 仍 = plan（未被改动 —— 云端永不写执行真相）；行未删，历史仍可查
```
> **没有把 digest 间隔调小**（编排指令允许调）—— 直接用生产常量（`DIGEST_EVERY=20 × TICK_MS=15s = 5min`）轮询等到，证据比「改小间隔测一把」更贴生产。181s 落在周期内，符合预期。
UI 实拍：`round-1/shots/02-board.png` plan 卡上的「⚠ 本地已消失 · 最后同步 28 分钟前」角标 + `04-task-detail.png` 的顶部横幅。

### ⑨ 停本地 >90s → offline，任务真相一个字节没变（`round-1/sweeper-offline.txt`）

```
[0s]…[76s] machine=online   任务 mirror=[live,local_missing]
[91s]      machine=offline  任务 mirror=[local_missing,stale]

=== sweeper 把机器标 offline（阈值 90s，实测 91s）===
执行真相与停机前逐字节相同 = true ✅ PASS
  → live→stale 只动镜像新鲜度；state/outcome/rounds/成本/isArchive 一个字节没动（契约 §6.13）
  → local_missing 的那张保持 local_missing（没被 stale 覆盖）
```
比对口径 = `{state,outcome,enteredAt,resolvedAt,rounds,numTurns,totalCostUsd,isArchive}` 全量 JSON 逐字节相等（`mirror`/`syncedAt` 是新鲜度，允许变）。
恢复性：重启本地看板后机器重新 `online`（截图即在恢复后拍的）。

> **第一次跑这条 FAIL 过，是我自己污染的**：我在 sweeper 计时窗口内手工 `UPDATE task_status … is_archive=true` 去测 ③，结果基线里混进这一列的变化。已改为「先用真实 `POST /api/archive` 归档、再取基线」重跑，本轮 PASS 是干净的。**记在这里是因为它正是「测试自身干扰」的典型**，不是系统缺陷。

### ⑩ 前端截图（`round-1/shots/`，puppeteer-core + 系统 Edge，**走真实 8790**）

| 文件 | 内容 |
|---|---|
| `01-login.png` | 登录页 —— blocker ① 的直接证明：真实 server.js 能把前端吐出来 |
| `02-board.png` | 看板 5 桶；plan 卡带「本地已消失」角标；done 列不含归档 |
| `03-machines.png` | 机器列表：online / claude 2.1.211 / 负载 1|5 / taskCounts 六桶 |
| `04-task-detail.png` | 任务详情（local_missing 那张）：顶部「本地已不存在这个任务」横幅 + prompt + 状态历史 |
| `05-task-detail-usage.png` | 任务详情（有用量那张）：轮次 2 / turns 8 / 成本 $0.2135 / sessionId / usage 末轮快照四格 + worktree 分支 |

浏览器控制台错误只有两条，均非缺陷：`401 /api/auth/me`（登录前的探测，契约 §6.3 就定的 401）、`404 /favicon.ico`（见 §9 观察-2）。**没有任何静态资源 404**。

---

## 8. 量化 §9b.1 · collect.js 缓存层（`round-1/bench-collect-cache.txt`）

扫描次数用 `onState` 数 —— 它的语义就是「每次扫描成功完成后回调」，本身就是精确计数器（顺带成了它导出后的第一个真实调用方）。

**单次全量扫描的成本随任务包数线性长**（`scripts/bench-scan-scale.mjs`，每个 N 一个独立进程 + 一次性根 —— 换根必须换进程：`collect.js` 的 ROOT 在模块加载时由 `paths.js:7` 定死）：

| 任务包数 | 扫描 P50 | 每包 |
|---|---|---|
| 10 | 7.5ms | 0.748ms |
| 50 | 29.3ms | 0.586ms |
| 100 | 53.2ms | 0.532ms |
| 300 | **151.8ms** | 0.506ms |

**扫描次数与延迟**（沙箱 4 包，UI+connector 共存 10 个时刻 = 20 次请求）：

| | 实际扫描次数 | /api/state（UI，冷）P50 |
|---|---|---|
| 改造前（无缓存） | **20** | 13.0ms |
| 改造后（缓存 + single-flight） | **10** | 14.9ms（+14%，n=10 噪声内） |
| 20 个并发 `/api/state` | **1**（20 个返回同一对象） | 墙钟 10.8ms |
| UI 扫完后 connector 紧接着 tick | **+0** | 0.1ms（白嫖 UI 那次） |

> 这三个数字来之不易，中途纠了两次**假结论**：
> ① 一开始【2】的首轮白嫖了上一节留下的热缓存 → 扫描次数少数了一次；
> ② 【1】用紧凑循环、【2】有 3.1s 间隔 → 不是同一把尺子；补上相同间隔后仍差 2.5x，查明是**【1】把 UI（冷）与 connector（紧随其后、文件缓存滚烫）混在一起取 P50**，被 10 个热样本拉低。分开统计后才是冷 vs 冷的公平对比。
> 若不纠这两处，报出来的就是「加了缓存反而慢 2.5x」——**实际量的是热 vs 冷，与缓存无关**。

**回答四问**：

1. **TTL 取多少 / 依据**：`/api/state` 用 **3000ms**，connector 用 **15000ms**。依据是前端轮询频率夹在 `[5s, 600s]`、默认 15s（`app.js:6`）—— **UI 最快也只有 5s 一次 > 3s TTL，故每次必然重扫，TTL 永远不降级 UI 的新鲜度**；它在 UI 侧只起「合并瞬时并发」的作用（多标签页 / modal 关闭补拉：20 并发 → 1 次扫描）。connector 的 15s 窗口基本必然命中 UI 那次扫描。
2. **实际扫描次数**：UI 开着时 connector **+0**（白嫖）→ 20 请求/10 时刻从 20 次扫描降到 10 次；UI 关着时 connector 自己触发 4 次/分（上报必需，原来是 0）。**净账是减少，不是新增开销。**
3. **/api/state P50**：**基本不变**（13.0 → 14.9ms，同为一次冷的全量扫描，差值在 n=10 噪声内）。缓存不是为了让 UI 更快，是为了让 connector 不额外扫。
4. **UI 会不会看到过期数据**：**不会** —— 但这**不是 TTL 自带的性质，是加了写代次才有的**。原实现（只按年龄判）**确实会**：mutation 前 3s 内有过扫描 → 回拉命中旧快照，等 15s 才自愈（这正是 blocker ②，已实证并修）。现在任何 POST 落盘后立即推进代次，写后第一次 `getState` 必然重扫。

**成本感**：300 包时一次扫描 152ms。UI 15s 轮询 = 4 次/分 ≈ 0.6s CPU/分（单核 1%）；改造前 connector 会把它翻倍到 2%，现在 +0。20 并发若无 single-flight = 20×152ms ≈ 3s 连续扫描，有则 152ms。**包越多，这层越值。**

---

## 9. 未收敛 / 观察项（不强凑结论）

1. **「不带 rk → 400 还是 401」**：实现按契约 §6.5 第 0 步 = **400**（形状问题）；编排指令要求「三种都 401」。
   **我的判断：400 是对的，不改。** 理由：oracle 的成立前提是「攻击者能靠响应差异反推**服务端秘密状态**」。字段缺不缺是攻击者**自己请求的形状**，他本来就知道，**零信息增益** —— 与「rk 错 vs code 错」必须不可区分（那才泄露 rk 有效性）是两回事。而且把「没带凭据」说成「凭据无效」会误导正常客户端排障（如旧版 app 没发这个字段）。契约把这条线画得很清楚且写了理由，我不擅自改设计。
   **风险接受点**：若你认为「enroll 的一切失败都该 401」更简单，那是**一行 schema 改动**（把 `required` 挪进 handler 手动判后走 `enroll401`）—— 请拍板，我不替你决定。
2. **`taskCounts` 把 `local_missing` 的任务也算进桶**：本轮机器页显示 `plan:1`，而本地 plan 桶已是 0（那张被删、云端标了 `local_missing`）。契约 §6.7 没规定 counts 是否该滤 `mirror` —— 云端保留行是**故意**的（历史可查），但「和本地看板显示一致」的口径下这算轻微背离。**没改**，因为这是产品口径决定，不是 bug。
3. **`404 /favicon.ico`**：`cloud/public/` 没有 favicon，浏览器控制台会有一条 404。纯观感，**没顺手加**（不在范围内，且「不顺手改旁边的代码」）。
4. **契约 §9 已知缺口照旧**：`task_status.git_branch` 在 P1 恒 null（`collect.js` meta 投影不含 gitBranch，别在 connector 里补扫 —— 历史上修过两次才根治）；`other` 桶不上行。本轮未触碰。

---

## 10. 收尾

- 一次性库 `scrumws_p1_verify` 已 `DROP … WITH (FORCE)`；重建配方 = `scripts/db-sandbox.mjs --create`（幂等）。
- 自起进程全部**按 PID 定点**收：云端 8790、沙箱看板 8798/8797、keepalive。**从未按进程名/路径杀** —— 那会连用户 8799 的 Electron 一起端。
- **用户真实桌面 app 全程可用**：收尾 `GET http://127.0.0.1:8799/` → HTTP 200。
  > 中途我的检查脚本报过一次「❌ 用户 app 被误伤」—— **是我的检查错了，不是系统**：脚本硬编码了开局记下的 pid 33796，而用户自己重启了 app（4 个 electron 进程 StartTime 全是 0:07:57，是一次完整重启），新 pid 31824 正常监听 8799。我的 `Stop-Process -Id` 只打过 10572/8868/35624/8664（全是我自己起的 node）。检查已改为**按端口探活**，不硬编码 pid。
- 未 `git commit` / `git push`（收口由主 session 做）。
