# 合并方案：把 Mode B 实时会话折进任务详情页（退掉独立 `#/session/`）

> 状态：开工前设计快照（spec，不回头维护）。落地进度另起 goal/round。
> 上游背景：`docs/spec/board-interactive-session.md`（Mode B 引擎）、
> `docs/acceptance/task-autorun-modeb/`（交互会话统一为任务）。

## 0. TL;DR

现在一个 processing 的看板任务，点卡片会**跳到独立满宽视图 `#/session/<id>`**，而不是旧的
`#/task/<key>` 详情。根因不是技术必需，是**半成品统一的遗留**：Mode B 会话面是
`board-interactive-session` 阶段先做的独立视图，`task-autorun-modeb` 才拍板"会话并入任务"
（D1），但"并入"只做成了**路由跳转**（`openTaskModal` 见 mbSessionId 就跳 `#/session/`，
`app.js:493-497`），没把 live 能力搬进任务详情壳。

**目标**：一个详情路由 `#/task/<key>`、一个壳子。任务有活 Mode B 会话就连
`/api/session/stream`（逐字 / 权限卡 / 打断 / 状态行 / token），没有就读磁盘 jsonl
（`/api/worker-log`）当只读历史。退掉 `#/session/` 独立路由与 `view-session` DOM。

## 1. 现状（ground truth，file:line）

### 1.1 两套壳子

| | 旧任务详情 `view-task` | Mode B 会话面 `view-session` |
|---|---|---|
| 路由 | `#/task/<key>` → `loadTaskDetail`（`app.js:499`）| `#/session/<id>` → `loadSession`（`app.js:1830`）|
| 头部 | `renderTaskSide`（右侧任务信息块）| `mbRenderHead`（`app.js:1926`：返回/任务/会话/模型/cwd/token/结束会话）|
| 正文容器 | `#modalBody`（`index.html:654`）| `#sessionBody`（`index.html:704`）|
| 正文渲染 | `renderModalBody→renderDetailTab`（`app.js:658`）| `mbRenderBody→renderDetailTab`（`app.js:1996`）**同一渲染器** |
| 数据源 | 磁盘 jsonl：`/api/worker-log` + 块级 SSE `/api/worker-log/stream`（`app.js:506/551`）| 活进程 SSE `/api/session/stream`（`app.js:1836`）|
| 语义 | Mode A 观察：块级、无逐 token、无权限、无打断 | 逐字 `text_delta`、实时 token、`can_use_tool` 权限卡、interrupt |
| composer | `#modalReplyBox` 四态机（`updateReplyBoxAvailability` `app.js:709`）：可回复 / CLI 三态 / **处理中禁发** / 重发 | `#sessionInput`+发送+`■打断`（`index.html:707-712`），发送 `mbSend`（`app.js:2069`）|

### 1.2 两个关键事实（决定合并成本低）

- **composer 已是超集**：`mbSend`（`app.js:2079-2082`）在会话**绑定任务**时**已走
  `/api/task/reply`**，非绑定（CLI 收养）才走 `/api/session/send`。合并不用新造发送逻辑。
- **正文渲染同源**：两边都调 `renderDetailTab`（`app.js:1087`）。`mbToRounds`（`app.js:1898`）
  把 Mode B 流事件转成 `renderDetailTab` 认识的 `rounds` 形状。差的是**数据管子 + 交互件**，不是渲染。

### 1.3 分流入口

`openTaskModal`（`app.js:493-497`）：`t.mbSessionId` 存在 → `#/session/`；否则 `#/task/`。
`mbSessionId` = 注册表里活着/暖着的 Mode B 会话 id（由 collect 暴露到卡片）。
task-autorun-modeb 让**看板发起任务自动 queued→processing 绑定 Mode B 会话**，所以
processing 看板任务恒有 `mbSessionId` → 恒跳会话面。这就是"详情页变样"的直接原因。

## 2. 目标终态

- **单路由**：`#/task/<key>` 是唯一详情入口。`openTaskModal` 永远跳它，不再按 mbSessionId 分流。
- **单壳子**：`view-task` 内部按"任务是否有活会话"选数据管子与 composer 形态：
  - **有活 `mbSessionId`**（processing / awaiting-human 但会话暖着）→ 连 `/api/session/stream`，
    正文 = `mbRenderBody` 那套（transcript + live 泡 + 权限卡 + 状态行），composer = 常开输入
    + `■打断`（运行中可用）+ 发送走 `mbSend`（→`/api/task/reply`）。**支持处理中插话 / 打断**。
  - **无活会话**（终端已关 / done / Mode A 观察）→ 读 `/api/worker-log` 只读历史（processing 时
    块级 SSE 兜底），composer = 现四态机（可回复 / CLI 续接 / 重发 / 不可用）。
- **退场**：`#/session/<id>` 路由改为**重定向**到 owning task 的 `#/task/<taskKey>`（会话 info 带
  taskKey，`app.js:1932`/`1935`）；`view-session` DOM 删除；`loadSession`/`mbRenderHead` 折进
  任务详情加载路径；**「结束会话」按钮不保留**（D-b）。全部 `mb*` 事件机（`mbOnEvent`/`mbToRounds`/
  `mbRenderBody`/perms/token/status/`mbSend`/`mbRespond`/`mbInterrupt`）**保留复用**，仅把输出
  DOM 从 `#session*` 改指 `view-task` 容器。

**行为升级（顺带解决旧痛点）**：旧详情"处理中禁发"（`app.js:790-793`）在有活会话时**取消**——
Mode B 本就支持插话/打断，这正是"详情页该由 Mode B 承载"的意义。

## 3. 分步实施（每步可独立验证）

- **P1 路由归一**：`openTaskModal` 去掉 mbSessionId 分流，恒跳 `#/task/`；`router`
  （`app.js:666`）为 `#/session/<id>` 加重定向（查 session→taskKey，跳 `#/task/<taskKey>`）。
- **P2 详情加载分派**：`loadTaskDetail` 里判活会话——有 `mbSessionId` → 走会话管子
  （复用 `loadSession` 的 SSE 消费，输出改指 `#modalBody`），无 → 现磁盘 jsonl 路径不变。
- **P3 头部合并**：`mbRenderHead` 的 live 信息（会话 id / 模型 / cwd / token / 状态）并入
  `renderTaskSide`（D-a），不再要独立 `#sessionHead`；**不搬结束会话按钮**（D-b）。
- **P4 composer 合并**：`updateReplyBoxAvailability` 加"有活会话"分支——常开输入 + 打断 +
  `mbSend`；权限卡渲染进 `#modalBody` 尾部（`mbRenderBody` 逻辑）。旧四态机保留给无活会话。
- **P5 退场清理**：删 `view-session` DOM、`#/session/` 视图切换分支、`loadSession` 独立入口；
  `mb*` 函数 DOM 目标改指 `view-task`。
- **P6 文档同步**：更新 `docs/api/*`（若端点语义变）、README 里描述详情页的段落。

## 4. 决策（用户已拍板，2026-07-12）

- **D-a 头部形态 = 并入右侧任务信息块**。live 状态（会话 id / 模型 / cwd / token / 状态）
  塞进现有 `renderTaskSide` 块，不加独立状态条，保持看板视觉。
- **D-b 去掉「结束会话」按钮**。会话生命周期**纯由任务态驱动**，详情页不提供手动 close 入口
  （`mbCloseSession` 不搬进详情）。→ P3 头部合并**不含**结束会话按钮；P5 清理连带去掉它。
- **D-c 开放处理中插话 + 打断**（确认行为升级）。有活会话时处理中 composer 常开、可插话可 `■打断`，
  去掉旧的"处理中禁发"（`app.js:790-793`）。
- **D-d `#/session/` 旧链接 = 重定向到 `#/task/<taskKey>`**（查 session→taskKey）。

## 5. 验证方案（真浏览器 E2E，沿用 board-interactive-session 套路）

- V1 看板发起任务 → 点卡片落 `#/task/`（**不再跳 `#/session/`**）→ 正文逐字增长、权限卡可点。
- V2 处理中在详情 composer 插话 / `■打断` 生效（turn 截断）。
- V3 终端已关任务（无活会话）→ 详情仍是只读历史 + 续接对话（发消息收养）。
- V4 旧 `#/session/<id>` 链接 → 重定向到对应 `#/task/`。
- V5 无回归：done/awaiting-human 只读详情、块级 SSE 兜底、重发按钮。

## 6. 风险 / 盲点（诚实标注）

- ⚠️ **历史 vs live 的接缝**：无活会话读 jsonl 全量历史；有活会话 transcript 来自 seed+live。
  同一任务从"终端关→再收养成活会话"切换时，两个数据源的消息去重 / 续接需实测不断层。
- ⚠️ **composer 双形态的态切换**：任务从 processing（活会话）→ awaiting-human（会话可能仍暖）→
  会话被 close（回落只读）过程中，composer 要跟着切且不闪。
- ⚠️ **`renderTaskSide` 与 live 头部同时刷新**：两者都在 SSE 回调里重画，避免抖动 / 丢滚动位置
  （旧详情已有 `modalContentFp` 指纹防重画，`app.js:525`，live 侧需对齐）。
- ⚠️ **实施中发现的后端触点（原估"纯前端"需修正）**：CLI watchlist「收养」出的会话是**无主会话**
  （`/api/session/adopt` 建会话没传 taskKey），进不了 `#/task/` 的 live 模式。为彻底退掉 `#/session/`，
  额外做了 3 处小后端改动（source-of-truth 干净、不写 runner 文件）：`session-manager` 加
  `getSessionIdByTaskKey`、`task-runner.getTaskSessionId` 加该反查兜底、`adopt` 透传 taskKey。
  除此之外仍为前端 + 路由；`/api/session/*`、`/api/task/reply` 行为语义不变。
