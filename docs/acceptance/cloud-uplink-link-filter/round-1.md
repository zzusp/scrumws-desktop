# round-1 · 对账过滤验证

- 日期：2026-07-18
- 分支：`worktree-cloud-uplink-link-filter`
- 脚本：`scripts/verify-reconcile-filter.mjs`（沙箱 `SCRUMWS_DATA_ROOT` + node:http mock cloud，驱动真实 `reconcileOnce()`）
- 环境：本机 node，未碰真实云端 / 共享库 / 8799

## 用例与结果（全绿 7/7）

| # | 用例 | 断言 | 结果 |
|---|---|---|---|
| P1-a | linked 有 link 文件 | upsert body.tasks 只含 `cloud:linked-1` | PASS |
| P1-b | 同上 | digest body.tasks 只含 `cloud:linked-1` | PASS |
| P1-c | 同上 | `reconcileOnce().pushed === 1` | PASS |
| P2-a | 移除 link 后再对账 | digest 集合为空（不再报该任务） | PASS |
| P2-b | 同上 | 无 upsert 调用 | PASS |
| P2-c | 同上 | `pushed === 0` | PASS |
| NC | 负对照 | 本地任务 `manual:local-1` 全程不出现在任何请求体 | PASS |

**关键证据**：snapshot 里同时有 `cloud:linked-1`（processing）与 `manual:local-1`（queued）两张卡；
P1 阶段 upsert/digest **只**带 linked 那张，本地那张即便在快照里也从未外泄（NC）→ 决策 14「本地任务不上云」成立。
P2 阶段移除 link 后连 linked 也被摘掉（digest 空 / 无 upsert）→ 证明门控在「有没有 link」，不是恒不上行的 no-op。

## 运行输出

```
PASS: P1 upsert 只含 linked 任务
PASS: P1 digest 只含 linked 任务
PASS: P1 pushed === 1
PASS: P2 无 link → digest 集合为空
PASS: P2 无 link → 无 upsert 调用
PASS: P2 pushed === 0
PASS: 负对照：manual:local-1 从未出现在任何请求体

=== 全部 PASS ===
```

## 复现

```powershell
node docs/acceptance/cloud-uplink-link-filter/scripts/verify-reconcile-filter.mjs
```
