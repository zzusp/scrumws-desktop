# goal · 把终端交互搬进看板（Board-Owned 交互式 Claude 会话）

设计快照见 `docs/spec/board-interactive-session.md`。本文件是多轮实现的进度锚点。

## 总目标

尽可能把"在终端里对 claude 的操作"搬进看板，**两模式并存**：Mode A 被动观察（沿用）+
Mode B 看板持有交互进程（新增）。Mode B 用**裸 `claude` CLI stream-json + control 协议**实现，
不引 npm SDK。

## 重要信息（已验证 ground truth）

- 交互命令（本机 claude 2.1.207 实测生效）：
  `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio [--resume <sid>]`
- 权限委派实测：Write 工具触发 `control_request/can_use_tool`，文件在看板回 `control_response` 前**不执行**。
- Mode A 磁盘 JSONL = block 级 + per-message-final usage → 逐字/生成中 token 增长**做不到**（Mode B 才能）。

## 重大决策

- **D1**（用户定）：目标形态 = **两模式并存**（非"全面弃终端"，非"仅增强异步"）。
- **D2**（用户定）：交互操作**全搬**——权限确认 / 打断转向 / 逐字+实时token / 交互式确认 /
  AskUserQuestion 类，优先级见 matrix。
- **D3**（技术定）：Mode B 走裸 `claude` CLI（零依赖、复用现有二进制+鉴权），**不引 Agent SDK npm 包**。
- **D4**（Round 1 定，证据侧）：**dws 是 claude 当工具调的分身 API，非 claude 模型鉴权器**。
  Mode B 跑 claude 只需 claude 自身 `~/.claude` 鉴权（等同终端登录态）；dws-auth 仅对"会话内用
  dws 工具（钉钉/分身 API）"是前置，沿用现有 `dwsAuthGate`。证据见 `round-1.md`。

## Sub Goal Matrix（唯一进度总表）

| # | Sub Goal | 层 | 优先级 | 状态 | 说明 |
|---|---|---|---|---|---|
| S0 | 设计快照 + goal 锚点 | — | — | DONE | spec + 本文件 |
| S1 | 块级近实时（5s 轮询 → SSE + fs.watch） | L1 | — | DONE | Round 2；E2E 首帧+块级推送+done 全绿 |
| S2 | 每步计时（时间戳差 + 当前步 live 跳秒） | L1 | — | DONE | Round 4；D5 定时间戳差；_ts+fmtStepDur 测 8/8 |
| S3 | 每轮上/下行 token 展示补齐 | L1 | — | DONE | Round 3；roundTokenStats 单测 5/5 |
| S4 | 双向流骨架（SessionManager + spawn + stdout 解析 + HTTP/SSE） | L2 | 前置 | DONE | Round 5；引擎 E2E 6/6 + HTTP 8/8（前端渲染并入 S5） |
| S5 | Mode B 前端会话视图 + 工具权限确认 UI | L2 | #1 | DONE | Round 6；权限闭环真 claude 3/3 + 前端通路 11/11 |
| S6 | 进行中打断/转向（interrupt + 插话） | L2 | #2 | DONE | Round 7；引擎 6/6 + 浏览器 4/4 真 claude |
| S7 | Mode B 每步计时 + 实时 token 计数器 | L2 | #3 | DONE | Round 8；浏览器 7/7；D7 记 message_delta 末尾唯一 |
| S8 | 交互式确认 + AskUserQuestion 类工具履约 | L2 | #4/#5 | DONE | Round 9；引擎 3/3 + 浏览器 5/5；D8 |
| S9 | /model 切换 + set_permission_mode | L2 | #6 | TODO | control_request |
| S10 | Mode A→B 收养（终端会话看板续接） | L3 | — | DONE | Round 10；resume 3/3 + 收养引擎 5/5 + HTTP 3/3 |
| S11a | dws 鉴权前置关系确认 | 横切 | — | DONE | 见 D4；dws≠claude 鉴权器 |
| S11b | Mode B 命令 flag + 权限委派实测（macOS） | 横切 | — | DONE | Round 1 冒烟 8/8 PASS |
| S11c | 同上 Windows 侧复跑 | 横切 | — | OPTIONAL | 非阻塞：Mode B 已在 macOS 证明(S4/S11b)；仅当要上 Windows 再抽查 |

状态取值：TODO / DOING / DONE / BLOCKED。用例级 PASS/FAIL 证据进 `matrix.csv` + `round-N.md`。

## Sub Goal 进展

- **Round 0**：完成 S0。核心技术风险（权限委派 linchpin）已在本机实测消解；
  形态与优先级由用户拍板（D1/D2）。
- **Round 1（S11 前置）**：用户定"并行 + 先补 S11"。产出 `verify-modeb.mjs`（跨平台）、
  `round-1.md`、`matrix.csv`。**S11a DONE**（dws 关系定性，D4）；**S11b DONE**（macOS 冒烟 8/8 PASS）；
  **S11c BLOCKED**（待 Windows 复跑）。
- **Round 2（L1 / S1，本轮）**：用户定"启动 L1，先落 S1 块级 SSE"。**S1 DONE**。改 `server.js`
  （+SSE 端点 `/api/worker-log/stream` + `startWorkerLogStream` + 块级 `wlFingerprint`）、`logs.js`
  （readWorkerLog return 补 `state`）、`app.js`（EventSource 替换 5s 定时器 + 块级 `modalContentFp`
  + SSE 断回落轮询）。进程内 E2E 全绿（见 round-2.md）：首帧 processing、追加"同 message.id 新
  content block"触发推送、翻 done 关闭。
- **Round 3（L1 / S3）**：用户定"先落 S3 token 展示，再起 S2"。**S3 DONE**：`app.js` 加
  `roundTokenStats` + 每轮 footer 渲染上/下行 token；单测 5/5 + 真实数据 sanity（见 round-3.md）。
  接着起 S2，但发现其实现路径需先决策（见下方 D5 待定）。
- **D5（S2 实现路径，用户已定）**：S2 走 **(a) 时间戳差落 L1**；(b) Hooks 挪 L2。
- **D9（S10 实测，2026-07-12，用户需求）**：**Mode A→B 收养**——终端起的会话加看板后、终端退出，看板可续接。
  机制：`--resume <sessionId>` 续同一 CC session（实测 3/3，记得"teal"，且续的是同一 session_id/追加写同一 jsonl）。
  收养流程：`readCcSessionForAdopt`（`locateJsonlBySid` 全局定位 + `parseCcSession` 推 cwd/model + 历史消息）→
  `createSession({resume, seedTranscript})` 预置历史 → Mode B 视图 SSE 回放历史 + 实时续接，效果同看板发起。
  **cwd 是关键**（--resume 靠它定位会话文件 + Mode B 工作目录）。仅做「收养」方向；「detach」（Mode B 会话退回
  Mode A 观察）未做——但因续接写同一 jsonl，Mode A 观察它天然可行，只差显式动作。
- **D8（S8 实测，2026-07-12）**：**AskUserQuestion 走 `can_use_tool` 权限通道**（tool_use + control_request），
  不产生 result、会话挂起等应答。答案经**应答的 `updatedInput.answers`（`{问题文本: 选项label}`，多选逗号分隔）**
  回传（源码 `AskUserQuestionTool.tsx:56/182-188`：checkPermissions→ask、call({questions,answers})→result）。
  实测 allow+answers → claude 回 "YOU PICKED TEA"。ExitPlanMode/EnterPlanMode 等其他交互工具预计同通道（本轮仅验 AskUserQuestion）。
- **D7（S7 实测修正，2026-07-12）**：**Claude Code stream-json 只在每轮末尾发一次 `message_delta`**（含最终
  `output_tokens`）——即使 400 字 essay/898 tokens 也只 1 次（两次实测证伪）。⇒ "逐 token 增长的下行计数器"
  **不可得**（修正最初调研 agent"message_delta 增量到达"的说法）。S7 下行改为：生成中按累计 delta 字符 `~` 估算、
  末尾 message_delta 校正真值；上行 message_start 即知真值。另：stream-json 的 `assistant` 事件是**增量**（同
  message.id 拆 thinking/text/tool_use），需前端按 id 合并（同 Mode A parseCcSession）。
- **D6（平台，2026-07-12 修正）**：**Mode B 跨平台、已在 macOS 用真 claude 证明**（S4 引擎 6/6 + HTTP 8/8，
  含 `--permission-prompt-tool stdio` 权限委派 S11b）。此前把 S11c（Windows 抽查）当 S5 前置是**过度保守**——
  Windows 耦合的只是 Mode A 的 pwsh worker/数据根/`--win` 打包；Mode B 与之无关。S5 在 macOS 全量开发+验证，
  S11c 降为"将来上 Windows 再抽查"，不阻塞。
- **Round 4（L1 / S2）**：**S2 DONE**。`logs.js` `parseCcSession` 给每个 content block 补 `_ts`
  （所在 jsonl 行 timestamp）；`app.js` 加 `fmtStepDur`（亚秒）+ `tickLiveTimers`（1s 跳秒）+
  `renderCcTool` 渲染每步耗时（`tool_use._ts→tool_result._ts`）、进行中轮未完成工具挂 live 跳秒
  （inflight 透传 renderCcFlow→renderCcTool）。测 8/8（_ts 端到端 + fmtStepDur）+ S1 SSE E2E 无回归。
  见 round-4.md。L1 三件（S1/S2/S3）全 DONE。下一轮候选：起 S4（L2 地基），或先等 S11c（Windows）回传。
- **Round 5（L2 / S4，本轮）**：用户定"起 S4，L2 地基"。**S4 DONE**：新增 `platform/lib/session-manager.js`
  （看板持有 claude 交互进程：spawn stream-json 双向 + 解析 NDJSON + transcript + stdin 原语，含为 S5/S6
  预留的 `respondPermission`/`interruptSession`），`server.js` 加 `/api/session/{create,stream(SSE),send,close,list}`。
  **真 claude E2E 全绿**：引擎 in-process **6/6**（拿 CC session_id、逐字 text_delta、pong→ping 双向多轮、close 收敛）+
  HTTP 全栈 **8/8**（SSE 逐字 over the wire）。见 round-5.md。**注意**：S4 纯后端引擎，前端 Mode B 会话视图 +
  逐字渲染并入 S5（权限 UI 天然需要会话视图）。下一轮：S5（权限确认 UI + Mode B 前端），需 S11c（Windows）先回传。
- **Round 6（L2 / S5，本轮）**：用户定"先在 macOS 把 S5 前端做出来"+ 质疑"为什么非 Windows"（→ D6 修正，
  Windows 非前置）。**S5 DONE**：后端加 `/api/session/{respond,interrupt}` + `respondPermission` 健壮化；
  前端 `index.html`（入口按钮 + `view-session` 视图 + 新建会话 modal + CSS）、`app.js`（Mode B 整块：
  `loadSession`/SSE 消费/`mbToRounds` 复用 renderDetailTab/逐字 live 泡/**权限卡 允许·拒绝**/发送/打断/结束）。
  **验证**：权限闭环真 claude **3/3**（allow→文件建、deny→不建）；前端 `mbToRounds` + 全 HTTP 权限路径 **11/11**
  （SSE 送 control_request→提取顶层 request_id→POST /respond→工具执行）；14 个 DOM id 交叉核对全中。
  **真浏览器 E2E**（Electron/Chromium 驱动真前端）：功能流 9/10（1 采样时序、非 bug）+ 逐字定论 3/3
  （`#mbLive` 长度序列 16→76→151→199 = 流式增长）—— **原 5 个 BY-INSPECTION 全转 PASS**。见 round-6.md。
  下一轮：S6（打断/插话，原语已就位）/ S7（Mode B 每步计时+token 计数器细化）。

- **Round 7（补 Mode A 渲染真浏览器 E2E + S6）**：用户定"顺手把 3 个 Mode A 渲染项清了再进 S6"。
  新增 `scripts/browser-e2e-modea.cjs`（造 processing 任务 + in-flight jsonl，Electron 开 #/task/ 断言）：
  **S3 token footer**（`↑ 5,112 / ↓ 34 · 缓存 5,000`）、**S2 live 跳秒**（`· 9s→· 11s` 真在跳）、
  **S1 SSE 块级推送**（追加块 ~400ms 到达）+ **回落轮询**（删 EventSource 后仍更新）—— 6/6 PASS，
  三项 BY-INSPECTION 转 PASS。**S6 DONE**：`interruptSession` 原语 + 打断按钮 + 输入框转向。
  引擎 E2E `scratchpad/s6-interrupt-e2e.mjs` **6/6**（长输出中途 interrupt → turn ~200ms 结束、
  输出 123→143 字截断 vs 完整 >3000、转向发新指令拿到 REDIRECTED）；真浏览器 `scripts/browser-e2e-interrupt.cjs`
  **4/4**（点「打断」按钮 turn 截断 523→577、输入框转向拿到 REDIRECTED）。matrix：26 PASS + 0 BY-INSPECTION。
  L2 已完成 S4/S5/S6（#1 权限 #2 打断转向）。下一轮：S7（Mode B 每步计时 + 实时 token 计数器细化）/ S9（切模型）/ S10（会话迁移）。
- **Round 8（L2 / S7）**：**S7 DONE**（见 D7 实测发现）。`session-manager.js` 给 Mode B content block 补收到时刻 `_ts`；
  `app.js` `mbToRounds` 按 message.id 合并增量 assistant 事件 + 实时 token 读数（上行即时真值 / 下行生成中~估算→末尾真值
  / footer 贴回 message_delta usage）。真浏览器 `scripts/browser-e2e-modeb-s7.cjs` **7/7**（token 序列
  ↑29737 / ↓~0→~377→528、每步 `· 540ms`、进行中跳秒、footer 真值），S5 回归 9/9。matrix：31 PASS。
  **L2 核心 S4/S5/S6/S7 全 DONE**（地基 + #1 权限 + #2 打断转向 + #3 逐字/计时/token）。剩 S9 切模型 / S10 会话迁移。
- **Round 9（L2 / S8）**：**S8 DONE**（见 D8）。`respondPermission` 加 `extraInput`、`/respond` 接 `answers`、
  前端权限卡按 tool_name 分支渲染 AskUserQuestion 交互选项卡（`mbAskCardHtml`/`mbSubmitAnswers`）。
  机制真 claude **3/3**（allow+answers→"YOU PICKED TEA"）+ 真浏览器 **5/5**（渲染问题/选项→选中提交→claude 继续），
  普通权限卡回归 9/9。matrix：33 PASS。**L2 交互面 S5/S6/S7/S8 全 DONE**（权限/打断/计时token/交互确认）。剩 S9/S10。
- **Round 10（L3 / S10 收养）**：用户需求"终端会话退出后看板续接"。**S10 收养方向 DONE**（见 D9）。
  `logs.js` 加 `readCcSessionForAdopt`、`session-manager.js` `createSession` 加 `seedTranscript`、
  `server.js` `POST /api/session/adopt`、`app.js` CLI 卡「在看板继续对话」按钮 + `adoptCliSession`。
  resume 上下文 **3/3**（teal）+ 收养引擎 **5/5**（mango，1 假失败=/var 软链接）+ HTTP/SSE 回放 **3/3**（BANANA42）。
  matrix：36 PASS。剩 S9（切模型）+ S10 detach 方向。

## 待办 / 盲点（进下一轮前需澄清）

- L1 与 L2 并行还是串行？（见 spec §8）
- Mode B 会话是否并入现有 task 卡片列 vs 独立视图？
- 权限决策是否记忆（allow-always）？
