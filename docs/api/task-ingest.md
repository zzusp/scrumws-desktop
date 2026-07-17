# 任务新增 · 外部对接文档（CLI / HTTP API）

ScrumWS 采用**推送式**任务新增：任意来源（聊天机器人、issue webhook、定时脚本、其他系统…）主动调 **CLI** 或 **HTTP API** 把任务推进来。收到后按任务信息落桶：`queued` → **立即自动起一个交互式 claude 会话执行**（跨平台，逐字 / 工具权限确认 / 可打断 / 多轮续接）；`plan` → 待用户在看板「确认执行」。

> **关键前提**
> - 服务只 bind `127.0.0.1`（**不对外**）。对接方须与 ScrumWS 跑在**同一台机器**上（或自己在本机架一层反代/隧道再转发）。
> - 端口取环境变量 `SCRUMWS_PORT`，缺省 `8799`。
> - `queued` 任务**自动执行**：端点收到后即起绑定该任务的 Mode B 会话（→`processing`），一轮收敛落 `awaiting-human`，从看板详情可继续多轮。`plan` 任务需用户在看板点「确认执行」才起。

---

## 两种对接方式

| 方式 | 适用 | 依赖 |
|---|---|---|
| **HTTP API** `POST /api/task/create` | 任意语言 / 系统，直接发 HTTP | 能访问本机端口 |
| **CLI** `platform/cli.js` | shell 脚本、cron、命令行工具链 | 本机有 Node ≥ 20.11 + 本仓库 |

两者是同一后端端点，行为完全一致（CLI 即 API 的瘦客户端）。

---

## HTTP API 契约

### 请求

```
POST http://127.0.0.1:<SCRUMWS_PORT>/api/task/create
Content-Type: application/json
```

Body（JSON，上限 **32 KB**）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `source` | string | 否 | 来源标签，缺省 `manual`。仅允许 `[A-Za-z0-9_-]` 且首字符为字母数字（如 `chat` / `issue` / `feishu` / `webhook-x`）。承载在 `taskKey` 前缀，用于看板筛选与展示。 |
| `title` | string | **是** | 任务标题（看板卡片标题）。 |
| `prompt` | string | **是** | 交给 claude 的指令正文。 |
| `model` | string | 否 | 模型 id，须在白名单内（见下）。缺省取 `runner-config.json` 的 `defaultModel`，再兜底 `claude-opus-4-7`。 |
| `cwd` | string | 否 | claude 工作目录**绝对路径**。给了则必须已存在且是目录，否则报错。 |
| `effort` | string | 否 | 推理档位，须在 `low`/`medium`/`high`/`xhigh`/`max` 内。缺省用 claude 默认。 |
| `description` | string | 否 | 纯用户备注（**不进 prompt**），超 2000 字截断。 |
| `plan` | boolean | 否 | `true` → 落 `plan` 桶（需用户在看板「确认执行」）；缺省 `false` → 落 `queued` 并**立即自动起会话执行**。 |

**model 白名单**：`claude-opus-4-8`、`claude-opus-4-7`、`claude-sonnet-5`、`claude-fable-5`、`claude-haiku-4-5-20251001`。

### 响应

成功（HTTP 200）：
```json
{ "ok": true, "taskKey": "manual:20260712084709-634", "state": "processing", "spawned": true, "sessionUiId": "…" }
```
- `taskKey` = `<source>:<yyyyMMddHHmmss>-<3位随机>`（同秒并发也不撞）。
- `state` = `processing`（queued 已起会话执行）/ `plan`（待确认）/ `queued`（起会话失败）。
- `spawned` = 是否已起执行会话；`true` 时带 `sessionUiId`（看板实时会话面的会话 id）。
- 起会话失败时 `spawned:false` 且带 `startError`（任务仍在 `queued`，可在看板「重新发起」重试）。

失败（HTTP 400）：
```json
{ "ok": false, "error": "<原因>" }
```

| 错误 `error` | 触发 |
|---|---|
| `invalid json` | body 不是合法 JSON |
| `title required` | 缺 `title` |
| `prompt required` | 缺 `prompt` |
| `model 不在白名单：…` | `model` 非白名单值 |
| `非法 source：…（仅 [A-Za-z0-9_-]、首字符字母数字）` | `source` 不合法 |
| `工作目录不存在：<path>` / `工作目录不是文件夹：<path>` | `cwd` 校验失败 |

### curl 示例

```bash
# 最小：issue 来源，落 queued → 立即自动起会话执行
curl -s -X POST http://127.0.0.1:8799/api/task/create \
  -H 'Content-Type: application/json' \
  -d '{"source":"issue","title":"登录报错","prompt":"修复 #123 的登录 500"}'
# → {"ok":true,"taskKey":"issue:20260712090131-501","state":"processing","spawned":true,"sessionUiId":"…"}

# 指定 model + cwd + 落 plan 桶（待确认）
curl -s -X POST http://127.0.0.1:8799/api/task/create \
  -H 'Content-Type: application/json' \
  -d '{"source":"feishu","title":"飞书推来的活","prompt":"整理本周周报","model":"claude-opus-4-8","cwd":"/Users/me/proj","plan":true}'
```

---

## 外部 API（带鉴权 · 推荐外部系统使用）

`/api/task/create` 无鉴权、来源标签由请求方自报，适合本机自用；**外部系统（钉钉派发器、issue 检查器、其他机器人）建议走外部通道** `/api/external/*`：

- **鉴权**：`Authorization: Bearer swak_…`。密钥在桌面端「API 密钥」菜单页生成，可禁用/删除；明文留存本机（`runtime/api-keys.json`，仅本机管理面可见），列表行内「复制」即可取回原文。
- **来源可信**：每把密钥绑定一个 `source`，该密钥建的任务一律记为此来源（请求体里的 `source` 忽略），查询也只能查本来源的任务。
- **per-key 策略白名单**（创建密钥时**三项都必选**——全不选 = 没有权限，无法创建）：`allowedModels` / `allowedEfforts`（须为全局白名单子集）、`allowedCwds`（绝对路径列表；任务 `cwd` 须等于某项或在其之下，Windows 大小写不敏感）。请求省略对应字段时取白名单**首项**为该密钥默认；请求越界一律 `400 …不在该密钥允许范围…`；旧格式无策略字段的密钥建任务一律 `400 该密钥未配置…（策略必选=无权限）`，须重新生成。
- **默认 plan 桶 + 直接执行权限**：外部推入的任务缺省 `plan:true`（人工在看板确认后才执行）。显式传 `plan:false` 直进 `queued` 自动执行**需要密钥开启「允许直接执行」（`allowQueued`，默认关）**——未开启的密钥传 `plan:false` 一律 `400 该密钥不允许直接排队执行…`。
- **密钥可编辑 / 可复制**：「API 密钥」页行内「编辑」改备注/来源/策略/直执权限（密钥本体与使用记录不变，`POST /api/apikeys/update`）；「复制」把**原密钥明文**复制进剪贴板。明文留存前创建的旧版密钥无法取回（只存了 sha256），按钮置灰，可编辑配置或删除重建。
- **幂等去重**：可带 `externalKey`（≤200 字符，来源侧唯一事件 id，如钉钉消息时间戳、issue 编号）。同 source 同 `externalKey` 重复调用不重复建任务，返回原 `taskKey` + `existed:true`（台账存 `runtime/external-ingest.json`；对应任务被删除后同键会重建）。
- **来源心跳**：`POST /api/external/heartbeat`（仅带鉴权头，无 body）→ `200 {"ok":true}`。发起端每 tick 打一下即可让「API 密钥」页显示该来源活跃（lastUsedAt 5 分钟内亮绿点）。无副作用；不用长连接——发起端多为短命定时进程，无宿主可持连，活跃度以心跳新鲜度判定更准。

### 发起

```
POST http://127.0.0.1:<SCRUMWS_PORT>/api/external/task/create
Authorization: Bearer swak_…
Content-Type: application/json
```

Body 字段同 `/api/task/create`，差异：**无 `source`**（取密钥绑定值）、`plan` 缺省 `true`、增加可选 `externalKey`。

成功（HTTP 200）：
```json
{ "ok": true, "taskKey": "chat:20260717103012-482", "state": "plan", "spawned": false, "existed": false }
```
- 幂等命中：`{ "ok": true, "existed": true, "taskKey": "<原任务>", "state": "<当前状态>" }`，不新建。

失败：`401 {"ok":false,"error":"unauthorized"}`（缺头 / 密钥错 / 已禁用 / 已删除）；`400` 同 `/api/task/create` 错误表，另有 `externalKey 超长（≤200 字符）`。

### 查询

```
GET http://127.0.0.1:<SCRUMWS_PORT>/api/external/task/status?taskKey=…      # 或
GET http://127.0.0.1:<SCRUMWS_PORT>/api/external/task/status?externalKey=…
Authorization: Bearer swak_…
```

成功（HTTP 200）：
```json
{ "ok": true, "taskKey": "chat:20260717103012-482", "source": "chat", "title": "…",
  "state": "plan", "outcome": null, "createdAt": "2026-07-17 10:30:12", "resolvedAt": null, "externalKey": "…" }
```
`state` 含归档任务（查得到）；跨来源 / 不存在 / externalKey 未登记一律 `404 {"ok":false,"error":"task not found"}`（不泄露其它来源任务存在性）。

### curl 示例

```bash
# 发起（幂等）：同一条钉钉消息重复推不重复建任务
curl -s -X POST http://127.0.0.1:8799/api/external/task/create \
  -H 'Authorization: Bearer swak_xxxxxxxx' -H 'Content-Type: application/json' \
  -d '{"title":"群里的活","prompt":"…","externalKey":"chat-cidXXX-1737012345678"}'

# 查询
curl -s -H 'Authorization: Bearer swak_xxxxxxxx' \
  'http://127.0.0.1:8799/api/external/task/status?externalKey=chat-cidXXX-1737012345678'
```

---

## CLI

```
node platform/cli.js create [选项]
```
（本仓库内也可 `npm run task -- create [选项]`；若 `npm link` 过则为 `scrumws-task create [选项]`。）

| 选项 | 说明 |
|---|---|
| `--source <s>` | 来源标签（缺省 `manual`） |
| `--title <t>` | 标题（必填） |
| `--prompt <p>` | 指令正文（必填）；传 `-` 则从 **stdin** 读（长文本用） |
| `--model <m>` | 模型 id（白名单） |
| `--cwd <dir>` | 工作目录绝对路径 |
| `--desc <备注>` | 纯备注（不进 prompt） |
| `--plan` | 落 `plan` 桶（缺省落 `queued`） |
| `--json` | 整体 JSON body 从 **stdin** 读（覆盖上述字段） |
| `--port <n>` | 目标端口（缺省 `SCRUMWS_PORT` 或 `8799`） |
| `-h`, `--help` | 帮助 |

**退出码**：`0` = 已入队；`1` = 失败（连不上服务 / 参数错 / 后端拒绝）。
**输出**：成功 `✓ 已入队 <taskKey>（state=<state>）`；失败 `✗ 新建失败（HTTP <code>）：<error>`。

### 示例

```bash
# 直接传参
node platform/cli.js create --source issue --title "登录报错" --prompt "修复 #123 的登录 500"

# 长指令走 stdin
echo "很长的多行指令…" | node platform/cli.js create --source chat --title "群里的活" --prompt -

# 整体 JSON 走 stdin（适合已有结构化数据的系统）
echo '{"source":"webhook","title":"x","prompt":"y","plan":true}' \
  | node platform/cli.js create --json

# 指定端口（app 用了非默认端口时）
node platform/cli.js create --source manual --title t --prompt p --port 8901
```

---

## 字段语义补充

### `source`
只是一个标签，落进 `taskKey` 前缀（`<source>:<slug>`）并写入 `task.json.source`，供看板「来源筛选」与展示、以及回复路由。可自定义（`feishu` / `webhook-abc` …），不需要预先注册。

### `plan` vs `queued`
落哪个桶由两处共同决定，任一命中即 `plan`：
1. 请求里 `plan: true`（CLI `--plan`）。
2. `runner-config.json` 的 `planSources` 数组包含该 `source`（按来源全局设"该来源默认先计划"）。

否则落 `queued`。

### `cwd`
可选。给了会校验"存在且是目录"，通过后写入 `task.json.cwd`，作为该交互会话 claude 的工作目录。不给则用平台进程当前目录。

---

## 提交之后会发生什么

端点写任务包（`runtime/runner-state/<source>__<slug>/` 下的 `task.json` + `state.json`），然后：

- `queued`（缺省）→ **立即起绑定该任务的 Mode B 交互会话执行**：state=`processing`，`task.prompt` 作首条消息发给 claude；
  一轮 `result` 收敛 → `awaiting-human`（会话进程常驻，可从看板详情继续多轮）；服务重启等中断 → Runner Checker
  收成 `awaiting-human` 带 `resumeSessionId`，回复即 `--resume` 续。
- `plan` → 任务落 `plan` 桶等用户在看板点「确认执行」才起会话。
- 返回体含 `state`：`processing`（已起会话）/ `plan`（待确认）/ `queued`（起会话失败，另见 `startError`，可在看板「重新发起」重试）。

> 即：对接方"把活推进来"，`queued` 任务即刻自动跑起来（跨平台，无需 Windows `.ps1`）；`plan` 留一道人工确认闸。

---

## 排错

| 现象 | 排查 |
|---|---|
| CLI `连不上 app（127.0.0.1:<port>）` | app 没起 / 端口不对。确认 ScrumWS 在跑，或用 `--port` / `SCRUMWS_PORT` 指定实际端口。 |
| curl 连接被拒 | 同上；注意服务只在 `127.0.0.1`，跨机访问需本机转发。 |
| `HTTP 400 model 不在白名单` | 用白名单里的 model id，或不传 `model` 走默认。 |
| 任务建好了但一直不跑 | 若 `state=plan` 属预期（待看板「确认执行」）；若 `state=queued` 且返回带 `startError`，是起会话失败（如 claude 不可用），修好后在看板「重新发起」。 |
| `非法 source` | `source` 只能 `[A-Za-z0-9_-]`、首字符字母数字。 |
