# Round 1 — 全绿

真实 Chrome 驱动 `http://127.0.0.1:8790/#/board`（合成数据 4 任务），`scripts/verify-ui.mjs` 输出：

```
PASS  渲染 4 张卡（实际 4）
PASS  plan 卡片存在
PASS  卡片显示工作目录（D:\project\scrumws-desktop）
PASS  卡片显示最后活动时间（最后活动 8min 前）
PASS  req2：卡片上半部分已去掉状态/耗时/心跳/描述等其余信息
PASS  req2：底部标签 + 操作按钮保留
PASS  req5：manual 来源标签显示 Manual（实际 Manual）
PASS  req6：plan 提示「待定」（实际 待定）
PASS  req6：processing 提示「处理中」（实际 处理中）
PASS  req1：工具行有「筛选」按钮
PASS  req1：点击打开筛选面板
PASS  req1：来源选项取自真实数据（全部/dws/issue/Manual）
PASS  req1：按 Manual 筛选后只剩 manual 卡（2 张）
PASS  req1：计数随筛选更新（plan=1 done=1 proc=0）
PASS  req1：筛选徽章显示激活数（1）
PASS  req3：工作目录选项取自真实数据（3 项含全部）
PASS  req3：按工作目录筛选（2 张，标题 dws 链任务·导出报表,手动任务·文档补全）
PASS  req4：关键字「登录」→ 1 张（手动任务·登录页重构）
PASS  req4：sessionId「bbbb1111」→ 命中 issue 卡（issue 修复·崩溃回归）
PASS  清除筛选：恢复 4 张卡 + 徽章隐藏（4 张）
PASS  无 JS 运行时错误

ALL PASS
```

后端 `/api/state`（`lastActivityAgo` 与 lease-死回退 meta.lastRoundAt 均正确）：

```
[plan]      src=manual | 手动任务·登录页重构 | cwd=D:\project\scrumws-desktop      | lastActivityAgo=4min 前 | sid=-
[processing]src=chat   | dws 链任务·导出报表   | cwd=…\another-repo\packages\ui       | lastActivityAgo=3min 前 | sid=aaaa…
[awaiting]  src=issue  | issue 修复·崩溃回归   | cwd=D:\project\scrumws-desktop      | lastActivityAgo=1.5h 前 | sid=bbbb…
[done]      src=manual | 手动任务·文档补全     | cwd=…\another-repo\packages\ui       | lastActivityAgo=4h 前   | sid=cccc…
```

截图：`round-1/board-cards.png`（卡片视图）、`round-1/filter-panel.png`（展开的筛选面板）。

## 备注
- 截图中 chat 任务落在 awaiting 列而非 processing：合成 lease 的 pid 是已退出的 seed 进程，平台
  runner-checker 把「死 lease 的 processing」正常回收为 awaiting-human——是既有产品行为、与本次改动无关，
  且不影响任一需求断言（卡片渲染跨桶一致）。
