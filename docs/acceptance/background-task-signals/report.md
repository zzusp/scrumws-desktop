# 验收报告：后台任务信号统一（全绿）

round-1 全绿，29 项全 PASS（`matrix.csv` 为状态权威，证据见 `round-1.md`）。

## 结论

看板的「后台维度」从**只认后台 subagent** 扩为**认全部三类后台任务**（subagent / 后台命令 / Monitor），
并补上了完成通知的两种落盘载体。用户所报"Monitor 在跑却被挪进 awaiting 桶"已修复，且同时修掉一个
反向误报：对**已完成**的后台 subagent 报"在跑"（真实第三方会话上旧口径报 2、真值 0）。

## 关键取证（可复核）

| 结论 | 证据 |
|---|---|
| 完成通知大头不在 user/string 载体 | 全库终态通知：queue-operation 506 / attachment 298 / user 195 |
| 载体缺口是永久误报的真根因 | 全库未配平 launched：旧口径 421 → 新口径 124（消掉 70%）；真实会话 A/B 旧=2 新=0 真值=0 |
| 结构化字段比回执文案可靠 | 13355 条前台命令全无 `backgroundTaskId`；文案匹配误命中 10 条（全是打印过该串的脚本输出） |
| Monitor 自带硬死线更精确 | 回执 `timeoutMs` 默认 300000 / 最大 3600000；统一 15min 阈值会把 1h Monitor 提前 45min 误剔 |
| TaskStop 不发通知 | leak `TaskStopTool.call()` 只调 `stopTask`，无 enqueue；persistent Monitor 只能靠它结束 |

## 已知局限（不掩盖）

- **fire-and-forget 后台命令会被算作"在跑"**：`npm run dev` 这类常驻进程永不结束、无终态通知，主 agent
  其实在等人 → 卡片误显 processing，最长 15min（`BG_STALE_MS` 封顶）后消失。信号层无法区分"等后台完成"
  与"起了个常驻服务就不管了"；按既定原则"宁可少报不永久误报"封顶。本轮 R4 验证中看板服务自身即触发
  过该现象（故改为脱离会话独立起进程）。
- 同理 `persistent: true` Monitor 若未经 TaskStop 结束，只计 15min。
- 用户 Ctrl+C 杀后台 agent 时 CC 发的是纯文本摘要（非带 tool-use-id 的 task-notification），不配平 → 落
  15min 死线。
- subagent transcript 不落 `toolUseResult`；本项目不读（`locateJsonlBySid` 只找顶层 `<sid>.jsonl`），不受影响。
