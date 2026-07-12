# 任务新增 · 外部对接文档（CLI / HTTP API）

ScrumWS 采用**推送式**任务新增：任意来源（聊天机器人、issue webhook、定时脚本、其他系统…）主动调 **CLI** 或 **HTTP API** 把任务推进来。收到后按任务信息落到对应桶（`plan` / `queued`），**不立即执行**。

> **关键前提**
> - 服务只 bind `127.0.0.1`（**不对外**）。对接方须与 ScrumWS 跑在**同一台机器**上（或自己在本机架一层反代/隧道再转发）。
> - 端口取环境变量 `SCRUMWS_PORT`，缺省 `8799`。
> - 新增只**入队**：任务落 `plan`（待用户在看板确认后排队）或 `queued`（可运行）。**真正跑起来需在看板触发**（点「重新发起 / 确认排队」），新增端点本身不 spawn 任何 worker。

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
| `description` | string | 否 | 纯用户备注（**不进 prompt**），超 2000 字截断。 |
| `plan` | boolean | 否 | `true` → 落 `plan` 桶（需用户确认后才排队）；缺省 `false` → 落 `queued`。 |

**model 白名单**：`claude-opus-4-8`、`claude-opus-4-7`、`claude-sonnet-5`、`claude-fable-5`、`claude-haiku-4-5-20251001`。

### 响应

成功（HTTP 200）：
```json
{ "ok": true, "taskKey": "chat:20260712084709-634", "state": "queued", "spawned": false }
```
- `taskKey` = `<source>:<yyyyMMddHHmmss>-<3位随机>`（同秒并发也不撞）。
- `state` = `plan` 或 `queued`。
- `spawned` 恒为 `false`（入队式，不自动执行）。

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
# 最小：issue 来源，落 queued
curl -s -X POST http://127.0.0.1:8799/api/task/create \
  -H 'Content-Type: application/json' \
  -d '{"source":"issue","title":"登录报错","prompt":"修复 #123 的登录 500"}'
# → {"ok":true,"taskKey":"issue:20260712090131-501","state":"queued","spawned":false}

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
可选。给了会校验"存在且是目录"，通过后写入 `task.json.cwd`，供 worker 运行时切工作目录。不给则由 worker 侧默认。

---

## 入队之后会发生什么

新增端点只写任务包（`runtime/runner-state/<source>__<slug>/` 下的 `task.json` + `state.json`），**不 spawn worker、不占 lease**。之后：

- 任务出现在看板对应桶：`plan`（待确认）或 `queued`（待运行）。
- **运行由用户在看板触发**：`plan` → 点「确认排队」；`queued` → 点「重新发起」，届时才拉起执行。
- 平台守护 **Runner Checker** 只负责收孤儿 + 授权熔断复查，**不会**自动认领 `queued`/`plan` 任务去跑。

> 即：对接方负责"把活推进来"，"什么时候真跑"由看板侧人工决策。若你的场景需要推入即自动执行，那是执行侧（跨平台 runner）的独立能力，当前不在本端点职责内。

---

## 排错

| 现象 | 排查 |
|---|---|
| CLI `连不上 app（127.0.0.1:<port>）` | app 没起 / 端口不对。确认 ScrumWS 在跑，或用 `--port` / `SCRUMWS_PORT` 指定实际端口。 |
| curl 连接被拒 | 同上；注意服务只在 `127.0.0.1`，跨机访问需本机转发。 |
| `HTTP 400 model 不在白名单` | 用白名单里的 model id，或不传 `model` 走默认。 |
| 任务建好了但一直不跑 | 符合预期——入队式不自动执行，去看板点「确认排队 / 重新发起」。 |
| `非法 source` | `source` 只能 `[A-Za-z0-9_-]`、首字符字母数字。 |
