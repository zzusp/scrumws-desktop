# jsonl 被清理的 CLI 会话无法归档移除

## 症状

jsonl 已被清理的 CLI 会话卡片（标题带「jsonl 已消失」）赖在待人工区清不掉：点「归档」无任何反应，卡片纹丝不动；而「移除」按钮只在归档区才渲染，于是脏卡永远清不掉。

## 根因

`collect-cli.js` 的 jsonl-missing stub 分支把 `state` 写死成 `'awaiting-human'`，完全忽略 `watchlist.archivedAt`——正常路径（同文件 `sidEntry.archivedAt → 'archived'`）是认这个字段的，stub 分支漏了。

于是链路断在展示层，而不是写入层：

1. 点归档 → `POST /api/archive` → `logs.js archiveTask()` 走「未物化 CLI 会话」分支 → `setArchivedWatchlist(sid, true)` → **写入成功，返回 ok**
2. 前端 `refreshState` → `collectOneCli()` 走 stub 分支 → `state` 恒 `'awaiting-human'`
3. `collect.js:211` 按 `cli.state === 'archived'` 分桶 → 卡片回到待人工区，`isArchive` 恒 false
4. `app.js cardActionButtons` 只在 `section === 'archived'` 渲染「✕ 移除」→ 用户够不到 → 死循环

Ground truth（用户本机 `~/.scrumws/runtime/cli-watchlist.json`）：sid `cc226607` 的 jsonl 确已消失，且 `archivedAt=2026-07-16 18:37:13` 已写入——归档动作生效了，只是卡片不认。

## 同根因

同一处还忽略 `doneAt`：stub 卡片点「✓ 完成」同样没反应（`setDoneWatchlist` 写入成功、卡片不动）。一并修，两者是同一个「stub 忽略手动态」缺陷。

`unarchiveTask` / `setDoneWatchlist(false)` 无此问题——清字段后回落 `awaiting-human`，与 stub 的写死值恰好同值。

## 修复

`platform/lib/collect-cli.js`：stub 分支按与正常路径相同的优先级取手动态。

```js
const stubState = sidEntry.archivedAt ? 'archived' : sidEntry.doneAt ? 'done' : 'awaiting-human';
```

jsonl 没了只是推不出**存活态**（进程信号无从谈起），不代表用户点的归档/完成不算数。手动态本就存在 watchlist 里，与 jsonl 在不在无关。

## 验证

`scripts/verify-stub-archive.mjs`——独立临时数据根 + 独立 CC projects 根（`SCRUMWS_DATA_ROOT` / `SCRUMWS_CC_PROJECTS`），造完即删，零污染真实 `~/.scrumws`。

覆盖：stub 出卡 → 归档 → 落归档区 → 移除按钮三个渲染前提（`isArchive` / `t.cli` / `meta.sessionId`）→ 移除后卡片消失；取消归档/完成/取消完成对称生效；jsonl 尚在的正常会话回归不受影响。

- 修复后：`22 passed, 0 failed`
- 修复前（`git checkout --` 还原源码后重跑）：`13 passed, 9 failed`，`★ 归档后 stub 卡片 state=archived` 实测 `got: "awaiting-human"`——症状复现，测试非恒绿

## 存量脏卡

无需数据迁移。`cc226607` 的 `archivedAt` 已在 watchlist 里，修复上线后该卡自动落归档区，点「✕ 移除」即可清掉。
