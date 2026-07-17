# 任务新增 · 对接文档（HTTP API / CLI）

ScrumWS 采用**推送式**任务新增：对接方主动把任务推进来，按任务信息落桶（`plan` 待看板确认 / `queued` 立即自动起交互式 claude 会话执行）。

> **⚠️ 一切程序化任务新增必须经 API 密钥鉴权（2026-07-18 收口）**
> - **唯一程序化入口**：`POST /api/external/task/create`（`Authorization: Bearer swak_…`，per-key 策略 + externalKey 幂等）。完整契约、接入步骤、多语言示例见 **[`external-api-guide.md`](external-api-guide.md)**（单一事实源）。
> - 旧的无鉴权端点 `POST /api/task/create` **仅限看板页面自用**：服务端校验同源 Origin 标头，程序化调用一律 `403` 并指路外部通道。
> - 服务只 bind `127.0.0.1`（不对外）；端口取 `SCRUMWS_PORT`，缺省 `8799`。

---

## CLI（外部通道瘦客户端）

```
node platform/cli.js create [选项]
```
（本仓库内也可 `npm run task -- create [选项]`；若 `npm link` 过则为 `scrumws-task create [选项]`。）

CLI 走 `/api/external/task/create`，**必须提供 API 密钥**（桌面端「API 密钥」页生成；来源 source 与可用模型/effort/目录/直执权限由密钥决定）。

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

### 示例

```powershell
$env:SCRUMWS_API_KEY = 'swak_xxxx'   # 或每次 --key swak_xxxx

# 缺省落 plan（看板确认后执行）
node platform/cli.js create --title "登录报错" --prompt "修复 #123 的登录 500" --external-key issue-123

# 长指令走 stdin + 直接执行（需密钥开「允许直接执行」）
echo "很长的多行指令…" | node platform/cli.js create --title "群里的活" --prompt - --queued
```

---

## 提交之后会发生什么

端点写任务包（`runtime/runner-state/<source>__<slug>/` 下的 `task.json` + `state.json`），然后：

- `plan`（外部通道缺省）→ 任务落 `plan` 桶等用户在看板点「确认执行」才起会话。
- `queued`（`plan:false`，需密钥开「允许直接执行」）→ **立即起绑定该任务的 Mode B 交互会话执行**：state=`processing`，`task.prompt` 作首条消息发给 claude；一轮 `result` 收敛 → `awaiting-human`（会话进程常驻，可从看板详情继续多轮）；服务重启等中断 → Runner Checker 收成 `awaiting-human` 带 `resumeSessionId`，回复即 `--resume` 续。
- 返回体含 `state`：`plan`（待确认）/ `processing`（已起会话）/ `queued`（起会话失败，另见 `startError`，可在看板「重新发起」重试）。

补充：`runner-config.json` 的 `planSources` 含某来源时，该来源任务**总是**先落 plan（即使请求传了 `plan:false`）。

---

## 排错

| 现象 | 排查 |
|---|---|
| CLI `缺 API 密钥` | 传 `--key` 或设 `SCRUMWS_API_KEY`；密钥在桌面端「API 密钥」页生成 / 行内「复制」取回 |
| `HTTP 401 unauthorized` | 密钥错误 / 已禁用 / 已删除，到「API 密钥」页核对 |
| `HTTP 403 本端点仅限看板页面使用…` | 程序化调用打到了 `/api/task/create`——改走 `/api/external/task/create` + 密钥 |
| `HTTP 400 … 不在该密钥允许范围` | 请求的 model/effort/cwd 越出密钥策略（错误信息回显白名单）；或让使用者「编辑」密钥放宽 |
| `HTTP 400 该密钥不允许直接排队执行` | 密钥未开「允许直接执行」却传了 `plan:false` / `--queued` |
| CLI `连不上 app（127.0.0.1:<port>）` | app 没起 / 端口不对；确认 ScrumWS 在跑，或用 `--port` / `SCRUMWS_PORT` |
| 任务建好了但一直不跑 | `state=plan` 属预期（待看板确认）；`state=queued` 且带 `startError` 是起会话失败，看板「重新发起」重试 |
