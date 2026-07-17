# 云端控制面 · P0+P1 实现契约

**这份文档的用途**：三个互不通信的 agent（云端后端 / 云端前端 / 本地 connector）各写一部分，照此文档写完能直接接上。
凡本文档与 `docs/spec/cloud-control-plane.md`（设计权威）冲突处，均已在正文标注「⚠ 与设计文档的偏差」并给出理由与代码证据。

- 设计权威：[`cloud-control-plane.md`](cloud-control-plane.md)
- 迁移：`cloud/migrations/001_p0p1_init.sql`（**已实际跑进 scrumws 库**，见 §10）
- 范围：**P0（身份与连线）+ P1（状态上行）**。不做 WS、意图下行、命令下行、transcript 拉流、cron。

---

## 1. 范围与不变式

### 1.1 三条不许拆的不变式

1. **云端永不写 status，本地永不读 spec 以外的东西**（设计 §3）。物理落法：`task`（spec）与 `task_status`（真相镜像）分表，写权限见 §3.3。
2. **`source` 只是来源元数据，不是行为开关**（README:43-47）。connector 与云端一律**按 state 分支，绝不写 `startsWith('cloud:')` / `source === 'cloud'` / `origin === 'local'` 这类来源特判**去改变行为。`source` / `origin` 只用于展示、筛选、入库归类。
3. **platform/ 零运行时依赖**。根 `package.json` 只有 `electron` / `electron-builder` 两个 devDependency（`package.json:20-23`）。connector 只能用 `node:http` / `node:https` / `node:crypto` / `node:fs` / `node:path` / `node:os`。**禁止**给根 package.json 加任何依赖。`cloud/` 是独立服务、有自己的 `cloud/package.json`（fastify + pg），与根隔离。

### 1.2 P0+P1 只有出站，没有下行

云端**永远拿不到** 8799 的入站访问（`server.js:17` 写死 `127.0.0.1`）。P0+P1 全部是本地→云端的出站 HTTP。
**因此不需要 WS**：设计 §6.4 的 WS 帧只是 P2 意图下行的 hint 优化，P0/P1 没有下行内容可 hint。纯 HTTP 即可。

### 1.3 端口

| 服务 | 端口 | 说明 |
|---|---|---|
| 云端 | **8790** | 本次新建 |
| 本地看板 | 8799 | ⚠ **用户正在跑的真实桌面 app，严禁碰**（不改端口、不重启、不写它的 dataRoot） |

---

## 2. 术语与 ID 映射

| 概念 | 云端 | 本地 | 映射 |
|---|---|---|---|
| 机器 | `machine.id`（uuid） | `identity.json.machineUid`（uuid） | `unique (workspace_id, machine_uid)` |
| 任务 | `task.id`（uuid，全局唯一） | `taskKey` = `<source>:<slug>`（`task-actions.js:453`，**只在本机唯一**） | `unique (machine_id, local_task_key)` |
| 任务目录名 | — | `safeTaskKey` = taskKey 的 `:`→`__`、`#`→`_`（`task-actions.js:454`） | 仅本地用，不上行 |

**两台机器的 taskKey 必然相撞**（slug 是 `yyyyMMddHHmmss-<3位随机>`），所以云端一切按 `(machine_id, local_task_key)` 定位，**绝不**拿 `local_task_key` 当全局键。

---

## 3. 鉴权

### 3.1 三种凭据（+ 一种派生会话）

**三种凭据回答三个不同的问题，作用域各不相同**（设计 §5.1 / §9 决策 11）：

| 凭据 | 前缀 | 持有者 | 回答什么问题 | 作用域 | 生命周期 | 存储 | 是否落盘（本地） |
|---|---|---|---|---|---|---|---|
| 登录密钥 | `swuk_` | 人（密码管理器） | **你是谁** | 该用户的一切 | 长期，可轮换/撤销 | `user_key.key_hash` | 人自己保管 |
| **注册密钥** | `swrk_` | 云端生成并展示一次，人贴到桌面设置页 | **这台机器有资格加入这个云端吗** | **云端实例级，一把管全体** | 实例级，可轮换（新旧并存） | `registration_key.key_hash` | **否 —— 用完即弃**（§7.1） |
| 机器令牌 | `swmt_` | 桌面 app 的 `identity.json` | **这台机器是哪台** | 单台机器 | enroll 换取，可单独撤销 | `machine_token.token_hash` | 是（尽力 0600） |

派生凭据（不是第四种身份，只是登录密钥换来的短期载体）：

| | 前缀 | 持有者 | 用途 | 存储 |
|---|---|---|---|---|
| Web 会话 | `swst_` | 浏览器 cookie | Web 请求 | `user_session.token_hash` |

**为什么不合并**（设计 §5.1）：登录密钥与机器令牌合并的代价是**桌面配置泄露 = 账号沦陷 = 可给该用户所有机器派活**。分开则磁盘泄露只丢一台机器的上报权限。

### 3.1.1 ⚠ 三条校验路径必须彻底分开（评审红线）

**一种凭据 = 一张表 = 一个专用校验函数。禁止任何形式的共用。**

```js
// cloud/src/auth.js —— 必须是三个各自独立的函数，签名里没有「表名」「前缀」这类参数
export async function verifyUserKey(plaintext)          // 只查 user_key，只接受 swuk_
export async function verifyRegistrationKey(plaintext)  // 只查 registration_key，只接受 swrk_
export async function verifyMachineToken(plaintext)     // 只查 machine_token，只接受 swmt_
```

**明确禁止**写成 `verifyCredential(plaintext, { table, prefix })` 这类通用函数。理由不是洁癖：

1. **前缀一旦成为参数，就有人会传错** —— 让 `swmt_` 冒充 `swrk_` 过闸。三种凭据都是 `sha256(明文)` 存 `key_hash`/`token_hash` 的 text 列，**哈希空间完全同构**：若查询的表可以由调用方指定，一个传参错误就把「机器令牌」变成了「入场券」，反之亦然。类型系统救不了你（都是 string）。
2. **它们的失败语义不同**：`swuk_` 失败 → 登录 401；`swrk_` 失败 → enroll 门口 401（且**必须与配对码失败无法区分**，§6.5）；`swmt_` 失败 → 401 且本地视为**终局解绑**（§7.4）。混一条路径就会混掉这三种后果。
3. **它们的作用域不同**：`swuk_` 绑 `user_id`，`swrk_` 绑 `workspace_id` 且**不含任何身份信息**，`swmt_` 绑 `machine_id`。返回值形状本就不同，硬统一只会逼出一个 union 类型和一堆 `if`。

每个函数各自：`sha256(明文全串)` → 按 `key_hash`/`token_hash` 唯一索引等值查 → 校验 `revoked_at is null`（`user_session` 另加 `expires_at > now()`）→ 前缀不匹配直接返回 null（**在查库之前**）。

### 3.2 精确格式（两端必须一致，否则哈希对不上）

```
明文 = "<prefix>_" + base64url(crypto.randomBytes(32))     // base64url 无 padding → 43 字符
  swuk_KJ8x...（总长 5+43 = 48）  登录密钥
  swrk_Pt7w...（总长 48）         注册密钥 —— 云端**自己生成**，不是人设的口令
  swmt_9aQ2...（总长 48）         机器令牌
  swst_Lm3v...（总长 48）         Web 会话

存储哈希 = sha256(明文全串，含前缀).hex()                   // ⚠ 是对含前缀的完整串取哈希，不是只对随机段
存储 prefix 列 = 明文的前 9 个字符                          // 如 'swuk_KJ8x'，UI 展示用，不足以反推
```

四者格式**刻意完全同构**（同长度、同字符集、同哈希口径）—— 正因如此，**区分它们的唯一手段是「查哪张表」**，而那必须由**函数身份**决定、不能由参数决定（§3.1.1）。

配对码（`enrollment_code`）另一套 —— 要人手输，不能用 base64url：

```
明文码 = 从字母表 '23456789ABCDEFGHJKLMNPQRSTUVWXYZ' 里取 8 个字符（Crockford 风格，剔除易混的 0/1/I/O）
        必须用 crypto.randomInt(32) 逐位取，禁止 Math.random()
        → 32^8 = 40 bit 熵；TTL 10min；单次使用
code_hash   = sha256(明文码).hex()
code_prefix = 明文码前 2 位（UI 列「待用配对码」时展示）
```

传输：`Authorization: Bearer <明文>`（`swmt_` / `swuk_`）；Web 会话走 `HttpOnly; Secure; SameSite=Lax` cookie，名 `swsession`。

### 3.3 写权限矩阵（不变式的落地，评审照这张表卡）

| 表 | 人类鉴权 handler | 机器鉴权 handler | enroll handler（无鉴权，凭 rk+码） |
|---|---|---|---|
| `app_user` / `user_key` / `user_session` / `workspace` / `member` | 读写 | **无权** | **无权** |
| `registration_key` | 建（§6.14）、列（§6.15）、置 `revoked_at`（§6.16） | **无权** | **只读校验** + 置 `last_used_at` |
| `machine` | 读、改 `display_name`、置 `revoked_at` | 只改 `last_seen_at` / `status` / `claude_version` / `app_version` / `load_*` / `max_concurrent_runners` | upsert（enroll 时） |
| `machine_token` | 置 `revoked_at` | 只改自己那行的 `last_used_at` | 建 + 轮换旧令牌（enroll 时） |
| `enrollment_code` | 建 | **无权** | 置 `used_at` / `used_by_machine_id`（enroll 时） |
| `task` | P1 **无写入**（P2 才有云端建任务） | 只经 `/api/machine/tasks/upsert` 导入 `origin='local'` 行 | **无权** |
| `task_status` / `task_history` | **永不写**（sweeper 除外，见下） | 只经 upsert / digest 写 | **无权** |

> **sweeper 例外**：系统 tick（非人类请求）可把 `task_status.mirror` 改成 `stale`。它改的是**镜像新鲜度**、不是执行真相（`state`/`outcome` 一个字节都不动）——这正是设计 §6.2「机器掉线时云端不动任何任务状态」的原话。

### 3.4 非成员返回 404 而非 403

不泄露「存在但你没权限」（设计 §1）。查不到 / 不是本 workspace 成员 → 一律 404。

### 3.5 workspace_id 谓词是硬要求

**无 RLS，底下没有兜底**（设计 §7.4）。每条业务查询必须显式带 `workspace_id`（机器鉴权的则带 `machine_id`）。

---

## 4. 时间与时区 ⚠ 最容易两端写岔的地方

**本地所有时间戳都是「无时区的本地时间串」`'yyyy-MM-dd HH:mm:ss'`**（`timeutil.js:5-7`，注释明写「本机为 Asia/Shanghai」）。
云端所有时间列都是 `timestamptz`。

> **规则：connector 必须在上行前把本地时间串转成带偏移的 ISO-8601；云端收到的每个时间字段都必须是 ISO-8601，禁止收裸串。**

```js
// connector 侧唯一正确的转换（parse() 按「本机本地时间」解释，与写盘时的 fmt() 严格互逆）
import { parse } from '../timeutil.js';
const toIso = (s) => { const d = parse(s); return d ? d.toISOString() : null; };   // → '2026-07-16T05:23:01.000Z'
```

- `parse()`（`timeutil.js:10-14`）把 `'2026-07-16 13:23:01'` 当**本机本地时间**解析 → `toISOString()` 得到正确 UTC。
- 若把裸串直接塞给 Postgres 的 `timestamptz`，会按**服务器**的 timezone 解释 —— 机器在东八区、云端跑 UTC 时**整整差 8 小时**，而且不报错，只是全部数据静默偏移。
- `card.lastActivityMs` 已经是 epoch 毫秒（`collect.js:220`）→ `new Date(ms).toISOString()`。

云端侧：`pg` 驱动收 ISO-8601 字符串写 `timestamptz` 是正确的；返回给前端时统一 `toISOString()`。前端只做本地化展示。

---

## 5. rev 指纹算法（对账正确性的根）

### 5.1 ⚠ 与设计文档的偏差：字段集必须扩大，否则会静默丢更新

设计 §6.3 写的是：

```
rev = sha1(state|enteredAt|outcome|resolvedAt|history.length|sessionId|rounds|totalCostUsd|lastActivityMs)
```

**这个字段集有三个已验证的漏洞** —— 下列操作会改变卡片内容，却不动上面任何一个字段，导致 rev 不变 → 增量推不推、5 分钟全量 digest 也认为「已同步」→ **云端永久停在旧值**：

| 操作 | 代码证据 | 只写了什么 | 上面 9 个字段有变化吗 |
|---|---|---|---|
| 重命名 | `logs.js:607+` `renameTask` | 只写 `task.json.customTitle` | ❌ 无 |
| 改备注 | `logs.js:579-597` `setTaskDescription` | 只写 `task.json.description` | ❌ 无 |
| 编辑 plan 任务 | `task-actions.js:541-604` `editTask` | 只写 `task.json`（title/prompt/model/cwd/effort…） | ❌ 无 |
| 归档 | `logs.js:643+` `archiveTask` | 目录从 `runner-state/` 移到 `runner-archive/` | ❌ 无（`state`/`history`/`meta` 全不变，只有 `card.isArchive` 翻 true） |

（`lastActivityMs` 也救不了：它取 `createdAt/enteredAt/resolvedAt/lease.heartbeatAt/meta.lastRoundAt/末条 history.at` 的最大值（`collect.js:41-51`），上述四个操作一个都不碰。）

**这不是纸上推演 —— 已实跑对照验证**（用贴合 `collect.js:124-176` 真实返回体的卡片，分别用设计 §6.3 字段集与下面的 v1 字段集算指纹）：

```
                                        v1 感知    设计§6.3 感知
重命名 renameTask                          是          否      ← 漏
改备注 setTaskDescription                  是          否      ← 漏
归档 archiveTask                           是          否      ← 漏
编辑 plan 任务 editTask(prompt/model)       是          否      ← 漏
state 变化 / history 增长 / 成本累加          是          是
durationMs / resolvedAgo / heartbeatAgo    否          否      ← 正确地不感知
0.1+0.2 与 0.3                          同指纹                 ← toFixed(6) 吸收浮点误差
title='a|b',desc='c' vs title='a',desc='b|c'  指纹不同          ← JSON 转义消除分隔符歧义
```

**结论：凡是要上行的字段，都必须进指纹。** 下面 v1 字段集据此确定。

**反过来，这些字段必须*不*进指纹**（否则每张卡每 15s 都在「变」，增量对账退化成全量推）：
`durationMs`（进行中任务按 `now` 现算，`collect.js:106`）、`resolvedAgo` / `lastActivityAgo` / `lease.heartbeatAgo`（相对时间文案）、`queuedAgeMin`。它们全是**从已进指纹的字段派生出来的展示值**，没有独立信息量。

### 5.2 v1 算法（逐字实现，两端不许各自发挥）

```js
// platform/lib/cloud/rev.js
import crypto from 'node:crypto';

const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');
export const REV_ALGO = 'v1';

// 数值规范化：JS 浮点直接 String() 会因累加误差在两次扫描间抖动（0.1+0.2 类），
// 固定 6 位小数（USD 成本到微元足够）→ 同一份数据永远得同一个串。
const money = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0).toFixed(6);
const int   = (v) => Math.trunc(Number(v) || 0);

/**
 * 计算一张卡的内容指纹。
 * @param {object} card - collectState() lifecycle 各桶里的卡片对象（原样传入，不要预处理）
 * @returns {string} 40 位小写 hex
 */
export function taskRev(card) {
  const payload = [
    REV_ALGO,
    // —— status 面 ——
    card.state ?? null,                      // ⚠ 是 displayState，见 §5.4
    card.outcome ?? null,
    card.enteredAt ?? null,
    card.resolvedAt ?? null,
    Array.isArray(card.history) ? card.history.length : 0,
    card.meta?.sessionId ?? null,
    int(card.meta?.rounds),
    int(card.meta?.numTurns),
    money(card.meta?.totalCostUsd),
    card.lastActivityMs ?? null,
    int(card.backgroundTaskCount),
    card.isArchive ? 1 : 0,                  // 归档漏洞的补丁
    card.cli?.gitBranch ?? null,             // 上行了就得进指纹
    card.worktreeBranch ?? null,
    // —— spec 面（rename / describe / edit 不写 history、不动任何时间戳 → 必须进指纹）——
    card.title ?? null,
    card.description ?? null,
    card.cwd ?? null,
    card.model ?? card.meta?.model ?? null,  // 见 §5.3（collect.js 需补 model）
    card.effort ?? null,
    card.worktree ? 1 : 0,
    card.baseBranch ?? null,
    card.scheduledAt ?? null,
    card.source ?? null,
    card.promptSha ?? null,                  // 见 §5.3（collect.js 需补 promptSha）
  ];
  return sha1(JSON.stringify(payload));
}
```

**为什么用 `JSON.stringify(数组)` 而不是设计文档写的 `|` 拼接**：`title` / `description` 里完全可能出现 `|`，拼接会产生歧义（`a|b` + `c` 与 `a` + `b|c` 同串）。JSON 的转义是单射的，且 `null` 与 `""` 天然可区分（`[null]` vs `[""]`）。
**仓库内已有同款先例**：`server.js:65` 的 `wlFingerprint` 就是 `JSON.stringify([...])` —— 沿用既有风格，不新造。

### 5.3 ⚠ 依赖两个 collect.js 新增字段

`card` 上**没有** `prompt`，也**没有** `model`（`collect.js:124-176` 的返回体逐字可查）。而 §5.1 已证明这两个字段的变化必须能被指纹感知。

因此 **`collect.js` 的 `collectOne()` 必须补两个字段**（详见 §7.2 改动点 2）：

| 字段 | 取值 | 为什么不直接上 prompt 原文 |
|---|---|---|
| `model` | `task?.model \|\| null` | — |
| `promptSha` | `task?.prompt ? sha1(task.prompt) : null` | prompt 最长 100000 字符（`task-actions.js:223`），塞进每张卡会把 `/api/state` 撑爆（前端每 15s 全量拉一次）。只放 40 字节指纹，**完整 prompt 只在该卡 rev 变化时由 connector 单独读 `task.json` 上传**。 |

两个字段都取自 `collectOne` **已经读过的** `task.json`（`collect.js:71`），不新增任何磁盘 I/O。
CLI 观察态卡片（`collect-cli.js`）**无需改动**：它没有 `task.json`，`promptSha` 天然 `undefined`→`null`；`model` 由 `taskRev` 里的 `?? card.meta?.model` 兜住（`collect-cli.js:461` 已有 `meta.model`）。

### 5.4 `card.state` 是「显示态」，不是 `state.json` 原值

`collect.js:122` 的 `deriveBackgroundState`：`awaiting-human` + 会话进程还活着 + 该 session 仍有后台子任务在跑 → **显示成 `processing`**。
上行的就是这个显示态 —— **这是对的**：云端看板要和本地看板显示一致。`background_task_count` 一并上行，云端据此能解释「为什么是 processing」。

### 5.5 云端不重算 rev（重要，避免两个 agent 各写一半后对不上）

**云端把 `rev` 当不透明字符串：原样存 `task_status.rev`，digest 时做字符串相等比较。云端不实现 `taskRev()`。**

理由（这是个正确性判断，不是省事）：

1. 重算需要云端拿到全部 24 个字段并**逐字复刻** `toFixed(6)` / `Math.trunc` / `JSON.stringify` 的转义与数字格式化语义。`total_cost_usd` 是 `numeric` 列，从 pg 取回是**字符串**，再转 JS number 再 `toFixed` —— 任何一环差一点，rev 就永久不等，对账会变成「每次都认为要全量推」的死循环。
2. 重算带来的唯一收益是「校验机器有没有算错 rev」。但本地是权威 —— 机器算错 rev 的后果只是它自己少推一次，云端重算也纠正不了（云端没有真值）。**收益为零，风险为正。**
3. digest 的语义本来就是「机器说它那儿是这个 rev，云端存的是不是同一个」—— 字符串相等就够。

> 所以 §5.2 那份算法是**本地 connector 的单一实现**。它写得这么死，是为了保证**同一台机器的两次扫描 / 两个版本之间**结果稳定（这才是对账的根），不是为了让云端跟着抄一遍。

---

## 6. 云端 HTTP 端点

**Base**：`https://<cloud-host>:8790`。**强制 HTTPS**（设计 §7.4：机器令牌走明文 = 裸奔）。
**统一错误体**（所有非 2xx）：

```jsonc
{ "error": { "code": "UNAUTHORIZED", "message": "注册密钥或配对码无效／已过期" } }
```

| code | HTTP | 含义 |
|---|---|---|
| `BAD_REQUEST` | 400 | body 不合法 / 字段缺失（**与凭据内容无关**才用它，见下） |
| `UNAUTHORIZED` | 401 | 凭据缺失、无效、已撤销、已过期 —— **含 enroll 的注册密钥与配对码的一切失败** |
| `NOT_FOUND` | 404 | 不存在**或**非本 workspace 成员（§3.4） |
| `RATE_LIMITED` | 429 | 限流（带 `Retry-After` 秒数） |
| `INTERNAL` | 500 | 其它 |

> ⚠ **`ENROLL_CODE_INVALID` / `ENROLL_CODE_EXPIRED` / `ENROLL_CODE_USED` 三个码已删除**（早前版本有）。设计 §6.1 ③ 明写：*「rk 无效与 code 无效返回**同样**的 401 + 同一文案 —— 否则攻击者能靠错误差异区分出『密钥对了但码错了』，把两把锁降级成两把独立的锁」*。保留可区分的码就是保留那个 oracle，详见 §6.5。

**限流**（设计 §7.4「仍需登录接口限流防刷」）：`/api/auth/login` 与 `/api/machine/enroll` 按来源 IP **10 次 / 5 分钟**。其余端点不限。

---

### 6.0 引导（bootstrap）—— 没有它谁也登不进来

无密码、无注册、无 OAuth ⇒ **第一个 user / workspace / 登录密钥只能由服务端脚本创建**。

```
cloud/scripts/bootstrap.mjs        # node cloud/scripts/bootstrap.mjs --name "孙鹏" --workspace "scrumws"
  ├─ 读 process.env.DATABASE_URL（禁止写死；.env 的值绝不可进源码/日志）
  ├─ 建 workspace（slug 由 name 生成）+ app_user + member(role='owner')
  ├─ 生成 swuk_ 登录密钥 → 只 **打印一次** 明文，库里只落 sha256 + prefix
  └─ 幂等：同 slug 的 workspace 已存在 → 只补发密钥，不重建
必须支持 --check：零副作用自检（连库、验表齐全、打印将要做什么，不写任何行）
```

> **bootstrap 不生成注册密钥**（`registration_key` 有 `created_by not null` → 本就需要一个 user 在先）。
> 首次上机器的顺序是：`bootstrap` → 拿 `swuk_` 登录 → §6.14 生成 `swrk_` → §6.4 生成配对码 → 桌面设置页贴。
> **注册密钥只有 §6.14 一条创建路径** —— 不给 bootstrap 加第二条，省得两处各生成一半。

---

### 6.1 `POST /api/auth/login` — 登录密钥换会话

鉴权：无（这是入口）。限流：10/5min/IP。

```jsonc
// 请求
{ "key": "swuk_KJ8x…" }              // 明文登录密钥，48 字符
// 响应 200 —— 同时 Set-Cookie: swsession=<swst_…>; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000
{
  "user": { "id": "uuid", "name": "孙鹏", "email": null, "avatarUrl": null },
  "workspace": { "id": "uuid", "name": "scrumws", "slug": "scrumws" }
}
```

服务端：`sha256(key)` 查 `user_key`（`revoked_at is null`）→ 命中则更新 `last_used_at`、建 `user_session`（TTL 30 天）。
未命中 → 401 `UNAUTHORIZED`。**比较必须常数时间**（`crypto.timingSafeEqual`）或直接靠唯一索引等值查（后者即可，哈希查表不泄露时序）。

### 6.2 `POST /api/auth/logout`

鉴权：会话 cookie。置 `user_session` 行失效（删行）+ 清 cookie。→ 200 `{ "ok": true }`

### 6.3 `GET /api/auth/me`

鉴权：会话 cookie。→ 200 同 6.1 的响应体（前端启动时判是否已登录）。未登录 → 401。

### 6.4 `POST /api/machines/enrollment-codes` — 生成配对码

鉴权：会话 cookie。

```jsonc
// 请求
{}                                    // 无字段；workspace 取会话所属
// 响应 201
{
  "code": "7K3M9QXB",                 // ⚠ 明文只此一次返回
  "expiresAt": "2026-07-16T05:33:00.000Z",
  "ttlSec": 600
}
```

写 `enrollment_code`：`code_hash`、`code_prefix`、`workspace_id`、`created_by`（= 当前 user）、`expires_at = now()+10min`。
> `created_by` 会成为被注册机器的 `owner_user_id`（§6.5）—— 它是 P2 自动执行闸门 `owner-only` 档的判据，不是审计字段，别随手改。
> **配对码不是入场券的全部**：机器还必须带一把注册密钥（§6.14 生成）才能 enroll。两者都必填，理由见 §6.5.1。
> 前端可把「URL + rk + 本次 code」在浏览器里拼成一串 join token 供用户一次性粘贴（§6.17）—— **服务端不参与**，本端点的响应体里没有、也不可能有 rk。

### 6.5 `POST /api/machine/enroll` — 机器注册

鉴权：**无 Bearer**（机器此刻还没有令牌），凭**注册密钥 + 配对码两把一起验**。限流：10/5min/IP。
**这是全服务唯一匿名可达的写端点，且暴露在公网**（设计 §10）—— 注册密钥就是为它而存在的门口廉价拒绝。

```jsonc
// 请求
{
  "registrationKey": "swrk_Pt7w…",    // ⚠ 必填。48 字符明文。**门口最先校验**，见下
  "code": "7K3M9QXB",                 // ⚠ 必填。8 位配对码，**不因有了 rk 就可省**，见 §6.5.1
  "machineUid": "3f2a…",              // uuid，本地持久化，必填
  "displayName": "孙鹏的开发机",        // 可选；缺省用 hostname
  "hostname": "DESKTOP-ABC",          // os.hostname()
  "platform": "win32",                // process.platform
  "arch": "x64",                      // process.arch
  "appVersion": "0.1.0",              // package.json.version
  "claudeVersion": "2.1.207"          // 可 null（本机未装 claude）
}
// 响应 201
{
  "token": "swmt_9aQ2…",              // ⚠ 明文只此一次返回
  "machineId": "uuid",
  "workspaceId": "uuid",
  "workspaceName": "scrumws",
  "displayName": "孙鹏的开发机"
}
```

**服务端顺序（顺序本身就是契约的一部分，不许重排）**：

```
0. body 形状校验（字段缺失 / 非字符串 / machineUid 非 uuid）           → 400 BAD_REQUEST
   ⚠ 只校验「形状」，绝不校验凭据内容。凭据一律走第 1、2 步的 401。

1. ★ 最先校验 registrationKey ——「在任何 DB 查询和配对码校验之前」（设计 §6.1 ③）
   a. 前缀不是 'swrk_' 或长度 ≠ 48  → 401（连库都不查，纯字符串判断，零成本）
   b. verifyRegistrationKey(rk)：sha256 等值查 registration_key，revoked_at is null
      → 未命中 → 401
   命中 → 得到 workspace_id（rk 是实例级的，它**只**给出 workspace，不含任何身份信息）

2. 校验 code：sha256(code) 查 enrollment_code
   → 不存在 / used_at 非空 / expires_at < now() / workspace_id 与第 1 步不一致 → 401（全部同一个 401，见下）
   命中 → 得到 created_by

3. upsert machine on (workspace_id, machine_uid)：
   已存在 → 更新 hostname/platform/arch/版本/display_name、清 revoked_at
   不存在 → 插入，owner_user_id = enrollment_code.created_by   ← 这一步是 rk 给不出来的，见 §6.5.1

4. 重注册即轮换：该 machine 名下所有 machine_token.revoked_at 置 now()，再签发新令牌
   （同一台机器重装 / 换云端 URL 后不会留一堆活令牌）

5. 置 enrollment_code.used_at = now()、used_by_machine_id
6. 置 registration_key.last_used_at = now()（供 §6.15 判断「这把还有人在用吗」再撤销）

第 3–6 步同一个事务。第 1、2 步是只读校验，可在事务外。
```

#### ⚠ 401 语义：rk 失败与 code 失败**必须无法区分**

**第 1 步与第 2 步的一切失败，返回完全相同的响应**：

```jsonc
// HTTP 401，逐字节相同 —— 不许带 rk/code 各自的错误码，不许文案有别，不许靠响应时间区分
{ "error": { "code": "UNAUTHORIZED", "message": "注册密钥或配对码无效／已过期，请向管理员确认后重新生成配对码" } }
```

**为什么**（设计 §6.1 ③ 的原话）：若「rk 对了但 code 错了」返回 `ENROLL_CODE_INVALID`、而「rk 错了」返回 `UNAUTHORIZED`，那么攻击者拿垃圾 code 逐个试 rk，**错误差异就是一个完美的 rk 有效性 oracle** —— 两把一起验的「与」门当场退化成两把可以各个击破的独立锁。rk 是 32 字节随机（2^256），实践中猜不动，所以这个 oracle 的现实收益接近零；但**消除它的成本也接近零**，没有理由留着。

> **诚实标注代价**：合法用户配对码过期时，只会看到「无效／已过期」，得不到「是码过期了」这句精确提示。这是**明知的取舍**，不是遗漏 —— 文案里的「重新生成配对码」就是给这种情况的出路（重新生成一次总能救，且 TTL 只有 10min，过期是最常见的失败）。
> **别为了『体验好一点』把码分回去** —— 那正好把上面那句话作废。

实现注意：

- **计时**：第 1 步失败就直接返回，天然比第 2 步失败快 —— 严格说这是个计时侧信道。P0+P1 **不做**常数时间对齐（两步都是单次索引等值查，差异被公网 RTT 淹没，且 rk 不可猜），但**别再往第 1 步前面加任何耗时操作**放大它。
- **日志**：服务端日志里**可以**分开记 `rk_invalid` / `code_expired`（运维要排障），**但绝不进响应体**。日志里**绝不可**记 rk / code 的明文或完整哈希。

#### 6.5.1 为什么 rk **不能**替代配对码（两者都必填）

这是本设计最容易被「优化」掉的地方，先把理由钉死（设计 §5.1 / §9 决策 11）：

| | 注册密钥 `swrk_` | 配对码 |
|---|---|---|
| 回答 | 有资格加入吗 | 这台机器是**谁的** |
| 粒度 | **实例级**，一把管全体 | 一机一码，单次使用，TTL 10min |
| 含身份信息吗 | **否** | 是 —— `created_by` |
| 给出什么 | `workspace_id` | `machine.owner_user_id` |

**去掉配对码 → `machine.owner_user_id` 无从确定**（rk 是全体共用的，云端根本不知道是谁在贴）→ 设计 §7.3 的 `owner-only` 自动执行闸门（「自己派的直接跑，同事派的要确认」）**直接失效**，因为无从判断「发起人是不是机器主人」。

`owner_user_id` 是 `machine` 表的 **not null** 列（`001_p0p1_init.sql:124`）—— 迁移已经把这条做成物理约束了：**没有配对码，enroll 根本插不进去那一行**。

> 反过来也别把 rk 去掉：没有 rk，`/api/machine/enroll` 就是公网上匿名可达的写端点，任何人都能拿它撞配对码（40 bit 熵）。

#### 6.5.2 rk 只管入场，不管在场

**撤销注册密钥不影响任何已在线的机器** —— 它们靠机器令牌（`swmt_`）活着，enroll 早就结束了。

- 要**踢掉某台机器** → 撤 `machine_token`（§6.8 `/api/machines/:id/revoke`）
- 要**阻止新机器加入** → 撤 `registration_key`（§6.16）

这两件事**别混**。sweeper（§6.13）也只看 `last_seen_at`，从不看 rk。

### 6.6 `POST /api/machine/heartbeat` — 心跳（15s）

鉴权：`Authorization: Bearer swmt_…`

```jsonc
// 请求
{
  "claudeVersion": "2.1.207",         // 可 null
  "appVersion": "0.1.0",
  "load": { "processing": 2, "queued": 1, "cap": 5 }    // cap = runnerConfig.maxConcurrentRunners（0=不限）
}
// 响应 200
{ "serverTime": "2026-07-16T05:23:01.000Z", "machineId": "uuid" }
```

服务端：`machine` 置 `last_seen_at = now()`、`status='online'`、`claude_version`、`app_version`、`load_processing`、`load_queued`、`max_concurrent_runners = load.cap`；`machine_token.last_used_at = now()`。

> ⚠ **与设计 §6.2 的偏差**：设计的响应体是 `{ pendingIntents, pendingCommands, serverTime }`。P0/P1 没有意图/命令下行，这两个计数**恒为 0 且无人消费** → 不返回。P2 加回来时不会破坏本契约（新增字段向后兼容）。

**令牌被撤销 / 无效 → 401**。本地行为见 §7.4：401 是**终局**（清 `identity.json` + 停止上报），网络错误则是**重试**，两者绝不可混。

### 6.7 `GET /api/machines` — 机器列表

鉴权：会话 cookie。

```jsonc
// 响应 200
{
  "machines": [{
    "id": "uuid",
    "machineUid": "3f2a…",
    "displayName": "孙鹏的开发机",
    "owner": { "id": "uuid", "name": "孙鹏" },
    "hostname": "DESKTOP-ABC", "platform": "win32", "arch": "x64",
    "appVersion": "0.1.0", "claudeVersion": "2.1.207",
    "status": "online",                          // online | offline（由 sweeper 维护）
    "lastSeenAt": "2026-07-16T05:23:01.000Z",
    "load": { "processing": 2, "queued": 1, "cap": 5 },
    "enrolledAt": "2026-07-15T02:00:00.000Z",
    "revokedAt": null,
    "taskCounts": { "plan": 1, "queued": 1, "processing": 2, "awaitingHuman": 3, "done": 10, "archived": 40 }
  }]
}
```

只返回**会话所属 workspace** 的机器（§3.5）。默认隐藏 `revoked_at` 非空的，`?includeRevoked=1` 才带上。

### 6.8 `POST /api/machines/:id/revoke` — 撤销机器

鉴权：会话 cookie。置 `machine.revoked_at` + 该机器所有 `machine_token.revoked_at` = `now()`。→ 200 `{ "ok": true }`
下次心跳即 401 → 本地自行清理（设计 §6.1 的「解绑」云端侧）。**任务数据不删**（历史仍可看）。

> 这个端点不在 orchestrator 列的 P0 清单里，但设计 §7.1 把「云端可即时撤销」当作机器令牌相对用户 PAT 的核心优势在卖 —— 没有它，泄露的令牌无法止血，enroll 就成了单向门。判断：**保留**，成本 1 个端点。

### 6.9 `POST /api/machine/tasks/upsert` — 增量上报（P1 主干）

鉴权：`Bearer swmt_…`。**批量上限 50 条 / 请求**；body 上限 8MB。

```jsonc
// 请求
{
  "tasks": [{
    "taskKey": "manual:20260716132301-482",     // 本地 taskKey
    "rev": "a3f1…",                             // §5.2 算出的 40 位 hex
    "spec": {
      "title": "修复看板卡片排序",
      "prompt": "……",                           // 完整原文，可 null（未物化 CLI 会话没有 task.json）；最长 100000 字符
      "model": "claude-opus-4-8",               // 可 null
      "effort": "xhigh",                        // 可 null
      "cwd": "D:\\project\\scrumws-desktop",    // 可 null
      "worktree": false,
      "baseBranch": null,
      "description": null,
      "scheduledAt": null,                      // ISO-8601 或 null
      "source": "manual",                       // 仅元数据（不变式 2）
      "createdAt": "2026-07-16T05:23:01.000Z"   // ISO-8601 或 null
    },
    "status": {
      "state": "processing",                    // 显示态，见 §5.4
      "outcome": null,
      "enteredAt": "2026-07-16T05:23:01.000Z",
      "resolvedAt": null,
      "sessionId": "9c2f…",                     // 可 null
      "rounds": 3, "numTurns": 12,
      "totalCostUsd": 0.421337,
      "usage": { "input_tokens": 1234, "output_tokens": 567,
                 "cache_read_input_tokens": 89, "cache_creation_input_tokens": 0 },
                                                // ⚠ 原样透传 meta.usage（末轮快照），云端不得重新聚合
      "gitBranch": null,                        // 见 §9 已知缺口
      "worktreeBranch": "worktree-foo",         // 可 null
      "backgroundTaskCount": 0,
      "isArchive": false,
      "lastActivityAt": "2026-07-16T05:25:11.000Z"
    },
    "history": [
      { "seq": 0, "state": "queued",     "at": "2026-07-16T05:23:01.000Z", "by": "create:manual" },
      { "seq": 1, "state": "processing", "at": "2026-07-16T05:23:02.000Z", "by": "session" }
    ]
  }]
}
// 响应 200
{
  "accepted": 1,
  "results": [{ "taskKey": "manual:20260716132301-482", "taskId": "uuid", "ok": true }]
}
```

服务端**每条**在一个事务里：

1. `upsert task` on `(machine_id, local_task_key)`：
   - 不存在 → insert，`origin='local'`、`workspace_id` 取自机器、`creator_user_id = null`、spec 各列取 `spec.*`。
   - 已存在且 `origin='local'` → **更新 spec 各列**（本地是这类任务的 spec 权威）。
   - 已存在且 `origin='cloud'`（P2 才有）→ **不动 spec**。P1 不会走到这里；P2 接手时按设计 §9 决策 6 落 `local_spec`（该列本迁移未建，P2 自行加）。
2. `upsert task_status` on `task_id`（全列覆盖）+ `mirror='live'` + `synced_at=now()` + `rev` **原样存**。
3. `history` 同步：`upsert (task_id, seq)`，然后 **`delete from task_history where task_id=$1 and seq >= <本次条数>`**。
   > ⚠ **必须能截断，不能只 append**：CLI 观察态卡片的 history 是**每次扫描现场合成**的（`collect-cli.js:418-427`），那条 `awaiting-human` 的 `at` 会随最后活动时间**变化**，条数也会随状态增减。当成 append-only 会攒出幽灵历史。

**幂等**：同一 `(taskKey, rev)` 重复推 = 结果相同（全列覆盖，不累加）。丢包重推安全。

### 6.10 `POST /api/machine/tasks/digest` — 全量对账（每 5 分钟）

鉴权：`Bearer swmt_…`

```jsonc
// 请求 —— 必须是该机器**当前全部**卡片（6 个桶的全集），不是增量
{ "tasks": [ { "taskKey": "manual:2026…-482", "rev": "a3f1…" },
             { "taskKey": "cli:9c2f1a2b",     "rev": "77bd…" } ] }
// 响应 200
{
  "needFull": ["manual:2026…-482"],   // 云端没有 或 rev 对不上 → 机器下一 tick 全量推这些
  "markedMissing": 2                  // 本次被标 local_missing 的条数
}
```

服务端：

1. 取该 `machine_id` 下所有 `task` + `task_status.rev`、`mirror`。
2. 请求里有、云端没有 **或** rev 不等 → 进 `needFull`。
3. 请求里有、rev 相等、但 `mirror <> 'live'` → 复位 `mirror='live'`（机器回来了 / 本地又出现了）。
4. **云端有、请求里没有** → `task_status.mirror = 'local_missing'`（本地删了 plan 草稿 / 归档漂移）。**不删行、不动 state**。

### 6.11 `GET /api/tasks` — 云端看板

鉴权：会话 cookie。

```
GET /api/tasks?machineId=<uuid>&state=processing&mirror=live&q=<关键字>&limit=100&offset=0
    机器/状态/mirror 均可选；q 命中 title / prompt（ILIKE）；limit 默认 100、上限 200
```

```jsonc
// 响应 200
{
  "total": 137,
  "tasks": [{
    "id": "uuid",
    "machine": { "id": "uuid", "displayName": "孙鹏的开发机", "status": "online" },
    "origin": "local",
    "source": "manual",
    "title": "修复看板卡片排序",
    "cwd": "D:\\project\\scrumws-desktop",
    "model": "claude-opus-4-8", "effort": "xhigh",
    "worktree": false, "baseBranch": null,
    "localTaskKey": "manual:20260716132301-482",
    "createdAt": "2026-07-16T05:23:01.000Z",
    "status": {
      "state": "processing", "outcome": null,
      "enteredAt": "…", "resolvedAt": null, "lastActivityAt": "…",
      "rounds": 3, "numTurns": 12, "totalCostUsd": 0.421337,
      "backgroundTaskCount": 0, "isArchive": false,
      "mirror": "live", "syncedAt": "…"
    }
  }]
}
```

排序固定 `task_status.last_activity_at desc nulls last`（与本地看板各桶排序同源：`collect.js:225`）。

### 6.12 `GET /api/tasks/:id` — 任务详情

鉴权：会话 cookie。404 若不属于会话的 workspace。

```jsonc
// 响应 200 = 6.11 的单条 + 下列附加
{
  "id": "uuid", "…": "同 6.11 单条各字段",
  "prompt": "……",                       // 全文
  "description": null,
  "status": { "…": "同上", "sessionId": "9c2f…", "gitBranch": null, "worktreeBranch": "worktree-foo",
              "usage": { "input_tokens": 1234, "output_tokens": 567,
                         "cache_read_input_tokens": 89, "cache_creation_input_tokens": 0 } },
  "history": [ { "seq": 0, "state": "queued", "at": "…", "by": "create:manual" } ]   // 按 seq 升序
}
```

> `usage` 是**末轮快照**，`rounds` / `totalCostUsd` 是**累计** —— 这个不对称是 `collect.js:263-265` 的既定口径。前端展示时别把 usage 当累计画趋势图。

### 6.13 sweeper（云端内部 tick，非端口）

```
每 30s：
  update machine set status='offline'
   where status='online' and last_seen_at < now() - interval '90 seconds';
  -- 掉线机器的任务镜像标陈旧（只动新鲜度，不动执行真相）
  update task_status ts set mirror='stale'
    from task t where ts.task_id=t.id and ts.mirror='live'
      and t.machine_id in (<刚刚被置 offline 的机器>);
```

**90s 的推导**（设计 §6.2，抄 multica 的推导方法而非抄它的数）：心跳 15s + sweeper tick 30s = 45s，留 45s buffer → 90s。
multica 是 150s，因为它多一层 60s 的 Redis→DB flush 延迟；我们的心跳**直写** `last_seen_at`，没有那 60s。

**机器掉线时，云端不动任何任务状态** —— 这是本地权威最大的红利：任务在人家机器上活得好好的，笔记本合盖而已。真正的孤儿由本地 `runner-checker` 收（`jobs/runner-checker.js`，它本来就在干这事）。

> sweeper **不看 registration_key** —— rk 只管入场不管在场（§6.5.2）。

### 6.14 `POST /api/registration-keys` — 生成注册密钥

鉴权：**会话 cookie**（必须是登录后的人才能操作）。

```jsonc
// 请求
{ "label": "2026 上半年" }            // 可选，≤64 字符；纯备注，帮人认出「这把是哪把」
// 响应 201
{
  "id": "uuid",
  "key": "swrk_Pt7w…",                // ⚠⚠ 明文**只此一次返回**，云端此后再也拿不到（只存 sha256）
  "keyPrefix": "swrk_Pt7w",
  "label": "2026 上半年",
  "createdAt": "2026-07-16T05:23:01.000Z"
}
```

服务端：云端**自己生成**明文（§3.2 的 `swrk_` + base64url(32B)，**不是人设的口令**）→ 写 `registration_key`：`key_hash = sha256(明文全串)`、`key_prefix = 明文前 9 字符`、`workspace_id` 取会话所属、`created_by` = 当前 user。

> **前端红线**：明文 `key` 只在这一次响应里存在。UI 必须当场引导用户复制保存（配合 §6.17 的 join token），**且不得**写 localStorage / sessionStorage / URL / 任何日志。刷新即永久丢失，只能重新生成一把。

### 6.15 `GET /api/registration-keys` — 列出注册密钥

鉴权：会话 cookie。

```jsonc
// 响应 200 —— ⚠ 永不返回明文，也永不返回 key_hash
{
  "keys": [{
    "id": "uuid",
    "keyPrefix": "swrk_Pt7w",           // 只够人认出是哪把，不足以反推明文
    "label": "2026 上半年",
    "createdBy": { "id": "uuid", "name": "孙鹏" },
    "createdAt": "2026-07-16T05:23:01.000Z",
    "lastUsedAt": "2026-07-16T09:10:00.000Z",   // 最近一次 enroll 用到它；null = 从没用过
    "revokedAt": null                            // 非 null = 已撤销
  }]
}
```

只返回会话所属 workspace 的（§3.5）。默认含已撤销的（要看轮换历史）；`?activeOnly=1` 只返回 `revoked_at is null`。
排序 `created_at desc`。

> `lastUsedAt` 是**轮换的操作依据**：贴出新的一把 → 观察旧那把的 `lastUsedAt` 不再前进 → 撤销旧的。没有它，撤销就是闭眼睛拔线。

### 6.16 `POST /api/registration-keys/:id/revoke` — 撤销注册密钥

鉴权：会话 cookie。404 若不属于会话的 workspace（§3.4）。

```jsonc
// 请求：{} —— 无字段
// 响应 200
{ "ok": true, "id": "uuid", "revokedAt": "2026-07-16T10:00:00.000Z" }
```

置 `revoked_at = now()`（已撤销的再撤 → 幂等返回原 `revokedAt`，不报错）。

**撤销后**：该 rk 的一切 enroll 尝试 → 401（§6.5 第 1 步）。**已在线的机器不受任何影响**（§6.5.2）。

> **可多把并存 = 轮换不停机**：先 §6.14 生成新的 → 通知大家改用 → 待旧那把 `lastUsedAt` 不再动 → 撤销旧的。**别只留一把**，否则轮换 = 全员断新机入场。
> **允许撤到一把不剩**：那等于「暂时关闭新机器加入」，是个合法状态，不是错误 —— 不许加「至少保留一把」的校验。

### 6.17 join token — 三个字段打包成一串（纯前端约定，服务端不参与）

设置页要贴三样东西（URL / rk / 配对码），贴三次很烦。join token 把它们打包成一串。

```
joinToken = 'swjt_' + base64url(utf8(JSON.stringify({ v: 1, url, rk, code })))

  { "v": 1,                                  // 版本号，本期恒 1；解不出或 v≠1 → 视为无效
    "url": "https://cloud.example.com:8790", // 云端 base URL，无尾斜杠
    "rk":  "swrk_Pt7w…",                     // 注册密钥明文
    "code":"7K3M9QXB" }                      // 配对码明文
```

**⚠ 它由云端 Web 前端在浏览器里就地拼装，服务端既不生成也不存储、更不重新下发它**：

- 服务端**没有 rk 明文**可用 —— §6.14 之后库里只剩 sha256。所以 join token **不可能**由服务端在 §6.4（生成配对码）时拼出来。这不是偷懒，是「明文只展示一次」的直接推论。
- 浏览器侧三样都在手边：`url` = `window.location.origin`、`rk` = 用户手上那把（刚生成的那次响应，或用户粘进输入框的）、`code` = §6.4 的响应。前端 `btoa` 一下即可。
- 手上没有 rk 明文时，UI **只出配对码**，让机器主人自己贴 rk —— 不许为了拼出 join token 去让服务端存 rk 明文。

**它就是那三个字段本身，没有任何额外权限**，安全等级 = 里面的 rk + code（所以同样是 10min 内一次性的东西，别往 IM 群里长期留）。

本地解析见 §7.2 改动点 4（在**浏览器里**拆，不在服务端拆）。**解析失败一律静默不填**，不弹错、不猜 —— 用户手打三个字段的路径永远可用。

---

## 7. 本地新增 / 改动

### 7.1 新增文件（全部零运行时依赖）

```
platform/lib/cloud/identity.js     身份持久化
platform/lib/cloud/http.js         出站 HTTP（node:https/node:http 手写）
platform/lib/cloud/rev.js          §5.2 的指纹
platform/lib/cloud/synced.js       synced.json 读写
platform/lib/cloud/reconcile.js    对账（增量 + 全量 digest）
platform/lib/cloud/connector.js    生命周期与定时器（心跳 15s / 对账 15s / digest 5min）
```

磁盘布局（`P.tmpDir` = `$DATA_ROOT/runtime`，`paths.js:15`）：

```
$DATA_ROOT/runtime/cloud/identity.json    { machineUid, cloudUrl, machineId, token, workspaceId, workspaceName, enrolledAt }
$DATA_ROOT/runtime/cloud/synced.json      { "<taskKey>": "<rev>", … }
```

> `machineUid` 与 enroll **解耦**：未 enroll 时 `identity.json` 也可以只有 `{ machineUid }`。改机器名不该变成新机器（设计 §6.1，抄 multica 的教训）。

#### ⚠ 注册密钥**不落盘**（评审红线，设计 §5.1 / §9 决策 11）

**`registrationKey` 是入场券，只在 enroll 那一次 HTTP 请求体里出现，用完即弃。**

它**不得**出现在：

| 位置 | 说明 |
|---|---|
| `identity.json` | ❌ 上面的字段清单里没有 `registrationKey`，**这是穷举，不是举例** |
| `runner-config.json` | ❌ 那是热加载配置，rk 更不该进 |
| 任何其它配置 / 缓存 / 日志文件 | ❌ 包括 `lastError` 文案（**报错时别把请求体整个 dump 出来**） |
| `GET /api/cloud/status` 的响应 | ❌ `connectorStatus()` 的返回体里没有它（§7.1 的签名是穷举） |
| 内存中的长期驻留 | ❌ `enroll()` 的局部变量用完即出作用域；**不许**挂到模块级变量 / connector 状态上 |

**理由**（不是洁癖，是账算过的）：enroll 成功后，机器令牌（`swmt_`）已经能**自我维持**上报 —— 心跳、对账、重连全靠它，rk 一次也用不上了。留着 rk 只是在磁盘上多放一个**「能拉新机器入场」的常驻秘密**，换不来任何东西。

- **重新入场本来就该有人参与**：令牌被撤销（§7.4 的 401 终局）→ 本地清身份 → 人重新走一次「贴 rk + 贴新配对码」。这是**特性不是缺陷** —— 被踢下线的机器不该能自己爬回来，否则撤销就白撤了。
- 反面：若持久化 rk 想做「自动重新 enroll」，那还得连配对码一起持久化（否则 enroll 缺 `owner_user_id` 插不进去，§6.5.1）—— 而配对码是**单次使用 + TTL 10min** 的，存了也早就没用了。**这条路根本走不通**，别试。

#### `platform/lib/cloud/identity.js`

```js
/** @typedef {{machineUid:string, cloudUrl?:string, machineId?:string, token?:string,
 *             workspaceId?:string, workspaceName?:string, enrolledAt?:string}} Identity */

/** 读 identity.json；文件不存在 / 坏 JSON → null。绝不抛。 */
export function readIdentity(): Identity | null

/** 取 machineUid；无则 crypto.randomUUID() 生成并落盘（首次启动即调，与 enroll 无关）。 */
export function ensureMachineUid(): string

/** 合并写入（浅合并）+ 尽力 chmod 0600。返回合并后的完整 Identity。 */
export function saveIdentity(patch: Partial<Identity>): Identity

/** 解绑：删除 token/machineId/cloudUrl/workspace* 等云端字段，**保留 machineUid**。 */
export function clearCloudBinding(): Identity

/** 是否已 enroll（token 与 cloudUrl 齐全）。 */
export function isEnrolled(): boolean
```

#### `platform/lib/cloud/http.js`

```js
/** @typedef {{status:number, json:any|null, text:string}} CloudResponse */

/**
 * 出站 JSON 请求。零依赖：node:https（cloudUrl 为 http: 时用 node:http，仅供本地联调）。
 * 不抛 HTTP 状态错误（4xx/5xx 照常返回，由调用方判）；仅网络/超时/JSON 解析失败抛。
 * @param {{cloudUrl:string, token?:string}} target  token 给了就发 Authorization: Bearer
 * @param {'GET'|'POST'} method
 * @param {string} path      '/api/machine/heartbeat'
 * @param {any} [body]       JSON.stringify 后发送
 * @param {{timeoutMs?:number}} [opts]  默认 15000
 */
export async function cloudRequest(target, method, path, body, opts): Promise<CloudResponse>
```

#### `platform/lib/cloud/synced.js`

```js
/** 读 synced.json → { [taskKey]: rev }；不存在/坏 → {}。 */
export function readSynced(): Record<string, string>
/** 整体覆写（先写 .tmp 再 rename，避免半截文件）。 */
export function writeSynced(map: Record<string, string>): void
```

#### `platform/lib/cloud/rev.js`

```js
export const REV_ALGO: 'v1'
export function taskRev(card: object): string      // §5.2 逐字实现
```

#### `platform/lib/cloud/reconcile.js`

```js
/** 把 collectState() 快照的 6 个 lifecycle 桶摊平成卡片数组（顺序无关）。 */
export function flattenCards(snapshot: object): object[]

/** 单卡 → upsert 载荷（读 task.json 补 prompt；时间串转 ISO）。 */
export function buildUpload(card: object): object

/**
 * 一轮对账。
 * @param {{cloudUrl:string, token:string}} target
 * @param {object} snapshot  getState() 的结果
 * @param {{full?:boolean}} [opts]  full=true 则先跑 digest、把 needFull 并入待推集合
 * @returns {Promise<{pushed:number, needFull:string[], markedMissing:number, errors:string[]}>}
 */
export async function reconcileOnce(target, snapshot, opts): Promise<object>
```

`reconcileOnce` 的算法（**这是 P1 的心脏**）：

```
1. cards = flattenCards(snapshot)                       // 不触发扫描，快照由调用方给
2. cur   = { card.taskKey: taskRev(card) }
3. prev  = readSynced()
4. changed = cards.filter(c => prev[c.taskKey] !== cur[c.taskKey])
5. if (opts.full):
     digest = POST /api/machine/tasks/digest { tasks: cards.map(c => ({taskKey, rev: cur[taskKey]})) }
     changed ∪= cards.filter(c => digest.needFull.includes(c.taskKey))
6. 分批（50/批）POST /api/machine/tasks/upsert
7. **只把本批真正 200 成功的 taskKey 写进 synced.json**（失败的保持旧 rev → 下一 tick 自动重试）
8. synced.json 收缩：删掉 cur 里已不存在的 taskKey（本地任务没了就别攒着）
```

> 第 7 步是自愈的关键：`synced.json` 是「**已确认云端收到**」的账本，不是「我打算推」的账本。推失败就别记账 —— 对账循环下一轮自然补上（设计 §6.3「对账循环天然自愈，漏一次下次补上」）。

#### `platform/lib/cloud/connector.js`

```js
/** 启动定时器（心跳 15s、对账 15s 同 tick、全量 digest 每 5min）。未 enroll → 空转不报错。幂等。 */
export function startConnector(): void
/** 停止全部定时器。 */
export function stopConnector(): void
/**
 * 设置页用。⚠ 返回字段是**穷举**：这里**没有** registrationKey，也永远不许加（§7.1 红线）。
 */
export function connectorStatus(): {
  enrolled: boolean, cloudUrl: string|null, machineId: string|null, workspaceName: string|null,
  machineUid: string,
  lastHeartbeatAt: string|null, lastHeartbeatOk: boolean|null,
  lastReconcileAt: string|null, lastPushed: number, lastError: string|null,
  syncedCount: number
}

/**
 * 注册：调 /api/machine/enroll → 落 identity.json → 立刻起 connector。
 * @param {{cloudUrl:string, registrationKey:string, code:string}} args
 *   - registrationKey  swrk_ 明文。⚠ **只作为请求体字段用一次，绝不落盘、绝不留驻内存**（§7.1）
 *   - code             8 位配对码明文。同样用完即弃
 * 落 identity.json 的只有：{ machineUid, cloudUrl, machineId, token, workspaceId, workspaceName, enrolledAt }
 * ⚠ error 文案只能用云端返回的 message，**不得**把请求体（含 rk）拼进去。
 */
export function enroll({ cloudUrl, registrationKey, code }): Promise<{ok:boolean, error?:string, workspaceName?:string}>

/** 解绑：停 connector + clearCloudBinding()（不通知云端；云端靠 90s stale 自然置 offline）。 */
export function unenroll(): { ok: boolean }
```

**tick 编排**（一个 15s 定时器串起来，别开三个各跑各的）：

```js
// 第 N 次 tick：
const snap = await getState({ maxAgeMs: 15000 });      // ← 关键：不自己触发扫描，见 §8
await heartbeat(snap);                                  // load 取自同一快照
await reconcileOnce(target, snap, { full: N % 20 === 0 });   // 20 × 15s = 5min 一次全量 digest
```

心跳 load 的取值（全部来自同一快照，零额外 I/O）：

```js
load = {
  processing: snap.lifecycle.processing.length,
  queued:     snap.lifecycle.queued.length,
  cap:        snap.runnerConfig.maxConcurrentRunners,   // collect.js:390
}
claudeVersion = snap.runtime.version                    // collect.js:324
```

### 7.2 改动既有文件（四处，都往小了改）

**改动点 1 — `platform/lib/collect.js`：缓存层**（设计 §6.3 明说这是「本设计对现有代码唯一的侵入性改动」）。接口见 §8。

**改动点 2 — `platform/lib/collect.js`：`collectOne()` 补两个字段**（理由见 §5.3）

```js
// 在 collectOne 的返回体里加（紧邻已有的 description / effort 字段）：
model: task?.model || null,                                    // 任务配置的模型（rev 指纹需感知其变化）
promptSha: task?.prompt ? sha1(task.prompt) : null,            // prompt 指纹（原文最长 100000 字符，不进卡片）
```

两者都取自**已读入的** `task` 对象（`collect.js:71`），零额外 I/O。`sha1` 用 `node:crypto`（collect.js 尚未引入，需加 import）。

**改动点 3 — `platform/server.js`：3 个本地端点 + 起 connector**

```js
GET  /api/cloud/status     → sendJson(200, connectorStatus())
                             // ⚠ 响应体里没有 registrationKey（§7.1 红线）。它压根不在进程里。
POST /api/cloud/enroll     body { cloudUrl, registrationKey, code } → enroll(...)   // 设置页「连接云端」
                             // ⚠ 只收这三个显式字段，**不收 joinToken** —— 拆包在浏览器做（改动点 4）。
                             //   三者任一缺失/非字符串 → 400 { ok:false, error:'...' }（照 server.js 既有风格）
POST /api/cloud/unenroll   → unenroll()                               // 设置页「断开」
```

> `/api/cloud/enroll` 是**唯一**碰到 rk 的本地代码路径：收到 → 转发给云端 → 函数返回即出作用域。**不写盘、不记日志、不进 `lastError`**。

`/api/state` 改为 `await getState({ maxAgeMs: 3000 })`（原 `collectState()`）。

connector 的启动位置与**已有的 usage timer 完全对齐**（`server.js:612-614`）——只在持 `scheduler.lock` 的主实例起，副实例「只看不调度」不重复上报：

```js
const mode = scheduler.start();
if (mode === 'running') { startUsageTimer(); startConnector(); }   // ← 只加后半句
```

`ensureMachineUid()` 在 `start()` 里无条件调一次（与 enroll 无关，首启即生成）。

**改动点 4 — `platform/public/app.js`：设置页「云端」区块**

设置页已存在（`app.js:1062` 的 `ROUTE_VIEWS` 含 `'settings'`，路由 `#/settings`，`app.js:1081`）。在其中加一个「云端」区块。

**未连接时 —— 三个输入（缺一不可，§6.5.1）**：

| 输入 | 字段 | 说明 |
|---|---|---|
| 云端 URL | `cloudUrl` | `https://<host>:8790`，去尾斜杠后提交 |
| **注册密钥** | `registrationKey` | `swrk_…`，管理员给的。`type=password` + 「显示」切换 |
| **配对码** | `code` | 8 位，云端「添加机器」现生成，10min 内有效 |

外加一个**可选**的粘贴框：

```
[ 粘贴 join token（可选，自动填下面三项） ]
```

`onpaste` / `oninput` → 就地拆包（§6.17），**纯浏览器行为，不发给任何服务端**：

```js
// app.js 内，~8 行，无依赖
function parseJoinToken(s) {
  const t = String(s || '').trim();
  if (!t.startsWith('swjt_')) return null;
  try {
    const o = JSON.parse(decodeURIComponent(escape(atob(
      t.slice(5).replace(/-/g, '+').replace(/_/g, '/')))));   // base64url → base64 → utf8
    if (o?.v !== 1 || !o.url || !o.rk || !o.code) return null;
    return { cloudUrl: String(o.url), registrationKey: String(o.rk), code: String(o.code) };
  } catch { return null; }
}
// 命中 → 填三个输入框（让用户**看见** URL 再点连接）；返回 null → 静默不填，用户手打
```

> **为什么在浏览器拆而不在服务端拆**：① 拆完填进输入框，用户能**看见**自己将要连的 URL 再点「连接」—— 服务端拆则是个黑盒；② `/api/cloud/enroll` 的入参保持「三个显式字段」一条清晰路径，畸形 token 根本到不了服务端；③ 「参数归参数」——`joinToken` 只是 UI 输入法的糖，不是 API 概念。

点「连接」→ `POST /api/cloud/enroll { cloudUrl, registrationKey, code }`。
**成功后立刻清空三个输入框与粘贴框的值**（rk / code 用完即弃，别留在 DOM 里）。失败则**只清 rk 与 code**（URL 留着，省得重打）。

**已连接时**：展示 `connectorStatus()` 的字段（workspaceName / machineId / machineUid / 最近心跳 / 最近对账 / 已同步卡数 / lastError）+ 一个「断开」按钮 → `POST /api/cloud/unenroll`。
**⚠ 这里没有「注册密钥」这一行可展示 —— 本地压根没存它**（§7.1）。

### 7.3 cloud 白名单 / 自动执行闸门：P0+P1 **不实现**

`runner-config.json` 的 `cloudAllowedCwds`（设计 §7.2）与 `acceptAutoRun`（§7.3）都是**下行才需要的闸门**。P0+P1 纯出站只读、零 RCE 面 → 不加这两个配置项、不加读它们的代码。P2 单独评审时再加。

### 7.4 401 是终局，网络错误是重试 ⚠ 绝不可混

| 情形 | 判据 | 动作 |
|---|---|---|
| 令牌被撤销 / 无效 | HTTP **401** | `clearCloudBinding()` + `stopConnector()` + 设置页显示「已被云端解绑」。**不重试** |
| 云端 5xx / 超时 / DNS / ECONNREFUSED | 抛异常或 status ≥ 500 | 记 `lastError`，**下一 tick 照常重试**。不动 `identity.json`、不动 `synced.json` |
| 4xx（非 401） | 400 / 409 等 | 记 `lastError` 并跳过该条，不清身份 |

把网络抖动当撤销 = 用户笔记本换个 WiFi 就被踢下线，得重新配对。把撤销当网络抖动 = 撤销失效、令牌止不了血。

### 7.5 Windows 注意

connector 全程只做 HTTP + 读写 JSON，**不 spawn 任何进程**，不涉及 `.cmd`。
（仓库既有的 `spawn .cmd` 必带 `shell:true` + `windowsHide:true` 规矩见 `collect.js:245` 的注释，本次不碰。）

---

## 8. `collect.js` 缓存层接口

### 8.1 为什么必须有

`collectState()` 是全量重扫：`readdir` + 每个任务包读 5 个 JSON（`collect.js:71-75`）+ 反读 jsonl 数后台子 agent（`collect-cli.js`）。
**但前端本来就在轮询它**。所以 connector **不得自己触发扫描** —— UI 与 connector 必须共享同一次扫描结果（设计 §6.3）。

### 8.2 导出

```js
/** 默认 TTL。/api/state 用这个值。 */
export const STATE_CACHE_TTL_MS = 3000;

/** 原样保留：无条件全量扫描。扫完写缓存 + 广播。（现有调用方与测试不受影响） */
export async function collectState(): Promise<object>

/**
 * 缓存 + single-flight 入口。**所有新调用方都走这个，不要直接调 collectState()**。
 * @param {{maxAgeMs?: number}} [opts]
 *   - 缓存年龄 <= maxAgeMs           → 直接返回缓存（不扫描）
 *   - 否则若已有扫描在飞             → await 那一次（single-flight，绝不并发双扫）
 *   - 否则                           → 发起扫描
 * maxAgeMs=0 → 强制新鲜（等价 collectState()，但仍参与 single-flight）
 */
export async function getState(opts?): Promise<object>

/** 同步取最后一次快照，**永不触发扫描**。从没扫过 → null。 */
export function peekState(): { snapshot: object, at: number } | null

/** 订阅：每次扫描成功完成后回调（同一快照对象，只读，勿改）。返回退订函数。 */
export function onState(listener: (snapshot: object) => void): () => void
```

### 8.3 TTL 语义与取值依据（回答设计 §9b.1 的「要实测」）

**实测到的前端轮询频率**：默认 **15s**，用户可在设置页调，夹在 **[5s, 600s]**（`app.js:6`：`REFRESH_MS_MIN=5000, REFRESH_MS_MAX=600000, REFRESH_MS_DEFAULT=15000`；`app.js:3043` 是 `setInterval(refreshState, refreshStateMs)`）。

| 调用方 | `maxAgeMs` | 效果 |
|---|---|---|
| `/api/state`（UI） | `3000` | **UI 永远不会被降级**：它最快也只有 5s 一次（>3s），每次必然重扫。TTL 3s 在这里只起「合并瞬时并发请求」的作用（多标签页 / modal 关闭时的补拉）。 |
| connector | `15000` | **几乎总是白嫖 UI 那次扫描**：UI 默认 15s 一扫，connector 的 15s 窗口基本必然命中缓存。 |

扫描次数账（这是**净减少**，不是新增开销）：

| 场景 | 改造前 | 改造后 |
|---|---|---|
| UI 开着（默认 15s） | 4 次/分 | **4 次/分**（connector 全部命中缓存，+0） |
| UI 开着（调到最快 5s） | 12 次/分 | **12 次/分**（connector +0） |
| UI 关着（窗口最小化 / 无浏览器） | 0 次/分 | **4 次/分**（connector 自己触发，这是上报必需的） |

> 所以 connector 用「**拉 + TTL**」而不是「订阅」：UI 关着时没人扫，光订阅永远收不到快照、机器就静默失联了。`onState` 保留给「想更快感知」的场景（用户点确认执行 → UI 立刻轮询 → connector 可借这次广播提前推），**P0+P1 的 connector 不用它** —— 15s 的上报延迟对只读看板完全够，少一个并发路径少一类 bug。

### 8.4 实现约束

- **single-flight 必须真做**：`let inflight = null;` 扫描期间所有 `getState` 复用同一 Promise。否则 UI + connector 撞在同一秒 = 两次全量扫描，比不加缓存还糟。
- 扫描**抛异常**时：不更新缓存、不广播、`inflight` 必须清空（`finally`），异常照常抛给调用方。旧缓存保留（陈旧好过没有）。
- `onState` 的监听器抛异常必须被 catch + 记日志，**不得**影响扫描结果或其它监听器。
- 快照对象**共享引用**（不深拷贝）。消费方只读。`reconcile` / `heartbeat` 都只读。

---

## 9. 已知缺口（诚实标注，别当成实现 bug 去改）

1. **`task_status.git_branch` 在 P1 基本恒为 null**。
   `collect.js:154-162` 的 meta 投影只有 `{sessionId, sessionHistoryLen, rounds, totalCostUsd, numTurns, usage, lastRoundAt}` —— **没有 `gitBranch`**；而 `meta.gitBranch` 本身也只有 `materializeCliTask`（`task-actions.js:252`）会写，常规任务的 `task-runner` 根本不写它（`worktreeBranch` 写了，`task-runner.js:235`）。
   → P1 只有 CLI 观察态卡片能提供 `card.cli.gitBranch`。托管任务要拿分支只能反读 jsonl（`logs.js:246` 的 `latestGitBranchBySid`）—— 那是 connector **绝不该做**的昂贵 I/O。
   列先留着（设计 §5.3 有），值先 null。**这个坑历史上修过两次才根治（PR #8），别拍脑袋在 connector 里补扫。**

2. **`other` 桶的任务不上行**。`collectState()` 的 `lifecycle` 只导出 6 个桶（`collect.js:381-388`），`collectAll` 里的 `other` 桶（承接历史遗留 state，如已废除的独立 `cancelled` 态，`collect.js:182`）**没有出口**。
   → 这类任务云端看不到。是既有 `/api/state` 形状的固有限制，非本次引入；要修得先改 `/api/state`，超出 P1 范围。

3. **prompt 的真实上限是 100000 字符，不是设计 §6.5 说的 32KB**。
   `server.js:418` 的 32KB 是 `/api/task/create` 的**整个 body** 上限；而 `materializeCliTask` 直接 `.slice(0, 100000)`（`task-actions.js:223`）。契约按 **100000 字符**定，upsert 批量取 50 条/批以兜住 body 体积。

4. **`task_history.by` 可空**，与设计 §5.3 的 `by text not null` 冲突 —— 真实数据说了算：`collect-cli.js:421-425` 合成的 CLI 时间线前两条只有 `{state, at}`。迁移已按真实数据放宽。

5. **多机器跑同一仓库**（设计 §9b.4）：各自 enroll、各自独立 machine，云端会看到两份任务流。符合真相；UI 按机器分组怎么设计**没想清楚**，P1 先平铺 + 机器筛选（§6.11 的 `machineId` 参数）。

6. **`task_history` 增长与保留期没估算**（设计 §9b.5）。P1 不做清理。

---

## 10. 迁移的执行与回滚

### 10.1 状态：**已应用**（12 张表已落 `scrumws` 库）

`cloud/migrations/001_p0p1_init.sql` **已实跑进库并经独立只读命令核实**。后来者**不要重跑、不要 drop** —— 库已经是对的。

**执行方式**（本机 Windows 无 psql，走 docker；`postgres:17-alpine` 客户端连 18.3 服务端）：

```bash
# DATABASE_URL 只经 env 传递，绝不落进命令行/日志/源码
cd <repo-root>
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)"; export DATABASE_URL
MSYS_NO_PATHCONV=1 docker run --rm -e DATABASE_URL \
  -v "$(pwd)/cloud/migrations:/m:ro" postgres:17-alpine \
  sh -c 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /m/001_p0p1_init.sql'
```

### 10.2 核实（独立只读命令，这是「已应用」的依据）

```bash
docker run --rm -e DATABASE_URL postgres:17-alpine sh -c 'psql "$DATABASE_URL" -c "\dt"'
```

`\dt` 实测输出（2026-07-16，库 `scrumws`；owner 一列是 **`DATABASE_URL` 的连接用户**（不是 `.env` 的 `USERNAME`，两者不同值），属连接串片段 → 按凭据规矩打码为 `<owner>`）：

```
              List of relations
 Schema |       Name       | Type  |  Owner
--------+------------------+-------+---------
 public | app_user         | table | <owner>
 public | enrollment_code  | table | <owner>
 public | machine          | table | <owner>
 public | machine_token    | table | <owner>
 public | member           | table | <owner>
 public | registration_key | table | <owner>     ← 注册密钥（§3.1 / §6.14–6.16）
 public | task             | table | <owner>
 public | task_history     | table | <owner>
 public | task_status      | table | <owner>
 public | user_key         | table | <owner>
 public | user_session     | table | <owner>
 public | workspace        | table | <owner>
(12 rows)
```

`\d registration_key` 实测（确认三凭据里最新的那张表的列与设计 §5.1 一致）：

```
    Column    |           Type           | Nullable |      Default
--------------+--------------------------+----------+-------------------
 id           | uuid                     | not null | gen_random_uuid()
 workspace_id | uuid                     | not null |
 key_hash     | text                     | not null |            -- sha256，unique
 key_prefix   | text                     | not null |            -- 'swrk_ab12'
 label        | text                     |          |
 created_at   | timestamptz              | not null | now()
 created_by   | uuid                     | not null |
 last_used_at | timestamptz              |          |            -- §6.15 轮换依据
 revoked_at   | timestamptz              |          |            -- §6.16 撤销
Indexes:
    "registration_key_pkey" PRIMARY KEY, btree (id)
    "registration_key_key_hash_key" UNIQUE CONSTRAINT, btree (key_hash)   ← §6.5 门口等值查走它
    "registration_key_live_idx" btree (workspace_id) WHERE revoked_at IS NULL
Foreign-key constraints:
    "registration_key_created_by_fkey"   FOREIGN KEY (created_by) REFERENCES app_user(id)
    "registration_key_workspace_id_fkey" FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE
```

列数核对（迁移文件 vs 库，全部一致）：

| 表 | 列数 | | 表 | 列数 |
|---|---|---|---|---|
| `app_user` | 5 | | `registration_key` | **9** |
| `workspace` | 4 | | `machine` | 17 |
| `member` | 4 | | `machine_token` | 7 |
| `user_key` | 8 | | `enrollment_code` | 9 |
| `user_session` | 6 | | `task` | 18 |
| `task_status` | 18 | | `task_history` | 5 |

### 10.3 回滚（P1 前无数据，直接重来）

```sql
drop table if exists task_history, task_status, task, enrollment_code, machine_token,
                     machine, registration_key, member, workspace,
                     user_session, user_key, app_user cascade;
```

> ⚠ 上面 12 个表名是**当前全集**（含 `registration_key`）。改迁移时这条 drop 也要跟着改，否则重来会留残表。

**没有迁移账本表**：本文件是裸 SQL，跑一次即可。`cloud/` 将来若引入 `node-pg-migrate`，由它自建 `pgmigrations` 表管后续版本，避免两套账本打架。

> ⚠ **多 worktree 共用同一远程 dev 库**：本库当前只有本次这一份迁移（编号 001 未被占用，执行前 `\dt` 实测 0 表）。并行 worktree 若也要加迁移，**取未占用编号**，且重建约束时列**当前全集** —— 否则互相覆盖。

---

## 11. 云端技术栈与目录（与根 package.json 完全隔离）

```
cloud/
├── package.json          fastify + pg（+ dev: 无强制）。**与根 package.json 无任何关系**
├── migrations/
│   └── 001_p0p1_init.sql
├── scripts/
│   └── bootstrap.mjs     §6.0，必须支持 --check
├── src/
│   ├── server.ts|js      Fastify 实例、8790
│   ├── db.js             pg Pool，读 process.env.DATABASE_URL
│   ├── auth.js           §3 的三种凭据校验 —— verifyUserKey / verifyRegistrationKey /
│   │                     verifyMachineToken **三个独立函数**，禁止通用化（§3.1.1 红线）
│   ├── routes/user.js    §6.1–6.3, 6.4, 6.7, 6.8, 6.11, 6.12,
│   │                     **6.14–6.16（注册密钥的生成/列出/撤销，登录后的人才能操作）**（人类鉴权）
│   ├── routes/machine.js §6.5（enroll：门口先验 rk）, 6.6, 6.9, 6.10（机器鉴权）
│   └── sweeper.js        §6.13
└── public/               云端前端（复用 platform/public 看板风格，见 docs/spec/multica-style-guide.md）
```

**配置全部走 env，不走源码**（`.env` 的值绝不进任何源码 / 文档 / 日志 / 提交）：

| env | 说明 |
|---|---|
| `DATABASE_URL` | Postgres 连接串。**只从 process.env 读** |
| `CLOUD_PORT` | 默认 8790 |

> 设计 §9b.7 记的部署收口（Postgres 端口当前从公网可直连，上线后应只对云端服务开放）不属本契约，但没人做就是个洞。
> 具体主机 / 端口见 `.env`，**不在此复述** —— 连接串的任何片段都不进源码 / 文档 / 日志 / 提交。
