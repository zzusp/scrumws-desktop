# 云端上行按 cloud link 过滤（决策 14 落地）· plan

## 需求

云端是**团队共享派活平台**，应只显示「云端下发到桌面端」的任务；桌面端的本地任务（UI 手敲 / CLI / API / 手机中继建）不该上云。主人要远程看/管自己机器的**全部**任务，走手机端 `/m/` 实时中继（不读云库，与本改动零冲突）。

> 用户 2026-07-18 确认：「云端和手机端的任务是两套……云端是共享平台，应该只显示云端任务数据。」
> 对应 `cloud-control-plane.md` 决策 14（用户此前已确认）：本地任务不全量上云，只同步有 cloud link 的；§6.3 对账按 link 过滤。

## 现状（改前）

- `platform/lib/cloud/reconcile.js` 的 `reconcileOnce` 摊平 6 个 lifecycle 桶**无过滤**全量上行（upsert + digest），云端存 `origin='local'`。
- P2「下发 / intent / link」机制**全网未落地**（只有设计文档，`worktree-cloud-pipeline-spec` 对 platform/cloud 零代码改动）；桌面无 `runtime/cloud/links/`、无 `source:'cloud'` 建任务路径。

## 方案

对账**在源头**按 cloud link 过滤（不按 source，守不变式 2）：

1. 新增 `platform/lib/cloud/links.js`：`readCloudLinks()` 读 `$DATA_ROOT/runtime/cloud/links/<intentId>.json`（spec §6.4 link 文件），汇出「已被云端下发」的本地 taskKey 集合。目录不存在 → 空集，绝不抛。
2. `reconcile.js` 顶部：`flattenCards(snapshot).filter((c) => c?.taskKey && linked.has(c.taskKey))`。cur / pending / digest / upsert / 账本全部据此收窄，本地任务在这一步就被摘掉。

**顺带清账**：被摘掉的历史本地卡不进 digest 集合 → 云端标 `mirror='local_missing'`，自然从看板收纳（无需碰共享库做数据手术）。

**前向兼容**：link 文件由将来 P2「下发消费」流程写（connector 消费 intent → createTask → 写 link，spec §6.4 step e）。本过滤只读。P2 落地前 links 为空 = 上行空集（决策 14 承认的目标终态：「云端在下行落地前是空的」）。

## 改动

| 文件 | 改动 |
|---|---|
| `platform/lib/cloud/links.js` | 新增：`readCloudLinks()` |
| `platform/lib/cloud/reconcile.js` | import + `reconcileOnce` 顶部按 link 过滤（+5 行） |
| `docs/spec/cloud-control-plane.md` | §6.3 「origin='local' 同样上行」段改为决策 14 落地说明 |
| `cloud/README.md` | 头部定位 + P1 描述改为「只上行云端下发」 |

## 验证

`scripts/verify-reconcile-filter.mjs`：沙箱 dataRoot + mock cloud，驱动真实 `reconcileOnce()`，核对发往 digest/upsert 的 body。见 `round-1.md`（7/7 PASS）。

## 不做（边界）

- **不建 P2 下行**（intent 派活 / link 写入 / createTask source:'cloud'）——那是并行/后续工作，本改动只做上行侧过滤，前向兼容。
- **不碰云端 upsert/board/迁移**——避免回归已验收的 P0/P1 子系统 + 不碰共享库。云端侧「retire origin='local' 导入 + 清历史 local 行」作为随 P2 协同的补充项，另行处理。
