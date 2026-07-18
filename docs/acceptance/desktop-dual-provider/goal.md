# goal · 桌面端 Claude Code / Codex 双 Provider

设计快照将落在 `docs/spec/desktop-dual-provider.md`。本文件是本次多轮改造的唯一进度锚点；
范围只含 Electron 桌面端及其本地 `platform/` 服务，不改 `cloud/` 和移动端。

## 总目标

把当前直接绑定 Claude Code CLI 的桌面执行链改造成统一 provider 架构，在保留 Claude Code 既有能力的同时，
新增 Codex CLI 支持。用户可为任务选择 provider、provider 原生模型与 reasoning effort；任务启动、续聊、
恢复、流式消息、工具调用、打断、完成态和用量采集都由统一会话契约驱动。

## 已确认的 Ground Truth

- 当前 `platform/lib/session-manager.js` 直接 spawn `claude -p --input-format stream-json --output-format stream-json`，
  并直接解析 Claude `system/init`、`assistant`、`control_request`、`result` 等事件。
- 当前任务层、日志层和 UI 同时依赖 `claudeSessionId`、`~/.claude/projects/*.jsonl`、Claude 模型白名单及
  Claude 权限控制协议，因此不能只替换一条启动命令。
- 参考项目 `D:/project/multica` 已有统一 agent backend；Claude 走 stream-json，Codex 走
  `codex app-server`，并将两者归一为 text/thinking/tool-use/tool-result/status/result 事件。

## 重大决策

- **D1（用户定）**：本轮只聚焦桌面端 app；`cloud/` 与手机端不进入实现范围。
- **D2（技术定）**：采用 provider adapter + 统一会话事件契约，不在业务层散落 `if (provider === ...)`。
- **D3（技术定）**：Codex 参考 multica 使用 `codex app-server` 长连接协议，以保留会话恢复、流式事件、
  工具调用和打断能力；不使用只能覆盖单轮的简化命令替代交互引擎。

## Sub Goal Matrix（唯一进度总表）

| # | Sub Goal | 状态 | 验收出口 |
|---|---|---|---|
| S0 | 双仓调用链与协议盘点，形成设计快照 | DONE | spec 含现状、差异、边界、数据迁移与验证方案 |
| S1 | 定义 provider registry、统一 session/event/result 契约 | DONE | Claude/Codex adapter 无业务层协议泄漏 |
| S2 | Claude adapter 迁移且行为不回归 | DONE | fixture 全绿；真实 CLI 的剩余验收受本机登录状态阻塞 |
| S3 | Codex app-server adapter | DONE | 新会话、流式文本/工具、续聊、打断、结束已真机实跑 |
| S4 | 任务数据与生命周期 provider 化 | DONE | provider/sessionId/model/effort 全链路持久化与恢复 |
| S5 | 桌面 UI 配置与展示 provider 化 | DONE | 新建/编辑/详情可选且正确展示 Claude/Codex |
| S6 | 本机 CLI 发现、版本/可用性与配置 | DONE | 两种 CLI 独立探测，缺失时给明确错误 |
| S7 | 日志、用量与 CLI 会话观察边界收口 | DONE | settled journal；Claude-only 能力按 capability 收口 |
| S8 | 文档与完整验收证据链 | BLOCKED | 实现文档完成；matrix 因真实 Claude 未登录及真机覆盖缺口未全绿 |
| S9 | 提交、push 与 PR 收口 | DONE | commit `8eec532` 已推送，草稿 PR #69 OPEN |

状态取值：TODO / DOING / DONE / BLOCKED。用例状态只记录在 `matrix.csv`，证据进入 `round-N.md`。

## Sub Goal 进展

- **Round 0**：完成范围收敛与第一轮盘点。确认改造面跨会话引擎、任务元数据、日志、配置和 UI；
  参考实现的 Codex 主路径是 app-server。双仓静态盘点、官方协议核对、Codex 0.144.5 Windows 真机
  `initialize/thread/start/turn/start/delta/usage/completed` 冒烟均完成，设计快照落
  `docs/spec/desktop-dual-provider.md`，**S0 DONE**。进入 S1-S4 并行实现。
- **Round 1**：完成 S1-S7。provider fixture、任务数据、journal、runner、外部 API 与桌面 UI 均通过；
  Codex 0.144.5 真机完成新会话、流式文本、shell 工具、多轮 resume、usage 与 interrupt，并修复快速连发竞态及
  Windows 关闭时孤儿工具进程问题。Claude 2.1.207 在本轮后段变为 `loggedIn:false`，真实审批/中断无法继续，
  因而 S8 按严格口径保持 BLOCKED；完整证据见 `round-1.md`。实现已提交并推送，草稿 PR #69 状态由
  `gh pr view` 核验为 OPEN。

## 当前盲点 / 外部阻塞

- Claude CLI 2.1.207 当前 `loggedIn:false`；重新登录前不能完成真实 tool approval 与 interrupt 回归。
- Codex 真机已覆盖 command tool 与 interrupt，但 reasoning、file change、MCP tool 和 approval allow/deny 目前只由
  app-server 协议 fixture 覆盖；后续需在受控临时目录中补真机用例。
- Claude 专属的终端观察/收养、rewind、account usage 不为 Codex 伪造等价能力，均由 capability 显式隐藏。
