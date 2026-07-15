# round-1：退回计划 + 再执行续对话

日期 2026-07-15。分支 `worktree-20260714212427-166`。claude CLI 2.1.209。

## 用例与结果（全 PASS）

| # | 用例 | 结果 | 证据 |
|---|---|---|---|
| 1 | `moveTaskToPlan`：awaiting-human → plan，清 outcome/resolvedAt/failureReason、追 history(plan/by:user)、**保留 meta.sessionId** | PASS | `scripts/verify-logic.mjs` [1] |
| 2 | `moveTaskToPlan`：done → plan | PASS | verify-logic [2] |
| 3 | 非终态（processing / plan 本身）拒绝退回 | PASS | verify-logic [3] |
| 4 | CLI 键（`cli:*`）拒绝退回 | PASS | verify-logic [4] |
| 5 | `deleteTask` guard：plan 且有 sessionId（退回来的）拒删、目录仍在 | PASS | verify-logic [5] |
| 6 | `deleteTask`：plan 无 sessionId（纯草稿）正常删除 | PASS | verify-logic [6] |
| 7 | **端到端续对话**：第1轮记数字 4271 → 退回 plan → 编辑 prompt 改问数字 → 确认执行走 resume 分支 → 答复含 4271 | PASS | `scripts/verify-resume-e2e.mjs` |
| 8 | 服务启动 + 路由 `/api/task/to-plan` wiring（不存在键 400 / cli 键 400 明确报错） | PASS | 手动 curl 冒烟 |

## 关键证据

**逻辑（verify-logic.mjs）**：`✅ ALL PASS : 14 passed, 0 failed`

**端到端（verify-resume-e2e.mjs，真 claude）**：
```
[1] round1 答复: "记住了" · ✅ 第 1 轮全新会话（无 resume）· ✅ 落 meta.sessionId
[2] ✅ 退回 plan 成功 · ✅ meta.sessionId 保留 · ✅ 空转会话已关闭
[3] ✅ editTask 成功（prompt 改问数字）
[4] ✅ 第 2 轮走 resume 分支（会话 claudeSessionId=第1轮sid）
    round2 答复: "4271" · ✅ 答复含暗号 4271 = 确实续上了之前的对话
==== ✅ E2E PASS : 0 failed ====
```
第 2 轮是**独立新 claude 进程**却答出第 1 轮才告知的 4271 → 证明确经 `--resume` 续上原会话，而非从头新起。

**服务冒烟**：
```
POST /api/task/to-plan?taskKey=manual:nope-999 → 400 {"ok":false,"error":"task not found（归档任务请先取消归档再退回计划）"}
POST /api/task/to-plan?taskKey=cli:abcd1234    → 400 {"ok":false,"error":"CLI 会话无 plan 态，不能退回计划"}
```

## 未做 / 已知局限

- 浏览器端点击 E2E 未做（纯 wiring：按钮 → `/api/task/to-plan` → `refreshState`，与既有 complete/uncomplete 动作同构）。
- worktree 任务退回 plan 后若在编辑里改掉 worktree 开关，`--resume` 的 cwd 可能与原 jsonl 记录目录不一致（既有 worktree 复杂度，非本特性引入）——未处理。
</content>
