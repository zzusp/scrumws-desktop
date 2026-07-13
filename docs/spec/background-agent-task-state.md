# 后台 agent（subagent）识别与任务状态统一

## 症状

用户报告：任务 `manual:20260713163053-373` "并没有结束，只是把主进程空出来，等待后台 subagent 处理完成，这时应该还是 processing"。实测该任务盘上 `state=awaiting-human`（`~/.scrumws/runtime/runner-state/manual__20260713163053-373/state.json`），history 末段 `18:33 processing → 18:50 awaiting-human`——主 agent 一轮收敛即被判为"等人"，未识别"后台 agent 仍在跑"。

## CC 后台 subagent 机制（学习自 claude-code-leak + 真实 jsonl 反证）

### 事件模型
- **主 agent 让出**：一轮结束 emit `system/turn_duration`（stream-json 里对应 `result`）。
- **后台计数字段**：`turn_duration.pendingBackgroundAgentCount`（简称 pbg）= 该轮结束时仍在跑的后台 agent 数。
- **自动续跑**：后台 agent 完成 → CC 自动注入 `queue-operation` + `<task-notification>` user 消息唤醒主 agent → 新一轮 `turn_duration`，pbg 递减。全自动，无需真人发消息。

证据（真实 jsonl `D--baibu-agent/04689bb1-3ae6-461d-8d74-3a0d74aeb0c8.jsonl`）：
```
行38 system/turn_duration pbg=3   ← 主 agent 让出，3 个后台 Explore/Plan agent 在跑
行39-41 queue-operation + user <task-notification>  ← 自动注入，唤醒
行45 system/turn_duration pbg=2   ← 一个后台完成
行52 system/turn_duration pbg=1
行72 system/turn_duration pbg=1
```

### 字段挂载与陷阱（全局扫 484 jsonl / 14 万行）
- `pendingBackgroundAgentCount` **只挂在 `type:system, subtype:turn_duration` 事件上**（全局 26 次全是 system）。
- 含 pbg 的 8 个文件，其**最后一条 JSON 事件的 pbg 全为 ABSENT**——末尾恒为 `last-prompt/ai-title/mode/permission-mode` 元事件。
- ⇒ 取 pbg 必须找**最后一条 turn_duration**，不能取末行事件。
- `isSidechain:true` 全局 **0 命中**——subagent transcript 落独立 sidechain 文件，不进主 session jsonl，故**不能**用它识别 subagent，只能用 pbg。
- stream-json 的 `result` 事件 schema（leak `coreSchemas.ts:1407` SDKResultSuccessSchema）**不含** pbg——task-runner 消费的事件流拿不到，只能反读 jsonl。

## 根因（本项目现状）

1. **死代码 bug**：`collect-cli.js:263` `const pendingBg = Number(last?.pendingBackgroundAgentCount) || 0` —— `last` 是末尾元事件，pbg 永远 0，`bg×N` 徽章从不显示。应取 `lastTurn`（已在 `extractTailInfo` 里解析）。
2. **仅 cli 任务**：pbg 只在 `collectOneCli` 读取写入 `cli.pendingBackgroundAgentCount`；runner-state 任务（manual/file/issue/chat）`collectOne` 完全不读——违背"不同来源都是任务，字段统一"（恰是本 manual 任务的主题）。
3. **不参与 state**：pbg>0 时，卡片仍按主 agent 状态落 `awaiting-human` 桶。

## 方案（在采集/展示层统一叠加"后台维度"，不改 task-runner/checker）

选择在 collect 层叠加而非改 task-runner 的理由：
- pbg 是 jsonl 派生信号，collect 层已在读 jsonl；stream-json 流不带 pbg。
- `runner-checker` 跳过 `awaiting-human`（line 31），叠加只影响展示、`state.json` 语义不变，不会被误收孤儿。
- 一处逻辑对两类任务（runner / cli）同时生效，符合"统一"。

### 数据层
1. 新增共享函数 `readBackgroundAgentCount(jsonlPath)`（collect-cli.js，复用现有 `readLinesSplit`/`extractTailInfo`）：反读 jsonl，返回最后一条 `turn_duration` 的 `pendingBackgroundAgentCount`（无则 0）。
2. `collectOneCli`：`pendingBg` 改从 `lastTurn?.pendingBackgroundAgentCount` 读（修 bug）。
3. `collectOne`（runner-state）：经 `meta.sessionId` + `task.cwd` 直接拼 jsonl 路径（`~/.claude/projects/<enc-cwd>/<sid>.jsonl`，fallback `locateJsonlBySid`）读 pbg。**仅当** `state==awaiting-human && mbSessionId 活` 时才读（性能：只有"疑似空闲但可能有后台"的任务读一次 jsonl tail）。

### 状态判定（统一字段）
- 卡片新增统一字段 `backgroundAgentCount: number`（runner + cli 都有）。
- 覆盖规则：**会话进程活 + 主 agent 已收敛(awaiting-human) + backgroundAgentCount>0 → state 覆盖为 processing**。
  - runner 活性：`mbSessionId` 非空（Mode B idle-but-alive）。
  - cli 活性：`isCliSessionActive`（board/att/replyRunner）。
- pbg 归零（后台全完成）→ 自然回落 awaiting-human。

### 渲染层
- 卡片：`bg×N` 徽章数据源从 `t.cli.pendingBackgroundAgentCount` 改为统一 `t.backgroundAgentCount`，所有来源任务可显。
- 详情"任务信息"：落地 `app.js:1189` 预留的"后台 agent"字段，用统一字段展示。
- processing 卡片：后台运行态给一句可读文案（"后台 N 个 agent 运行中"）。

## 改动清单
- `platform/lib/collect-cli.js`：新增 `readBackgroundAgentCount`；`collectOneCli` 修 pbg 源 + 输出统一 `backgroundAgentCount`。
- `platform/lib/collect.js`：`collectOne` 读 runner 任务 pbg + 统一字段 + state 覆盖。
- `platform/public/app.js`：徽章/详情改用统一字段 + processing 后台文案。
- （不改）`task-runner.js` / `runner-checker.js`：语义不变。

## 验证计划
1. 单元：直接对真实 jsonl（04689bb1，含 pbg 序列）调 `readBackgroundAgentCount`，断言取到最后 turn_duration 的 pbg 值。
2. 集成：构造一个 `state=awaiting-human` + 活会话 + jsonl 末 turn_duration pbg>0 的场景，调 `collectState`，断言该卡片进 processing 桶且带 `backgroundAgentCount`。
3. 前端：起服务（空闲端口），看卡片 `bg×N` 徽章 + 详情后台字段渲染。
