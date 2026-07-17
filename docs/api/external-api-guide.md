# 外部接入指导 · 用 API 密钥对接 ScrumWS 桌面端

面向**外部系统 / 脚本 / 机器人**的完整接入指南：拿一把 API 密钥，就能向桌面端**发起任务、查询任务状态、自省自己的权限范围**。钉钉群消息派发器、GitHub issue 检查器等均按本文接入（参考实现见文末）。

> **前提**
> - **任务新增必须鉴权**：程序化新增任务的唯一入口就是本文的 `POST /api/external/task/create`（密钥鉴权）。旧的无鉴权端点 `/api/task/create` 已同源收口、仅限看板页面自用——程序化调用一律 `403`。
> - 桌面端服务只 bind `127.0.0.1`（不对外）。接入方须与 ScrumWS 跑在**同一台机器**（或自行在本机架反代/隧道）。
> - 端口取环境变量 `SCRUMWS_PORT`，缺省 `8799`。下文示例均用 `http://127.0.0.1:8799`。
> - 不想手写 HTTP？本仓自带瘦客户端 CLI：`node platform/cli.js create --key swak_… --title … --prompt …`（走同一端点同一语义，见下文「CLI 瘦客户端」章）。

---

## 快速开始（4 步）

1. **拿密钥**：让桌面端使用者在「API 密钥」菜单页点「＋ 生成密钥」——填备注、来源（source）、勾选可用模型 / effort、填可访问目录、按需勾「允许直接执行」。生成后把明文（`swak_…`）交给你；日后遗失可在列表行内「复制」再次取回。
2. **自省**（可选但推荐）：`GET /api/external/whoami` 确认密钥可用并拿到自己的权限范围，据此决定调用参数。
3. **发起任务**：`POST /api/external/task/create`（带 `externalKey` 幂等键，重试/重复检测不会重复建任务）。
4. **查询状态**：`GET /api/external/task/status`（按 `taskKey` 或 `externalKey`）。

```bash
KEY='swak_xxxxxxxx'
# ① 自省
curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:8799/api/external/whoami
# ② 发起（幂等）
curl -s -X POST http://127.0.0.1:8799/api/external/task/create \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"title":"标题","prompt":"给 claude 的指令","externalKey":"来源侧唯一事件id"}'
# ③ 查询
curl -s -H "Authorization: Bearer $KEY" \
  'http://127.0.0.1:8799/api/external/task/status?externalKey=来源侧唯一事件id'
```

---

## 鉴权

所有 `/api/external/*` 端点要求请求头：

```
Authorization: Bearer swak_…
```

鉴权失败（缺头 / 密钥错误 / 已禁用 / 已删除）统一返回 `401 {"ok":false,"error":"unauthorized"}`，**不区分原因**（不泄露密钥状态）。收到 401 的正确处理：停止重试并提醒使用者到「API 密钥」页检查（是否被禁用/删除、明文是否配错）。

## 权限模型（调用方必读）

每把密钥在创建时绑定：

| 配置 | 语义 | 对调用方的影响 |
|---|---|---|
| `source` | 来源标签 | 该密钥建的任务一律记为此来源（**请求体里传 `source` 无效**）；查询也只能查到本来源的任务 |
| `allowedModels` | 可用模型白名单（必选） | 请求省略 `model` → 用白名单**首项**；传白名单外的值 → `400 model 不在该密钥允许范围：…` |
| `allowedEfforts` | 可用 effort 白名单（必选） | 同上（省略取首项 / 越界 400） |
| `allowedCwds` | 可访问目录白名单（必选，绝对路径） | 任务 `cwd` 须**等于某项或在其之下**（Windows 大小写不敏感）；省略取首项；越界 400 |
| `allowQueued` | 允许直接执行（默认关） | 关：显式传 `plan:false` → `400 该密钥不允许直接排队执行…`（只能建 plan 任务，看板确认后执行）；开：`plan:false` 直进 queued **立即自动起 claude 会话执行** |

密钥配置可在「API 密钥」页随时**编辑**（即时生效，无需换钥）。**推荐调用方启动时先调 `whoami` 拿权限范围**，而不是硬编码模型/目录——密钥被编辑后调用方无需改代码。

## 端点契约

### `GET /api/external/whoami` — 自省

返回本密钥的身份与权限范围：

```json
{ "ok": true, "key": {
    "label": "钉钉群消息派发器", "source": "chat", "prefix": "swak_xH1jnAo", "createdAt": "2026-07-17 21:04:26",
    "allowedModels": ["claude-opus-4-8"], "allowedEfforts": ["xhigh"],
    "allowedCwds": ["D:\\baibu-agent"], "allowQueued": true } }
```

- 各白名单**首项即该密钥的默认值**（请求省略对应字段时采用）。
- 无副作用、可随意调（也会刷新「API 密钥」页的「最近活跃」）。

### `POST /api/external/task/create` — 发起任务

Body（JSON，≤32 KB）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | string | **是** | 任务标题（看板卡片标题） |
| `prompt` | string | **是** | 交给 claude 的指令正文 |
| `externalKey` | string | 建议 | 幂等键（≤200 字符，来源侧唯一事件 id，如消息时间戳 / issue 编号）。同 source 同键重复调用**不重复建任务** |
| `model` | string | 否 | 须在密钥 `allowedModels` 内；省略取首项 |
| `effort` | string | 否 | 须在密钥 `allowedEfforts` 内；省略取首项 |
| `cwd` | string | 否 | claude 工作目录绝对路径，须在 `allowedCwds` 范围内（等于某项或其子目录）；省略取首项 |
| `plan` | boolean | 否 | 缺省 `true` → 落 **plan 桶**（看板人工确认后执行）；`false` → 直进 queued 自动执行（**需密钥开 `allowQueued`**） |
| `description` | string | 否 | 纯备注（不进 prompt），超 2000 字截断 |
| `scheduledAt` | string | 否 | 定时执行时刻（本地时间串）；给了则强制先落 plan，到点自动执行 |

成功（HTTP 200）：

```json
{ "ok": true, "taskKey": "chat:20260717103012-482", "state": "plan", "spawned": false, "existed": false }
```

| 响应字段 | 说明 |
|---|---|
| `taskKey` | 任务唯一标识（`<source>:<yyyyMMddHHmmss>-<3位随机>`），保存下来供查询 |
| `state` | `plan`（待确认）/ `processing`（已直接起会话执行）/ `queued`（排队或起会话失败，见 `startError`） |
| `existed` | `true` = 幂等命中：同键任务已存在，返回的是**原任务**，本次没有新建 |
| `spawned` / `sessionUiId` | 是否已起执行会话（`plan:false` 时） |

### `GET /api/external/task/status` — 查询状态

`?taskKey=…` 或 `?externalKey=…`（二选一）：

```json
{ "ok": true, "taskKey": "chat:20260717103012-482", "source": "chat", "title": "…",
  "state": "plan", "outcome": null, "createdAt": "2026-07-17 10:30:12", "resolvedAt": null, "externalKey": "…" }
```

- `state` 取值：`plan` → `queued` → `processing` → `awaiting-human` → `done`（含归档任务也查得到）。
- `outcome`：收敛结果（如 `completed` / `cancelled`），未收敛为 `null`。
- 跨来源 / 不存在 / externalKey 未登记一律 `404 {"ok":false,"error":"task not found"}`（不泄露其它来源任务的存在性）。

### `POST /api/external/heartbeat` — 来源心跳

仅带鉴权头、无 body → `200 {"ok":true}`。定时进程**每 tick 打一下**，「API 密钥」页即显示该来源活跃（5 分钟内亮绿点）。失败静默即可（桌面端没起 = 显示离线，本来就是正确状态）。

## 提交之后会发生什么（执行语义）

端点写任务包（`runtime/runner-state/<source>__<slug>/` 下的 `task.json` + `state.json`），然后：

- `plan`（缺省）→ 任务落 **plan 桶**等用户在看板点「确认执行」才起会话。
- `queued`（`plan:false`，需密钥开「允许直接执行」）→ **立即起绑定该任务的 Mode B 交互会话执行**：state=`processing`，`task.prompt` 作首条消息发给 claude；一轮 `result` 收敛 → `awaiting-human`（会话进程常驻，可从看板详情继续多轮）；服务重启等中断 → Runner Checker 收成 `awaiting-human` 带 `resumeSessionId`，看板回复即 `--resume` 续。
- 补充：`runner-config.json` 的 `planSources` 含某来源时，该来源任务**总是**先落 plan（即使传了 `plan:false`）。

## 错误对照表

| HTTP | `error` | 含义 / 调用方处理 |
|---|---|---|
| 401 | `unauthorized` | 密钥缺失/错误/禁用/删除 → 停止重试，提醒使用者检查「API 密钥」页 |
| 400 | `title required` / `prompt required` | 缺必填字段 |
| 400 | `model 不在该密钥允许范围：…` | 越界（错误信息回显当前白名单，可据此自纠） |
| 400 | `effort 不在该密钥允许范围：…` / `cwd 不在该密钥允许范围：…` | 同上 |
| 400 | `该密钥不允许直接排队执行（plan:false）…` | 密钥未开「允许直接执行」→ 去掉 `plan:false` 或请使用者开权限 |
| 400 | `该密钥未配置…（策略必选=无权限）…` | 明文留存前的旧版密钥 → 重新生成 |
| 400 | `externalKey 超长（≤200 字符）` | 幂等键过长 |
| 404 | `task not found` | 查询目标不存在 / 不属于本来源 |
| 403 | `本端点仅限看板页面使用…` | 程序化调用打到了看板内部端点 `/api/task/create` → 改走本文密钥通道 |
| 连接拒绝 | — | 桌面端未运行 → 稍后重试（见下） |

> 任务建好了但一直不跑？`state=plan` 属预期（待看板确认）；`state=queued` 且返回带 `startError` 是起会话失败（如 claude 不可用），修好后在看板「重新发起」。

## 可靠性建议

- **幂等**：始终带 `externalKey`（来源侧唯一事件 id）。这样无论网络超时重发、进程重启后重跑，都不会重复建任务（命中返回 `existed:true` + 原 taskKey）。
- **fail-soft**：桌面端可能未启动（连接拒绝）或未升级（404）。POST 失败时**不要推进你自己的水位/游标**，下轮自然重试；或把已构建的请求体落盘排队、恢复后补投（幂等键保证补投不重复）——参考 chat-watch 的 `pending/` 队列实现。
- **心跳**：定时进程每 tick 调一次 heartbeat，让使用者在页面上看到你的存活状态。

## 更多语言示例

PowerShell 7：

```powershell
$key = 'swak_xxxxxxxx'
$h = @{ Authorization = "Bearer $key" }
# 自省
Invoke-RestMethod -Uri 'http://127.0.0.1:8799/api/external/whoami' -Headers $h
# 发起
$body = @{ title = '标题'; prompt = '指令'; externalKey = 'evt-001' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8799/api/external/task/create' `
  -Headers $h -ContentType 'application/json; charset=utf-8' -Body $body
```

Node（≥18，原生 fetch）：

```js
const BASE = 'http://127.0.0.1:8799';
const headers = { Authorization: `Bearer ${process.env.SCRUMWS_KEY}`, 'Content-Type': 'application/json' };
const me = await fetch(`${BASE}/api/external/whoami`, { headers }).then(r => r.json());
const r = await fetch(`${BASE}/api/external/task/create`, {
  method: 'POST', headers,
  body: JSON.stringify({ title: '标题', prompt: '指令', model: me.key.allowedModels[0], externalKey: 'evt-001' }),
  signal: AbortSignal.timeout(15000),
}).then(r => r.json());
```

## CLI 瘦客户端

```
node platform/cli.js create [选项]
```
（本仓库内也可 `npm run task -- create [选项]`；若 `npm link` 过则为 `scrumws-task create [选项]`。走本文同一端点、同一语义。）

| 选项 | 说明 |
|---|---|
| `--key <k>` | API 密钥 `swak_…`（缺省读环境变量 `SCRUMWS_API_KEY`） |
| `--title <t>` | 标题（必填） |
| `--prompt <p>` | 指令正文（必填）；传 `-` 则从 **stdin** 读（长文本用） |
| `--model <m>` | 模型（须在密钥可用模型内；缺省取密钥白名单首项） |
| `--effort <e>` | 推理档位（须在密钥可用 effort 内；缺省取首项） |
| `--cwd <dir>` | 工作目录绝对路径（须在密钥可访问目录内；缺省取首项） |
| `--desc <备注>` | 纯备注（不进 prompt） |
| `--external-key <id>` | 幂等键（来源侧唯一事件 id，同键重复提交不重复建任务） |
| `--queued` | 直进 `queued` 立即自动执行（**需密钥开「允许直接执行」**）；缺省落 `plan` 待看板确认 |
| `--json` | 整体 JSON body 从 **stdin** 读（覆盖上述字段；鉴权仍用 `--key` / env） |
| `--port <n>` | 目标端口（缺省 `SCRUMWS_PORT` 或 `8799`） |
| `-h`, `--help` | 帮助 |

**退出码**：`0` = 已提交；`1` = 失败（缺密钥 / 连不上服务 / 参数错 / 后端拒绝）。

```powershell
$env:SCRUMWS_API_KEY = 'swak_xxxx'   # 或每次 --key swak_xxxx

# 缺省落 plan（看板确认后执行）
node platform/cli.js create --title "登录报错" --prompt "修复 #123 的登录 500" --external-key issue-123

# 长指令走 stdin + 直接执行（需密钥开「允许直接执行」）
echo "很长的多行指令…" | node platform/cli.js create --title "群里的活" --prompt - --queued
```

## 参考实现

- 钉钉群消息派发器：`D:\baibu-agent\runtime\dispatchers\chat-watch.mjs`（水位检测 + 幂等 + pending 补投 + 心跳，plan:false 直执）
- Issue 检查器：`D:\baibu-agent\runtime\dispatchers\issue-watch.mjs`（指纹去重 + 幂等 + 心跳，默认 plan 确认）
- 公共 HTTP 件：`D:\baibu-agent\runtime\dispatchers\scrumws-ingest.mjs`
