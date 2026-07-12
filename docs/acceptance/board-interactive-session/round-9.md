# Round 9 · L2 / S8 交互式确认（AskUserQuestion 类工具履约）

日期：2026-07-12。环境：macOS，claude 2.1.207。spec §7 标的"host 履约待验证"盲点，本轮实测消解。

## 实测发现（D8）

真 claude 探针（`scratchpad/s8-probe.mjs`）+ 源码：

- **AskUserQuestion 走 `can_use_tool` 权限通道**：claude 抛 `tool_use:AskUserQuestion`（input.questions
  带 options/multiSelect）+ `control_request{subtype:can_use_tool, tool_name:AskUserQuestion}`，
  **不产生 result、会话挂起**（state=running, pendingPermissions=1）。
- **答案回传路径**：源码 `AskUserQuestionTool.tsx:56`（input.answers "collected by the permission
  component"）、`:182-188`（checkPermissions→`behavior:'ask'`, updatedInput:input）、`:209-222`
  （`call({questions, answers})`→result）。⇒ 应答 `can_use_tool` 时在 `updatedInput.answers`
  塞 `{问题文本: 选项label}`（多选逗号分隔），CLI 据此执行工具产出 tool_result。

## 改动

- `platform/lib/session-manager.js`：`respondPermission(id, requestId, allow, extraInput)` 加 `extraInput`
  —— 合并进 `updatedInput`（AskUserQuestion 用它带 `{answers}`）。
- `platform/server.js`：`/api/session/respond` 接 `answers` → 转 `{answers}` 作 extraInput。
- `platform/public/app.js`：权限卡按 `tool_name` 分支——`AskUserQuestion` 且有 questions → `mbAskCardHtml`
  渲染问题 + 选项（单选 radio / 多选 checkbox）；`mbSubmitAnswers` 收集选择 → `answers{问题:选项}` → `/respond`。
- `platform/public/index.html`：`.ask-card` / `.ask-opt` 等 CSS。

## 验证

**机制 · 真 claude**（`scratchpad/s8-mech-e2e.mjs`）**3/3**：AskUserQuestion 抛 tool_use → can_use_tool →
应答 `allow + updatedInput.answers={问题:"Tea"}` → **claude 拿到答案继续回 "YOU PICKED TEA"**。

**前端 · 真浏览器**（`scripts/browser-e2e-askquestion.cjs`）**5/5**：
- AskUserQuestion 渲染成**交互选项卡**（非裸 allow/deny）
- 卡含问题 + Tea/Coffee 选项（≥2 个 input）
- 选中 Tea → 点提交 → 交互卡移除 → **claude 拿到答案继续**（会话流含 PICKED/TEA）
- 尾巴同时可见 token footer `↑29,711/↓235·缓存` + 每步时长一起工作

**回归**：普通权限卡（allow/deny，Write 工具）`browser-e2e-modeb.cjs` 仍 **9/9**。无孤儿进程。

## 状态

- matrix：**33 PASS**。L2：S4/S5/S6/S7/S8 全 DONE。sub-goal 剩 S9（切模型/权限模式）、S10（会话迁移）。

## 盲点

- ⚠️ 仅验 AskUserQuestion；**ExitPlanMode / EnterPlanMode** 预计同 `can_use_tool` 通道但未实测——
  当前它们会走裸 allow/deny 卡（input 里能看到 plan 文本），够用但没做专属 UI。
- ⚠️ 多选（multiSelect）UI 已渲染 checkbox + 逗号拼接答案，但未用真多选场景实测。
- ⚠️ AskUserQuestion 的 `annotations`（preview/notes）未透传。
