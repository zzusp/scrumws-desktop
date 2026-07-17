# round-1（2026-07-17）：桌面端外部任务 API + API 密钥页 · 30/30 PASS

## 环境（隔离，不碰真实 8799/~/.scrumws）

```
cd <worktree>
SCRUMWS_PORT=18799 SCRUMWS_DATA_ROOT=<scratch>\dataroot-r2 DASHBOARD_NO_SCHEDULER=1 node platform/standalone.js
```

- 用例只建 plan 任务（不触发 claude 会话，不烧额度）；`plan:false` 自动执行路径不在本轮 e2e（全量复用既有 createTask queued 逻辑，见 plan.md）。
- 结束后按端口定点杀 PID（不按进程名，避免误杀用户桌面应用）。

## A/B/C/D/E：API 用例（scripts/api-tests.mjs）

```
node docs/acceptance/external-task-api/scripts/api-tests.mjs http://127.0.0.1:18799 <scratch>\dataroot-r2
== 24/24 PASS ==
```

关键证据（完整输出见当轮终端）：

- B3：`chat:20260717165701-610 state=plan`（请求体带 `source:"hacker"` 被忽略，taskKey 前缀=密钥绑定的 chat）
- B4 磁盘：`...\dataroot-r2\runtime\runner-state\chat__20260717165701-610\task.json` → `source=chat externalKey=e2e-1`，`state.json → plan`
- B5 幂等：二次同键 POST → `existed=true`，taskKey 不变
- B6：issue 密钥同键 → `issue:20260717165701-824`（按 source 分命名空间）
- D3：`/api/task/delete` 删任务后同键重建 → 新 taskKey `chat:20260717165701-708`
- D1/D4：禁用/删除密钥后 → 401

## S1：看板集成

```
curl -s http://127.0.0.1:18799/api/state
→ lifecycle.plan = [chat:20260717165701-708, issue:20260717165701-824]（len 2，其余桶 0）
```

## U1–U5：UI 冒烟（scripts/ui-smoke.mjs，puppeteer-core + 系统 Edge headless）

```
node docs/acceptance/external-task-api/scripts/ui-smoke.mjs http://127.0.0.1:18799
== 5/5 PASS ==
```

- U1：`#view-apikeys` rect 1144×330（非退化），`#view-board` rect 0×0（负对照），nav active=apikeys，面包屑「ScrumWS › API 密钥」
- U2：明文框出现且正则命中 `^swak_[A-Za-z0-9_-]{40,}$`，curl 示例含 `/api/external/task/create`
- U5：删除走 customConfirm 弹窗（文案「删除密钥」）确认后行移除
- 截图人工复核：侧边栏图标/高亮、一次性明文黄条+复制按钮、curl 代码块、密钥表格（前缀脱敏、启用 tag、禁用/删除按钮）均正常。截图不入库，复现：`UI_SHOT=<路径> node scripts/ui-smoke.mjs`

## 已知一轮内修正

- A6 首跑 FAIL 为用例断言 bug（把有意展示的 12 位 prefix 误判为明文泄漏），修正断言（完整明文=swak_ 后 ≥40 字符）后全绿；产品代码无改动。
