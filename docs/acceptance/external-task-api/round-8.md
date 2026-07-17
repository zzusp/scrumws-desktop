# round-8（2026-07-18）：任务新增鉴权收口（同源门 + CLI 走密钥）· 全绿

用户质疑：「任务新增为什么不鉴权？！」——无鉴权的 `/api/task/create` 是绕过密钥/策略体系的洞，且 task-ingest.md 还在把它当外部对接方式宣传。经确认采用**同源收口**方案。

## 语义

- **`POST /api/task/create` 仅限看板页面**：服务端校验 `Origin` 标头 === 本服务地址（浏览器同源 fetch POST 必带）；程序化/外部调用（无/异源 Origin）一律 `403` 并指路外部通道。看板 UI 零改动零感知。定位说明：这不是防御本机恶意进程（开放 localhost 做不到），而是关死"无鉴权对接"路径——**一切程序化任务新增必须过密钥鉴权 + per-key 策略管道**。
- **CLI 重写为外部通道瘦客户端**：`--key`/`SCRUMWS_API_KEY` 必填；走 `/api/external/task/create`；`--source`/`--plan` 移除（source 由密钥决定、缺省即 plan），新增 `--effort`/`--external-key`/`--queued`（直执需密钥开权限）；401/缺钥有明确指引。
- **文档统一**：task-ingest.md 全文重写（顶部醒目声明"一切程序化任务新增必须鉴权"、CLI 新选项表、403/401 排错项）；external-api-guide.md 前提区加同一声明 + CLI 瘦客户端提示。

## 证据（r12 隔离实例）

- **API 44/44 PASS**：新增 O1（无 Origin 程序化调用 → 403，错误指路外部通道）、O2（模拟看板同源 Origin → 200 建 plan 任务）、CLI1（子进程实跑 `cli.js create --key … --port 18799` → exit 0「已入计划」+ 真建任务）、CLI2（无密钥 → exit 1「缺 API 密钥」指引）；全量回归含 whoami/策略/幂等。
- **UI 9/9 PASS**：新增 U8 看板「新建任务」回归——真实浏览器打开看板、走弹窗提交，经同源闸成功、plan 桶出卡（证明收口对看板零影响）。
