# Round 3 — 工作目录筛选纳入 worktree 实际运行目录 · 全绿

合成数据把 `manual:delta`（done）设为 worktree 任务：配置 `cwd=D:\work\another-repo\packages\ui`，
`meta.worktreeDir=D:\work\another-repo\packages\ui\.claude\worktrees\wt-delta`。

后端 `/api/state` 确认暴露 `worktreeDir`：
```
manual | 手动任务·文档补全 | cwd=D:\work\another-repo\packages\ui | worktreeDir=…\.claude\worktrees\wt-delta
```

真实 Chrome `scripts/verify-ui.mjs` **28/28 PASS**：

```
PASS  渲染 4 张卡（实际 4）
PASS  plan 卡片存在
PASS  卡片显示工作目录（D:\project\scrumws-desktop）
PASS  卡片显示最后活动时间（最后活动 3min 前）
PASS  req2：卡片上半部分已去掉状态/耗时/心跳/描述等其余信息
PASS  req2：底部标签 + 操作按钮保留
PASS  worktree 卡片同显两目录（D:\work\another-repo\packages\ui | …\.claude\worktrees\wt-delta）
PASS  worktree 卡片两目录带标签区分（工作目录/worktree）
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
PASS  req3：工作目录选项含配置目录 + worktree 目录（4 项含全部）
PASS  worktree 目录选项带「worktree」标签（worktree）
PASS  req3：按配置工作目录筛选（2 张，标题 dws 链任务·导出报表,手动任务·文档补全）
PASS  worktree 目录可作为筛选项命中任务（手动任务·文档补全）
PASS  req4：关键字「登录」→ 1 张（手动任务·登录页重构）
PASS  req4：sessionId「bbbb1111」→ 命中 issue 卡（issue 修复·崩溃回归）
PASS  清除筛选：恢复 4 张卡 + 徽章隐藏（4 张）
PASS  无 JS 运行时错误

ALL PASS
```

核心新增：`dirsOf(t)=[cwd, worktreeDir]`，工作目录筛选按 worktree 目录也能命中该任务；下拉里 worktree 目录带
「worktree」标签、配置目录不带标签；卡片对 worktree 任务同显两目录并各带标签。

## 截图
- `round-1/board-cards.png` —— done 卡「手动任务·文档补全」显示 `工作目录` + `worktree` 两行（各带小徽章）。
- `round-1/filter-cwd-dropdown.png` —— 工作目录下拉 4 项：全部 / 两个配置目录 / 1 个带「worktree」标签的 worktree 目录。
