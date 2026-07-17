# round-2（2026-07-17）：per-key 策略 + 心跳 + 派发桶/模型调整 · 全绿

本轮响应用户三点增量需求：① 密钥可配「可用模型 + effort + 可访问目录」白名单；② 来源活跃观测（结论：不用长连接，用心跳——发起端是 fork-per-tick 短命进程无宿主持连，心跳新鲜度判活更准）；③ chat 派发直进 queued 自动执行、issue 保持 plan 确认，两者默认 opus-4.8 + xhigh + cwd=D:\baibu-agent。

## 改动

- `platform/lib/api-keys.js`：createApiKey 增 `allowedModels/allowedEfforts/allowedCwds`（校验：模型/effort 须全局白名单子集、目录须绝对路径；空=不限）；publicView 外带三字段。白名单常量从 task-actions.js export 复用。
- `platform/lib/external-ingest.js`：`resolveAgainstPolicy` —— 请求省略字段取白名单首项为默认；越界 400「不在该密钥允许范围」；cwd 判等于白名单项或其子目录（Windows 大小写不敏感）。
- `platform/server.js`：`POST /api/external/heartbeat`（鉴权即刷 lastUsedAt，无副作用）。
- UI：表单加模型/effort 勾选组 + 目录 textarea；列表「限制」列（tooltip 全量）+「最近活跃」绿点（lastUsedAt < 5min）。
- baibu 派发器：每 tick `heartbeatScrumws`（失败静默=离线）；chat payload `plan:false + model/effort`，issue payload `model/effort`（plan 缺省）。

## 证据

**API 套件（r5 隔离实例）32/32 PASS**：原 24 用例全部复测 + 新增 F1（心跳 200/无鉴权 401）、P1（建带策略钥，字段外显）、P2（非白名单模型拒绝）、P3（相对路径拒绝）、P4（省略字段取白名单首项：model=claude-opus-4-8 effort=xhigh cwd=白名单[0]，磁盘断言）、P5（白名单内值 + 子目录 cwd 放行）、P6（越界 model/effort/cwd 三连 400）、P7（无策略旧钥不受限）。

**UI 冒烟 5/5 PASS** + 截图人工复核：策略表单、「限制」列（不限 / 模型 opus-4.8 · effort xhigh · 目录 1 个）、活跃绿点渲染正确。

**派发器 e2e（r5，带策略测试钥）**：
- chat：`self → chat:20260717222801-804（processing）`，落盘 `model=claude-opus-4-8 effort=xhigh cwd=D:\baibu-agent externalKey=chat-self-20260710070038`，history `queued@create:chat → processing@session → awaiting-human@session`——**直进 queued 自动执行**（未触 plan）。r5 的 PATH 无 claude，spawn 子进程秒死、无真实副作用（已核当时无新 claude 进程）。二跑幂等命中不重复建；水位复原 == 原值。
- issue：3 个该派 issue 全部 `state=plan` + `model=claude-opus-4-8 effort=xhigh cwd=D:\baibu-agent`；seed/指纹/团队评论 skip 判据复测一致。测试派发记录（dispatched/84,87,90.json）已删，seed 保留。

**生产态**：两把生产钥已补策略（`swak_xH1jnAo…`/chat、`swak_72BBUnK…`/issue → models=[claude-opus-4-8] efforts=[xhigh] cwds=[D:\baibu-agent]）；baibu 真实配置已复原指向 8799。

## 本轮事故与修复（如实记录）

- **r4 实例误挂真实数据根**：bash 子 shell 内 `$(cygpath …)` 在 PATH 被裁后执行失败 → `SCRUMWS_DATA_ROOT` 空 → 服务器落到 `~/.scrumws`，两把测试钥误铸进真实 api-keys.json。当场按 PID 杀服务器、按前缀删两把测试钥（读回核实只剩 2 把生产钥）。后续轮次改为先算路径再裁 PATH（r5 已用 ground truth 验证隔离正确）。
- **bash 转义毁路径**：多层转义把 `D:\baibu-agent` 变成 `D:<退格>aibu-agent` 被服务端正确拒绝（校验无误）；测试脚本改落文件执行避开转义，路径用正斜杠。
