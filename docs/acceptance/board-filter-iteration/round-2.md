# Round 2 — 来源/工作目录改自定义下拉 · 全绿

真实 Chrome 驱动 `http://127.0.0.1:8790/#/board`（合成数据 4 任务），`scripts/verify-ui.mjs` 输出 **24/24 PASS**：

```
PASS  渲染 4 张卡（实际 4）
PASS  plan 卡片存在
PASS  卡片显示工作目录（D:\project\scrumws-desktop）
PASS  卡片显示最后活动时间（最后活动 3min 前）
PASS  req2：卡片上半部分已去掉状态/耗时/心跳/描述等其余信息
PASS  req2：底部标签 + 操作按钮保留
PASS  req5：manual 来源标签显示 Manual（实际 Manual）
PASS  req6：plan 提示「待定」（实际 待定）
PASS  req6：processing 提示「处理中」（实际 处理中）
PASS  req1：工具行有「筛选」按钮
PASS  req1：点击打开筛选面板
PASS  来源/工作目录改为自定义下拉（无原生 select，选项面板同款 .fp-dd-menu）
PASS  req1：点击来源下拉展开选项面板
PASS  req1：来源选项取自真实数据（全部/dws/issue/Manual）
PASS  req1：按 Manual 筛选后只剩 manual 卡（2 张）
PASS  req1：来源下拉触发按钮显示当前选择（Manual）
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

关键新断言：`#boardFilterPanel` 内**无原生 `<select>`**，来源/工作目录均为 `.fp-dd-btn` 触发 + `.fp-dd-menu`
选项面板；来源下拉点击展开、选项 `全部/dws/issue/Manual` 取自真实数据、选中后触发按钮标签更新为 `Manual`；
工作目录下拉选项取自真实 cwd（含「全部」共 3 项）。

## 截图
- `round-1/filter-source-dropdown.png` —— 来源自定义下拉展开（选项面板同 `.cwd-menu` 范式，选中项带 ✓）。
- `round-1/filter-cwd-dropdown.png` —— 工作目录自定义下拉展开（mono 路径、截断省略）。
- `round-1/filter-panel.png` —— 收起态筛选面板（来源 / 工作目录均为下拉按钮）。
