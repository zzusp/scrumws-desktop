# goal · Provider 与运行时体验改造

## 总目标

完成 `docs/spec/provider-runtime-polish.md` 所列桌面端 Provider、运行时页与本机 CLI 会话体验改造，不改云端或手机端。

## Sub Goal Matrix

| # | Sub Goal | 状态 | 验收出口 |
|---|---|---|---|
| S1 | Provider 自绘选择面板与 Codex catalog | DONE | 新建任务不含浏览器原生 Provider select；模型/effort 正确联动 |
| S2 | Runtime enable/config/API | DONE | 启停持久化、禁用拒绝新会话、CLI 状态独立呈现 |
| S3 | Runtime 信息与新建趋势 | DONE | 用量进 provider 卡、无活跃会话块、7 日折线图 |
| S4 | Codex CLI 会话 | DONE | recent/search/add、执行详情与原生续接可用且不破坏 Claude |
| S5 | 通用文案与文档 | DONE | 非专属界面不再错误单指 Claude |
| S6 | 验收与 PR 更新 | DONE | matrix 通过、草稿 PR #70 已创建 |

## 进展

- Round 0：确认上一轮双 Provider 已合入 `master`；核验 Codex rollout 首条 `session_meta.payload` 有 thread id/cwd，
  因而以独立扫描器接入，不复用 Claude JSONL 解析。
- Round 1：隔离运行时态目录实跑 provider catalog、启停、禁用创建 guard、Claude/Codex CLI recent/add/详情与 7 日创建趋势；Windows 安装包构建成功。浏览器策略禁止 localhost 页面访问，UI 改以静态结构断言与打包加载覆盖。
- Round 2：Codex GPT-5.6 快捷项改为 Sol/Terra/Luna 三个精确模型 ID；隔离运行时态实跑 rollout 执行详情解析和 app-server `thread/resume`，未发送测试消息以避免污染原会话。
