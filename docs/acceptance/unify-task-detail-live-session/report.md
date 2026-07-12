# report · 详情页归一（Mode B 折进 #/task/）

**全绿。** matrix 15/15 PASS（Round 1，真 claude 真浏览器 E2E）。

## 交付

看板任务详情归一为单一路由 `#/task/<key>`、单一壳子：任务有活 Mode B 会话 → 详情内连
`/api/session/stream`（逐字 / 权限卡 / 打断 / 实时状态，渲染进 `#modalBody`，状态并入右侧
`renderTaskSide`，composer 常开可插话）；无活会话 → 读磁盘 jsonl 只读历史。独立 `#/session/`
视图退场，旧链接重定向到归属任务。

- 决策落地：D-a 状态并入右侧信息块 · D-b 去结束会话按钮 · D-c 处理中开放插话+打断 · D-d 旧链接重定向。
- 改动：`app.js` / `index.html` / `session-manager.js` / `task-runner.js` / `server.js`（5 文件 +118/-94）。
- 验证：`scripts/browser-e2e-merge.cjs` 15/15 PASS；node --check 全过。

## 遗留（非阻塞）

- CLI adopt → `#/task/` live 真机 E2E 未单测（后端已就位，逻辑同 board）。
- `/model` 切换（S9）仍 TODO，与本次归一无关。
