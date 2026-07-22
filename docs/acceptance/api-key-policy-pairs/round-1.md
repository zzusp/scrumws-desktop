# round-1（2026-07-22）：组合策略与工作目录选择

## 结果

- `api-tests.mjs` 在独立数据根运行，**46/46 PASS**。新增 P8 证明默认组合与显式允许组合返回 200，未配置的交叉组合返回 400，未在工作目录菜单配置的目录无法创建密钥。
- `verify-provider-data.mjs` PASS：Codex 策略及旧数组格式密钥继续可读、可建外部任务。
- API 密钥 Provider 独立一行并复用新建任务的自绘下拉；组合行复用 `initModelEffortSelector`，每行以独立隐藏 select 保存值。目录复选项改为紧凑可点击多选列表，直执权限改为开关式控件；`node --check` 覆盖 `api-keys.js`、`external-ingest.js`、`server.js`、`app.js`，内联脚本编译和 `git diff --check` 均通过。

## 关键语义

- 新字段 `allowedModelEfforts` 有序保存，首条为请求同时省略 model 和 effort 时的默认组合。
- 只传 model 或 effort 且命中多条组合时明确拒绝，不选择隐含组合。
- 历史只有 `allowedModels` / `allowedEfforts` 的密钥仍按原笛卡尔积授权；新建和编辑密钥均写组合字段。
