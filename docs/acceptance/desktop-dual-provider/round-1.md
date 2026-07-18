# Round 1 验收记录

## 结论

实现目标已落地，22 个用例中 17 PASS、5 FAIL。FAIL 均为严格真机覆盖缺口：本机 Claude CLI 已退出登录；
Codex 的 reasoning/file/MCP/approval 尚未逐项在真实服务中触发。fixture、真实 Codex 主链、数据/API/UI 与既有
external/replan 回归均通过，因此不写 `report.md`，也不把协议 fixture 冒充完整真机验收。

## Provider 与任务链

命令：

```powershell
node docs/acceptance/desktop-dual-provider/scripts/verify-registry.mjs
node docs/acceptance/desktop-dual-provider/scripts/verify-claude-adapter.mjs
node docs/acceptance/desktop-dual-provider/scripts/verify-codex-adapter.mjs
node docs/acceptance/desktop-dual-provider/scripts/verify-task-journal.mjs
node docs/acceptance/desktop-dual-provider/scripts/verify-task-runner.mjs
node docs/acceptance/desktop-dual-provider/scripts/verify-provider-data.mjs
```

结果：6/6 退出码 0。关键断言包括：

- registry 暴露 Claude/Codex 两个 provider，Codex 自定义模型可用，shell 元字符模型被拒。
- Claude fixture 归一为 `session_initialized/message_delta/message/approval_requested/turn_completed` 等事件。
- Codex fixture 覆盖 command/file/permissions/request_user_input/MCP approval、thinking/tool/result、usage 与 fail-closed。
- 旧数据默认 Claude；有 session 后 provider 锁定；API key/source/runtime 相互隔离。
- journal 只落 settled 事件，旧 Claude JSONL 与新 Codex journal 都能恢复详情和 seed transcript。

## 真实 Codex 0.144.5

命令：

```powershell
$env:CODEX_COMMAND = '<temp>\node_modules\.bin\codex.cmd'
node docs/acceptance/desktop-dual-provider/scripts/verify-real-codex.mjs
```

最终结果（退出码 0）：

```json
{"ok":true,"firstTypes":["diagnostic","session_initialized","message_delta","message","turn_usage","turn_completed","closed"],"resumed":true,"usage":{"input_tokens":656,"output_tokens":11,"cache_read_input_tokens":18176,"cache_creation_input_tokens":0,"reasoning_output_tokens":0},"interruptStatus":"interrupted"}
```

该脚本真实执行 `initialize/thread/start/turn/start`、逐字文本、`thread/resume`、PowerShell shell 工具与
`turn/interrupt`。复跑时主动找到并修复两项反证：

1. 已完成轮的 `turnId` 清理晚于完成事件，立即续发会错误命中旧轮；改为先清状态再发 `turn_completed`。
2. Windows 先关 stdin 会让工具孙进程在 app-server 退出后成为孤儿；改为同步 `taskkill /T /F` 后再收口。

最终只读核验：`REAL_CODEX_TEMP_DIRS=0`、`ORPHAN_TEST_APP_SERVERS=0`。

## 真实 Claude 2.1.207

本轮前段，既有 resume-seed 真机用例曾完成新会话、resume、历史 assistant 与回复回显。后段执行真实
deny/allow/interrupt 用例时收到 `Failed to authenticate: OAuth session expired and could not be refreshed`。

只读核验：

```json
{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}
```

因此 `CLAUDE-1`、`CLAUDE-2` 及依赖真实 Claude 的完整 `REGRESS-1` 保持 FAIL；可复现脚本为
`scripts/verify-real-claude.mjs`，重新登录后应在 round 2 运行，不覆盖本轮记录。

## 既有回归

- 隔离数据根、无 Claude PATH 的本地实例：external task API `44/44 PASS`。
- `task-replan-resume/scripts/verify-logic.mjs`：`21 passed, 0 failed`。
- 旧 resume-seed 已适配 canonical 事件并真机通过；完整 Mode B 工具权限链因 Claude 登录失效未通过。
- 隔离实例退出后只读核验：`PORT_18799_LISTENERS=0`、`SCRATCH_EXISTS=False`。

## 桌面 UI

在隔离端口的桌面页面完成浏览器验收：

- 新建任务从 Claude 切换 Codex 后，模型显示“CLI 默认模型”，effort 为 high，Claude workflows 隐藏。
- 自定义模型 `gpt-5.4` 创建、编辑回填和详情展示一致；已有 session 的 provider 不可切换。
- runtime 同时显示两张独立 provider 卡；Claude 可用不影响 Codex 缺失状态，反之亦然。
- API key 切换 Codex 后使用 Codex 模型/effort 范围；浏览器控制台错误为 0。

## 静态检查

```text
NODE_CHECK_PASS=24
DIFF_CHECK_EXIT=0
```

检查覆盖全部本轮新增/修改的 JS/MJS；`git diff --check` 无 whitespace error。
