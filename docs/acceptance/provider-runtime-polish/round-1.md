# Round 1

## 结果

`matrix.csv` 全部为 PASS。

## 实跑证据

- 隔离数据根启动 `node platform/standalone.js`，`GET /api/state` 返回 Claude/Codex 两个运行时，Codex 模型为 `gpt-5.6,gpt-5.5,gpt-5.4,gpt-5.4-mini`，effort 为 `none,minimal,low,medium,high,xhigh,max,ultra`。
- `POST /api/providers/codex/enabled` 关闭后，`POST /api/session/create` 返回 HTTP 400 及“Codex 运行时已关闭”；重新开启后 runtime 返回 `enabled: true`。
- `GET /api/state` 返回恰好 7 个 `dailyCreated` 日期，且 runtime 无 `sessions` 字段；加入一条 Codex rollout 后当天趋势计数为 1。
- `GET /api/cli/recent?provider=codex` 返回本机 rollout；添加后返回卡片 `provider: codex`、`cli.readOnly: true`，worker-log 返回 `provider: codex`。`provider=claude` 仍返回成功。
- `node --check` 覆盖改动的服务端与前端 JS；`npm run dist:win` 成功产出 `dist/ScrumWS-0.1.0-win-x64.exe`。

## UI 核验说明

浏览器自动化连接被企业策略拒绝访问 `http://127.0.0.1:8801`，未绕过策略。改以源码结构检查和已成功的 Electron 打包验证：新建任务 Provider 是隐藏值载体加 `button + role=listbox` 的自绘面板；运行时页面包含 `taskCreatedChart` 折线图容器和 provider 启停按钮，不再存在 `rt-sessions` / 活跃会话 UI。
