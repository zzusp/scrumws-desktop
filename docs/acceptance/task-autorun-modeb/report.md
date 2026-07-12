# report · 交互会话统一为任务 + queued 自动→processing（全绿）

## 结论

两条用户诉求全部达成、真 claude on Mac 端到端验证通过：

1. **交互会话 = 新建任务，一套处理逻辑**：删掉独立「新建交互会话」入口；「新建任务」是唯一创建入口；
   任务的执行 = **Mode B 交互引擎**（`session-manager` 直起 `claude` stream-json，跨平台）。
2. **queued 自动 → processing**（根因已修）：根因 = commit `965b46e` 去派发器后把「怎么跑起来」推给了手动
   Windows `.ps1`，Mac 无执行器 → 卡 queued。修法 = 任务进 queued 即自动起绑定该任务的 Mode B 会话（→processing）。
3. **删 chat/issue 分身(dws)/飞书/GitHub + `.ps1` 残留**（用户「早该删」）。
4. 一轮 `result` 收敛 → **awaiting-human**（可从详情多轮续接）。

## 证据

- 后端 round-1：真 claude E2E **10 case PASS**（建→processing→awaiting-human、reply 复用、--resume 兜底、
  plan gate、approve、cancel、meta/lease 落盘、server 无 authBlock）。
- 前端 round-2：真浏览器（Electron/Chromium）E2E **11 case PASS**（单入口、自动跑路由实时面、逐字流式、
  会话头面包屑+返回、composer 续轮、返回看板见卡）。
- `node --check` 11 文件全过；CLI 路径 `node platform/cli.js create` → `✓ 已起会话执行（state=processing）`→awaiting-human。
- 状态总表见 `matrix.csv`（case × round 全 PASS）。

## 改动清单

**新增** `platform/lib/task-runner.js`（桥接层：会话事件 → 任务 state.json/lease/meta；start/reply/cancel + registry）。

**改**
- `platform/lib/task-actions.js`：createTask（queued 自动 startTask + effort）；restart/approve/reply/cancel 走 Mode B；删全部 `.ps1`/pwsh/taskkill + chat/issue→worker 映射。
- `platform/lib/session-manager.js`：Session 携 `taskKey`（info 暴露）。
- `platform/lib/collect.js`：card 暴露 `mbSessionId`；删 authBlock + chat/issue 逆推 + chat humanCc；runnerConfig 去 pauseInvestigation。
- `platform/lib/logs.js`：`readWorkerLog` 全局按 sid 定位 jsonl（交互任务自定义 cwd 也能渲历史）。
- `platform/lib/jobs/{ctx,runner-checker}.js`：删 dws 授权复查 + quota-block；checker 只留孤儿收纳（含 Mode B 重启孤儿）。
- `platform/lib/paths.js`：删 quotaBlk/authBlk。
- `platform/public/{index.html,app.js}`：删「新建交互会话」按钮+modal+JS + authBanner；`openTaskModal` 按 mbSessionId 分流；
  新建任务跳实时会话面；composer 走 `/api/task/reply`；会话头加任务面包屑+返回。
- 文档：`docs/api/task-ingest.md` + `platform/cli.js` + `README.md` 同步「queued 自动执行」。

## 未覆盖（继承既有验证，非本次回归）

- 工具权限流（`can_use_tool` 挂起→详情面点「允许」）：机制在 `board-interactive-session` Round 6/9 验过，会话面渲染路径不变。
- 真·kill server→重启→runner-checker 收孤儿全链路：round-1 用 close 会话近似验了下游 --resume 兜底。
- `docs/spec/task-ingest-cli-api.md` 是去派发器时的开工前快照（spec/ 不回头维护），其「入队不执行」表述已被本特性 plan.md 取代。
</content>
