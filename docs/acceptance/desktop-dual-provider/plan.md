# 桌面端双 Provider 验收计划

## 需求

桌面端同时支持 Claude Code 与 Codex；云端和手机端不改。

## 方案

按 `docs/spec/desktop-dual-provider.md` 引入 provider registry、Claude/Codex adapter、统一事件契约、
任务 provider 字段、canonical transcript journal 与 provider-driven UI。

## 改动面

- `platform/lib/providers/`：registry 与两个 adapter。
- `platform/lib/session-manager.js`：只保留 provider-neutral session orchestration。
- `platform/lib/task-{actions,runner}.js`、`api-keys.js`、`external-ingest.js`：provider 数据与校验。
- `platform/lib/collect.js`、`logs.js`、`server.js`：runtime、详情和 API。
- `platform/public/{index.html,app.js}`：provider 选择、详情、回复、运行时。
- `README.md`、`docs/api/`：行为和本地 external API 契约。

## 验证

状态以 `matrix.csv` 为准；每轮证据只追加到新的 `round-N.md`，fix-rerun 不覆盖旧轮。
