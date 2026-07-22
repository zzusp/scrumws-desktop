# 桌面端 Claude Code / Codex 双 Provider 设计

## 1. 目标与边界

本轮把 Electron 桌面端及其本地 `platform/` 服务从 Claude Code 单 provider 改造成
Claude Code + Codex 双 provider。最终可验证目标：

1. 新建任务可显式选择 Claude Code 或 Codex。
2. 两种 provider 都支持新会话、流式消息、工具步骤、继续对话、服务重启后恢复、打断和结果收敛。
3. `task-runner`、HTTP API 和 UI 只消费统一会话契约，不解析 provider 原生协议。
4. 旧任务、旧 API key 和未带 provider 的本地云下发任务继续按 Claude Code 解释。

不进入本轮：

- `cloud/` 协议、云端 UI、手机端。
- Codex 终端会话的被动扫描/收养/改写历史。Claude 已有观察和收养继续保留为 Claude capability；
  Codex 不伪装等价能力。
- 将 Claude 账号级 `/usage` 统计强行聚合为跨 provider 成本。不同 provider 的账户口径独立展示。

桌面自带的本地 external API 与 API key 页面属于桌面端能力，纳入 provider 约束；云协议不改。

## 2. 现状结论

当前执行链是：

`UI → /api/task/create → task-actions → task-runner → session-manager → claude stream-json`

Claude 语义已经泄漏到所有层：

- `session-manager.js` 固定 spawn `claude`，直接识别 `system/init`、`control_request`、`result`。
- `task-runner.js` 从 `~/.claude` 反读历史并把 `session.claudeSessionId` 落到通用 `meta.sessionId`。
- `task-actions.js`、`api-keys.js` 和前端各自维护一份 Claude model/effort 白名单。
- `collect.js` 只探测 Claude；`logs.js` 与 `collect-cli.js` 只理解 Claude JSONL。
- 前端 SSE 直接消费 Claude raw event。

可复用的部分是任务状态机、排队/lease、SSE transport、文件任务包和已有的
`text/thinking/tool_use/tool_result` 渲染。

## 3. 参考实现与本机验证

`D:/project/multica/server/pkg/agent` 提供了 provider registry、统一 message/result 和 Codex JSON-RPC
client，适合复用其分层思路；不照搬 daemon 的“一次 Execute 启一个进程、只跑一个 turn”生命周期。

Codex 官方 app-server 协议定义为 JSONL-over-stdio 的双向 JSON-RPC。生命周期是：

`initialize → initialized → thread/start|thread/resume → turn/start → item/* → turn/completed`

审批由服务端反向 RPC，打断使用 `turn/interrupt`。协议依据：
[OpenAI Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)。

2026-07-18 Windows 本机 ground truth：

- 独立 npm CLI：`codex-cli 0.144.5`。
- `codex app-server --listen stdio://` 成功。
- `thread/start` 返回 thread id 和 rollout 路径。
- `item/agentMessage/delta` 逐段返回 `CODEX_SMOKE_OK`。
- `thread/tokenUsage/updated` 返回 total/last/context window。
- `turn/completed.status=completed` 收敛。

反证：multica 当前 Codex adapter 未把 reasoning delta、agent message delta、MCP tool 完整映射，且没有主动
调用 `turn/interrupt`；本项目必须按当前官方 schema 补齐。

## 4. 架构

### 4.1 Provider registry

新增唯一事实源 `platform/lib/providers/registry.js`，提供：

```js
{
  id, label, command,
  models, allowCustomModel,
  efforts, defaultModel, defaultEffort,
  capabilities: {
    approvals, interrupt, backgroundTasks,
    terminalObserve, terminalAdopt, rewind,
    dynamicWorkflow, accountUsage
  },
  createAdapter(options)
}
```

规则：

- `claude`：保留现有模型与 `low|medium|high|xhigh|max`。
- `codex`：空 model 表示使用 CLI/账户默认；允许自定义模型字符串；effort 接受
  `none|minimal|low|medium|high|xhigh|max|ultra`，空值表示上游默认。
- 所有 provider/model/effort 组合只经过 registry 校验；删除 task-actions、session-manager、api-keys、
  app.js 的重复白名单。
- `dynamicWorkflow` 仅 Claude 可用；Codex 请求带 true 时后端 400，不静默忽略。

### 4.2 Provider adapter

adapter 是 session-owned 长连接，统一暴露：

```js
start()
send(message, attachments)
respond(requestId, allow, input)
interrupt()
close()
info()
```

adapter 只能向 session manager 发统一事件，不把 Claude/Codex raw payload 交给上层。

### 4.3 统一事件契约

```text
session_initialized {provider, sessionId, model}
message             {message:{id, role, model, content[], usage?}}
message_delta       {messageId, blockType:text|thinking, delta}
turn_usage          {usage, contextWindow?}
approval_requested  {requestId, kind, toolName, input, questions?, decisions?}
approval_resolved   {requestId}
background_tasks    {tasks[]}
turn_completed      {sessionId, status, usage, costUsd?, numTurns?, error?}
error               {error}
closed              {code?, signal?}
```

`content[]` 延续现有 UI 能识别的 `text/thinking/tool_use/tool_result` block 形状，这是本项目的统一展示
契约，不等同于 Claude raw stream-json。

session manager 负责统一状态、transcript cap、pending approval、SSE emitter 和 registry；adapter 负责协议。

### 4.4 Claude adapter

把现 `session-manager.js` 中以下逻辑原样迁入 adapter，并映射到统一事件：

- spawn flags/env、Windows shell 规则、init watchdog；
- stream-json NDJSON 解析；
- `control_request/can_use_tool` 与 `control_response`；
- interrupt/stop_task；
- background task output 路径；
- Claude Workflows 环境变量。

迁移后 Claude 行为必须由现有真 CLI 验收证明不回归。

### 4.5 Codex adapter

启动：`codex app-server --listen stdio://`。

状态机：

1. `initialize`，`capabilities.experimentalApi=true`；收到 response 后发 `initialized`。
2. 有 session id 时先 `thread/resume`；协议级 unknown/schema 错误才回 fresh `thread/start`，transport 错误直接失败。
3. `turn/start` 发送文本；附件继续以绝对路径列表拼入文本，由 agent 自行读取。
4. app-server 进程在 turn 完成后保持，下一条消息复用同一 thread。

事件映射：

- `item/agentMessage/delta` → text `message_delta`；completed → settled text message。
- `item/reasoning/summaryTextDelta|textDelta` → thinking `message_delta`；completed → settled thinking。
- commandExecution、fileChange、mcpToolCall、dynamicToolCall、webSearch 等 item → tool_use/tool_result。
- `thread/tokenUsage/updated` → normalized usage；cached input 不与 input 重复计费。
- `turn/completed` → completed/interrupted/failed。
- 所有通知先校验 `threadId`，防 subagent/其它 thread 串流。

审批：

- command/file/permissions/requestUserInput/MCP elicitation 先映射统一 approval。
- 用户允许/拒绝后 adapter 编码 provider 原生 JSON-RPC response。
- 未识别的反向 RPC fail closed，返回 `-32601` 并发 error，不自动批准。
- `bypass=true` 时仅对已知 command/file/permissions 自动批准；未知请求仍 fail closed。

打断：保存当前 `turnId`，调用 `turn/interrupt {threadId,turnId}`；transport 已坏时才关闭进程。

### 4.6 Windows 进程与 CLI 发现

- provider 独立探测 command/version/path/启动错误。
- “PATH 有命令”不等于可用：本机 WindowsApps `codex.exe` 可被 `Get-Command` 找到但直接启动返回拒绝访问。
- UI 显示每个 provider 的 `available/version/path/error`，一方失败不污染另一方。
- npm `.cmd` 需要 Windows shell；所有参数来自 registry/校验后的内部值，不拼接用户 shell 字符串。
- close 时结束 stdin，宽限后对已知 child pid 做整树终止；不在 Windows 上做无法证明 cleanup 的自动 init retry。

## 5. 数据契约

### 5.1 task.json

新增：

```json
{
  "provider": "claude",
  "model": "claude-opus-4-8",
  "effort": "xhigh"
}
```

- 新任务总是显式写 provider。
- 旧任务缺字段的唯一解释是 `claude`。
- plan 且无 sessionId 时可切 provider；一旦有 sessionId，provider 锁定。
- model/effort 在同 provider 内可于死会话 resume 时覆盖。
- `materializeCliTask` 显式写 `provider:'claude'`。

### 5.2 meta.json

保留通用 `sessionId`；新 `sessionHistory` 项写：

```json
{"provider":"codex","sessionId":"...","round":1,"at":"..."}
```

恢复路由只看 `task.provider`；不得按 model 前缀、UUID 格式或日志路径猜 provider。

### 5.3 Canonical transcript journal

新增任务包内 `session-events.jsonl`，只记录 settled 的统一事件，不记录高频 delta。用途：

- Codex 会话进程结束或桌面重启后，详情页仍能显示历史。
- provider 恢复时 seed UI transcript。
- 不替代 provider 原生 session store；resume 仍使用 Claude session id/Codex thread id。

Claude 旧任务继续可从原生 JSONL 读取；新 journal 是 provider-neutral 的桌面展示数据。

### 5.4 runner-config

新增：

```json
{
  "defaultProvider": "claude",
  "providerDefaults": {
    "claude": {"model":"claude-opus-4-8","effort":"xhigh"},
    "codex": {"model":"","effort":"high"}
  }
}
```

旧 `defaultModel` 仅迁移解释为 Claude 默认。model context limit 的 key 改为 `provider:model`；旧 key 归 Claude。

### 5.5 API key

每把本地 API key 绑定单一 provider；旧 key 为 Claude。新配置以 `allowedModelEfforts` 的逐条 model + effort 组合在该 provider 作用域内解释；旧的 `allowedModels/allowedEfforts` 读取时按原笛卡尔权限兼容。
`whoami` 返回 provider，external create 不能用请求字段跨 provider。云下发没有 provider 时保持 Claude，避免改云协议。

## 6. API 与 UI

### 6.1 API

- 新增 `GET /api/providers`：registry 元数据 + runtime discovery 状态。
- `/api/task/create|detail|edit` 加 provider。
- `/api/task/reply` 不接收 provider 覆盖；从任务读取。
- `/api/session/create` 加 provider；session info 改为 `provider/sessionId/capabilities`。
- `/api/session/respond` 继续通用路径，payload 由统一 approval UI 产生。
- `/api/session/stop-task|task-output` 先查 capability；Codex 返回明确 unsupported，不猜实现。
- `/api/session/adopt` 保持 Claude-only 并显式校验 provider。

### 6.2 UI

- 新建/编辑：Provider → Model → Effort 级联，数据来自 registry。
- Codex model 允许“CLI 默认”及自定义值；Claude 仍是固定列表。
- Codex 时隐藏 Workflows；Claude 时照旧。
- 已有 sessionId 的任务编辑时 provider 锁定。
- 回复栏跟随任务 provider，只允许选择该 provider 的 model/effort。
- 详情侧栏改为通用 Provider 卡；Claude 账户 usage 只在 Claude capability 下显示。
- Runtime 页面按 provider 各画一张卡。
- “添加本机 CLI 会话/收养/rewind”明确标为 Claude Code 能力。

## 7. 排除方案

1. **按 model/sessionId 猜 provider**：model 可空或自定义，两边 session id 都可能是 UUID，恢复不可确定。
2. **并列 claudeSessionId/codexThreadId**：会把协议泄漏扩大到 task-runner、API 和 UI，第三 provider 继续倍增字段。
3. **把 Codex `exec --json` 适配成单轮 Claude 事件**：失去原生 approval、thread resume、turn interrupt 和常驻多轮。
4. **一次性重构成深层 `task.agent.config`**：会破坏所有现有 task/API/验收脚本；flat provider + 现有 model/effort 已足够。

## 8. 验证策略

重型证据链进入 `docs/acceptance/desktop-dual-provider/`：

- fake adapter/fixture：registry 校验、任务路由、Codex JSON-RPC、审批、interrupt、错误/退出竞争。
- 真 Claude：新建、流式、工具、resume、interrupt。
- 真 Codex：新建、流式文本/思考/工具、续聊、thread resume、turn interrupt、usage。
- HTTP：create/state/detail/edit/reply/session SSE/API key provider policy。
- 浏览器/Electron：provider 切换、模型级联、详情、回复、runtime 独立状态。
- 旧数据：旧 task/key/config 按 Claude 解释，新写结果显式 provider，二次执行幂等。

不以工具“成功”回执作为证据；每轮记录命令输出、磁盘内容或 UI 断言。

## 9. 风险与失败策略

- provider 与 sessionId 错配：已有 session 后 provider immutable，resume 前再次断言。
- Codex 协议变化：启动时 handshake timeout；未知 server request fail closed；错误带 method/id/stderr tail。
- 模型漂移：Codex 空 model 交给 CLI 默认；自定义 model 不硬编码成静态“全量列表”。
- 日志串流：Codex 所有 notification 先过滤 threadId；journal 以 taskKey 隔离。
- Windows 孤儿进程：close 宽限 + child pid 整树终止；不做不安全的 initialize 自动重试。
- 不同 provider usage 口径：不做美元/账号用量跨 provider 相加，只保留 session token 统一字段。
