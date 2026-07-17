# 云端控制面（cloud/）· P0 + P1

全团队 agent 运行态的**只读大盘**：机器在线状态 + 任务卡镜像。

- **P0 身份与连线**：登录密钥 / 注册密钥 / 配对码 / enroll / 心跳 / 机器列表
- **P1 状态上行**：机器增量上报任务卡 + 每 5min 全量对账 → 云端看板 / 任务详情
- **不做**：WS、意图下行、命令下行、transcript 拉流、cron（P2+，单独评审）

契约与设计（有冲突以契约为准，它逐条标了偏差与理由）：

- 实现契约：[`docs/spec/cloud-p0p1-contract.md`](../docs/spec/cloud-p0p1-contract.md)
- 设计权威：[`docs/spec/cloud-control-plane.md`](../docs/spec/cloud-control-plane.md)

## 三条不许拆的不变式

1. **云端永不写 `task_status` 的业务字段**。`task`（spec）与 `task_status`（执行真相镜像）分表：
   `task_status` / `task_history` **只由机器鉴权的 upsert / digest handler 写**。
   唯一例外是 sweeper，它只改 `mirror`（镜像新鲜度），`state` / `outcome` 一个字节都不动。
2. **`source` / `origin` 只是来源元数据，不是行为开关**。分支一律按 `state` 走，
   绝不写 `startsWith('cloud:')` / `source === 'cloud'` 这类来源特判。
3. **`cloud/` 与仓库根完全隔离**。本目录有自己的 `package.json`（fastify + pg + @fastify/static）。
   根 `package.json` 只有 electron / electron-builder 两个 devDep，`platform/` 零运行时依赖 —— **别往根加依赖**。

## 三种凭据，三张表，三条校验路径（严禁共用）

| 凭据 | 前缀 | 回答什么 | 表 | 校验函数 |
|---|---|---|---|---|
| 登录密钥 | `swuk_` | **你是谁** | `user_key` | `verifyUserKey()` |
| 注册密钥 | `swrk_` | **这台机器有资格加入这个云端吗** | `registration_key` | `verifyRegistrationKey()` |
| 机器令牌 | `swmt_` | **这台机器是哪台** | `machine_token` | `verifyMachineToken()` |
| （派生）Web 会话 | `swst_` | 浏览器载体 | `user_session` | cookie `swsession` |

四者格式**刻意完全同构**（`<prefix>_` + base64url(32B)，48 字符，`sha256(明文全串)` 存哈希）——
正因如此，**区分它们的唯一手段是「查哪张表」，而那必须由函数身份决定、不能由参数决定**。
`src/auth.js` 里三个函数各自把前缀写死成字面量，**禁止**抽成 `verifyCredential(pt, { table, prefix })`：
前缀一旦成为参数，一个传参错误就让 `swmt_` 冒充 `swrk_` 过闸，而类型系统救不了你（都是 string）。

**rk 只管入场，不管在场**：撤销注册密钥**不影响**任何已在线机器（它们靠机器令牌活着）。
要踢掉某台机器 → 撤 `machine_token`（`POST /api/machines/:id/revoke`）；要阻止新机器加入 → 撤 rk。**这两件事别混。**

## 起服务

```powershell
cd cloud
npm install

# DATABASE_URL 只从 env 读（仓库根 .env 里有；**绝不可写死进源码 / 文档 / 日志 / 提交**）
$env:DATABASE_URL = (Select-String -Path ..\.env -Pattern '^DATABASE_URL=').Line.Substring(13)
npm start                      # 监听 8790：API 与 Web 界面**同一个端口**
```

浏览器开 `http://<host>:8790/` 即是云端看板（登录页 → 看板 / 机器 / 任务详情）。

| env | 说明 |
|---|---|
| `DATABASE_URL` | Postgres 连接串。**只从 process.env 读**，缺了直接拒启 |
| `CLOUD_PORT` | 默认 `8790` |
| `CLOUD_INSECURE_COOKIE` | `=1` 摘掉会话 cookie 的 `Secure`，裸 HTTP 可用（**仅内网/可信链路**）。默认带 `Secure` |
| `CLOUD_ACCEPT_PLAINTEXT_DISPATCH` | `=1` 在明文链路上**放行下行面**（手机中继 downlink/rpc/watch/`/api/my/*` 与将来 P2 派活）。缺它 + `INSECURE=1` + 绑非 localhost → 下行面全 503。**明写它 = 明确接受「明文派活可被链路上任何人冒充」** |

存活探针：`GET /api/health` → `{"ok":true}`（不碰库）。

### Web 界面由本服务自己托管（别另起静态站）

`public/` 由 `@fastify/static` 挂在**同一个 8790** 上（`src/server.js`）。这不是随手一挂 —— 是硬约束：
`public/app.js` 用**相对路径** `/api/…` + `credentials:'same-origin'` 发请求，会话是 `HttpOnly` cookie。
**静态站与 API 分家就拿不到 cookie，登录立刻废掉。**

前端是 **hash 路由**（`public/app.js` 读 `location.hash`），浏览器只会请求 `/` 与 `/app.js` →
**不需要 SPA history 回退**；取不到的资源照常落 404，`/api/*` 未命中仍是统一 JSON 错误体。

> ⚠ 改前端时别把它挪去反代 / CDN 单独托管，也别把 `api()` 改成绝对 URL —— 会同时踩上面两条。
> **踩过**：验收期一度只有 `docs/acceptance/cloud-p0p1/round-1/mock-baseline/mock-cloud-server.mjs` 托管静态文件，
> 前端全程对着 mock 验、真实 `server.js` 从没托管过 —— 按 README 起服务后浏览器打开根路径只会拿到
> `{"error":{"code":"NOT_FOUND"}}`，登录页都出不来。**验前端务必对着真实 8790，不是 mock。**

> ⚠ 本地看板 8799 是用户正在跑的桌面 app —— 云端服务与它毫无关系，**不碰它**。

## 建首个用户和登录密钥（bootstrap）

无密码、无注册、无 OAuth ⇒ **第一个 user / workspace / 登录密钥只能由服务端脚本创建**。

```powershell
# 先跑零副作用自检：连库 + 验 12 张表齐全 + 打印将要做什么，不写任何行
node scripts/bootstrap.mjs --name "孙鹏" --workspace "scrumws" --check

# 真正执行
node scripts/bootstrap.mjs --name "孙鹏" --workspace "scrumws"
```

- **登录密钥明文只打印一次**，库里只落 `sha256` + `key_prefix`。丢了只能重跑一次补发一把。
- **幂等**：同 slug 的 workspace 已存在 → 复用，只补发密钥，不重建。
  同 workspace 内同名的人视为同一个人（`--name` 是识别依据）。
- `--slug`：workspace 名是纯中文时 slug 会生成为空，此时必须显式给（如 `--slug scrumws`）。
- `--label`：登录密钥备注，默认 `bootstrap`。
- **bootstrap 不生成注册密钥** —— `registration_key.created_by` 是 not null，本就需要一个 user 在先。
  注册密钥只有 `POST /api/registration-keys` 一条创建路径，不给 bootstrap 加第二条。

## 上第一台机器（顺序固定）

```
bootstrap → 拿 swuk_ 登录 → 生成 swrk_ 注册密钥 → 生成配对码 → 桌面设置页贴
```

```bash
# 1) 登录（拿到 swsession cookie）
curl -sc jar -X POST https://<host>:8790/api/auth/login \
     -H 'content-type: application/json' -d '{"key":"swuk_…"}'

# 2) 生成注册密钥 —— 明文**只此一次**返回，云端此后只有 sha256
curl -sb jar -X POST https://<host>:8790/api/registration-keys \
     -H 'content-type: application/json' -d '{"label":"2026 上半年"}'
#   → { "id":"…", "key":"swrk_…", "keyPrefix":"swrk_Pt7w", … }
#   UI 必须当场引导用户复制保存，且不得写 localStorage / URL / 任何日志。

# 3) 生成配对码（TTL 10min，单次使用）
curl -sb jar -X POST https://<host>:8790/api/machines/enrollment-codes \
     -H 'content-type: application/json' -d '{}'
#   → { "code":"7K3M9QXB", "expiresAt":"…", "ttlSec":600 }

# 4) 桌面设置页贴：云端 URL + 注册密钥 + 配对码（三者缺一不可）
```

**为什么 rk 和配对码两把都要**：rk 答「有资格加入吗」（实例级，**不含身份信息**）；
配对码答「这台机器是**谁的**」（定 `machine.owner_user_id`，是 P2 `owner-only` 自动执行闸门的判据）。
去掉配对码 → `owner_user_id` 无从确定 → 那个闸门直接失效。`machine.owner_user_id` 是 **not null**，
迁移已经把这条做成物理约束：**没有配对码，enroll 根本插不进去那一行**。

**轮换注册密钥**（可多把并存 = 不停机）：生成新的一把 → 通知大家改用 →
观察旧那把的 `lastUsedAt` 不再前进（`GET /api/registration-keys`）→ 撤销旧的。
**别只留一把**，否则轮换 = 全员断新机入场。允许撤到一把不剩（= 暂时关闭新机器加入，是合法状态）。

## 端点

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `POST /api/auth/login` | 无（入口） | swuk_ 换会话 cookie。限流 10/5min/IP |
| `POST /api/auth/logout` | 会话 | 删会话行 + 清 cookie |
| `GET /api/auth/me` | 会话 | 前端启动判是否已登录 |
| `POST /api/registration-keys` | 会话 | 生成 swrk_（明文只此一次） |
| `GET /api/registration-keys` | 会话 | 列出；**永不返回明文 / key_hash**。`?activeOnly=1` |
| `POST /api/registration-keys/:id/revoke` | 会话 | 幂等；**不影响已在线机器** |
| `POST /api/machines/enrollment-codes` | 会话 | 8 位配对码，TTL 10min |
| `GET /api/machines` | 会话 | 机器列表 + status/load/taskCounts。`?includeRevoked=1` |
| `POST /api/machines/:id/revoke` | 会话 | 踢掉机器（置 revoked + 作废其全部令牌）。任务数据不删 |
| `GET /api/tasks` | 会话 | 看板。`machineId/state/mirror/q/limit/offset` |
| `GET /api/tasks/:id` | 会话 | 详情：prompt 全文 / usage / history |
| `POST /api/machine/enroll` | **无**（rk + 配对码） | 全服务唯一匿名可达的写端点。限流 10/5min/IP |
| `POST /api/machine/heartbeat` | Bearer swmt_ | 15s。写 last_seen_at/status/版本/负载 |
| `POST /api/machine/tasks/upsert` | Bearer swmt_ | 增量上报。50 条/批，body 8MB |
| `POST /api/machine/tasks/digest` | Bearer swmt_ | 每 5min 全量对账 → `{ needFull, markedMissing }` |
| **手机端个人控制台（中继，`routes/my.js` + `routes/machine-relay.js`，零 DB 写）** | | 见 `docs/spec/cloud-mobile-console.md` |
| `GET /api/machine/downlink` | Bearer swmt_ | connector 出站 SSE 长连（rpc/watch_start/watch_stop/ping）。同机重连顶替旧连接 |
| `POST /api/machine/rpc/:rpcId/result` | Bearer swmt_ | rpc 结果上行。未知/他机 rpcId → 404 |
| `POST /api/machine/watch/:watchId/frames` | Bearer swmt_ | watch 帧上行 → 转发浏览器 SSE。done=true 关流 |
| `GET /api/my/machines` | 会话 | **只列 owner 本人**机器 + relayOnline（下行连接在场） |
| `POST /api/my/machines/:id/rpc` | 会话 | 经 downlink 下发 rpc 等结果。非 owner→404；verb 不在白名单→400；本地拒绝→502；离线→503；10s 无响应→504 |
| `GET /api/my/machines/:id/watch?taskKey=` | 会话 | 浏览器 EventSource：实时输出流（worker-log 增量块） |

> 上述**下行面**（downlink/rpc/watch/`/api/my/*`）受绊线控制：`CLOUD_INSECURE_COOKIE=1` 且绑定非仅
> localhost 且未设 `CLOUD_ACCEPT_PLAINTEXT_DISPATCH=1` → 一律 **503 `PLAINTEXT_DISPATCH_BLOCKED`**（只读上行/登录面不受封）。
> 手机页由本服务在 `/m/` 同源托管（`cloud/public/m/`）。见「部署注意」与 `docs/spec/cloud-mobile-console.md`。

**统一错误体**（所有非 2xx）：`{ "error": { "code": "...", "message": "..." } }`，
code ∈ `BAD_REQUEST` / `UNAUTHORIZED` / `NOT_FOUND` / `RATE_LIMITED` / `INTERNAL`。
非成员一律 **404 而非 403**（不泄露「存在但你没权限」）。

### enroll 的 401 是**逐字节相同**的，别去「优化」

注册密钥失败与配对码失败返回完全一样的 401 + 同一文案。
若两者可区分，攻击者拿垃圾 code 逐个试 rk，**错误差异就是一个完美的 rk 有效性 oracle**——
「两把一起验」的与门当场退化成两把可以各个击破的独立锁。

代价（明知的取舍）：合法用户配对码过期时也只看到「无效／已过期」，得不到「是码过期了」的精确提示。
文案里的「重新生成配对码」就是给这种情况的出路。**别为了体验好一点把错误码分回去。**

排障靠**服务端日志**（`rk_invalid` / `code_invalid` / `code_race_or_expired` 分开记，但绝不进响应体，
也绝不记 rk / code 的明文或完整哈希）。

## sweeper

30s tick：`last_seen_at` 超 **90s** → `status='offline'`，其任务镜像 `mirror='live'→'stale'`。

- **90s 的推导**：心跳 15s + tick 30s = 45s，留 45s buffer。
  （multica 是 150s，因为它多一层 60s 的 Redis→DB flush 延迟；我们的心跳直写 `last_seen_at`，没有那 60s。）
- **机器掉线时，云端不动任何任务状态**——任务在人家机器上活得好好的，笔记本合盖而已。
  真正的孤儿由本地 `runner-checker` 收（它本来就在干这事）。
- sweeper **不看 `registration_key`**（rk 只管入场不管在场）。

## 迁移

`migrations/001_p0p1_init.sql` —— **已实跑进 scrumws 库（12 张表），不要重跑、不要 drop**。
本机 Windows 无 psql，走 docker（`postgres:17-alpine` 客户端连 18.3 服务端）：

```bash
# DATABASE_URL 只经 env 传递，绝不落进命令行 / 日志 / 源码
cd <repo-root>
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)"; export DATABASE_URL
MSYS_NO_PATHCONV=1 docker run --rm -e DATABASE_URL \
  -v "$(pwd)/cloud/migrations:/m:ro" postgres:17-alpine \
  sh -c 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /m/001_p0p1_init.sql'

# 核实（独立只读命令）
docker run --rm -e DATABASE_URL postgres:17-alpine sh -c 'psql "$DATABASE_URL" -c "\dt"'
```

没有迁移账本表：本文件是裸 SQL，跑一次即可。将来若引入 `node-pg-migrate`，由它自建 `pgmigrations`
表管后续版本，避免两套账本打架。回滚见契约 §10.3（12 个表名是当前全集，改迁移时那条 drop 也要跟着改）。

## 自测

```powershell
# 起服务后（需要一把 bootstrap 打印的 swuk_）
node ..\docs\acceptance\cloud-control-plane\scripts\verify-cloud-api.mjs `
     --base http://127.0.0.1:8790 --key swuk_…
```

走通：登录 → 注册密钥 → 配对码 → enroll（含负例）→ 心跳 → upsert → digest → 看板查询 → 撤销。
重点断言：enroll 的 401 逐字节相同、rk 列表不漏明文、配对码单次使用、history 能截断、
撤销机器后心跳 401 且任务数据不删、taskCounts 按看板 6 桶。
**脚本可在已有数据的库上反复跑**（断言全部按 `machineId` 作用域，不依赖空库）。

## 部署注意（都是硬前提，不是最佳实践）

1. **HTTPS 不强制，但默认要**（`CLOUD_INSECURE_COOKIE`）。
   - 默认：会话 cookie 带 `Secure` → 必须 HTTPS（`http://localhost` 是浏览器特例的安全上下文，本地联调不受影响）。
   - `CLOUD_INSECURE_COOKIE=1`：摘掉 `Secure`，裸 HTTP 可用。**仅限内网/可信链路。**
     代价是 `swuk_` 登录密钥与 `swmt_` 机器令牌明文过网，路径上任何人抓到即可完全冒充；
     P1 只读时危害止于「看到全团队任务」，**P2 起 = 可给所有机器派活**。
   - 为什么默认开而不是默认关：浏览器**拒绝在非安全上下文存 `Secure` cookie**。默认开时，
     公网忘配反代会坏得**响亮**（登录返回 200 但 cookie 没存下 → 下一个请求 401，登不进去）；
     默认关则是**无声泄露凭据**。宁可坏得吵，不要静悄悄地漏。启动日志会打出当前姿态。
2. **`trustProxy` 当前未开**（`src/server.js`）：开了就等于信任任意客户端的 `X-Forwarded-For`，
   限流的 key 会被伪造。代价是**前置 TLS 反代时，限流会按反代 IP 聚合成全局 10/5min**。
   收口反代方案时要一起定：要么在反代层做限流，要么开 `trustProxy` 并确保它只信任自己那一跳。
3. **限流状态在进程内**，多实例不共享（当前单实例，暂不构成问题）。
4. **Postgres 端口收口**：`55432` 当前从公网可直连。云端服务上线后应只对云端服务开放。
   这属于部署收口，但没人做就是个洞。
5. 云端被攻破 = 全员开发机 RCE（P2 起）。P0+P1 纯出站只读、零 RCE 面 —— 这也是它值得单独交付的理由。

## 目录

```
cloud/
├── package.json          fastify + pg（与根 package.json 无任何关系）
├── migrations/001_p0p1_init.sql
├── scripts/bootstrap.mjs §6.0，支持 --check
└── src/
    ├── server.js         Fastify 实例、8790、统一错误体
    ├── db.js             pg Pool（只读 process.env.DATABASE_URL）+ withTx
    ├── auth.js           三种凭据的**三个独立校验函数** + 会话 + 两个 preHandler
    ├── http.js           统一错误体 + 限流（routes/* 与 server.js 共用，独立成文件避免循环依赖）
    ├── routes/user.js    人类鉴权端点（**永不写 task_status**）
    ├── routes/machine.js 机器鉴权端点（task_status / task_history 的唯一写入方）
    └── sweeper.js        30s tick：offline + stale
```
