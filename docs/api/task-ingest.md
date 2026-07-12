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
