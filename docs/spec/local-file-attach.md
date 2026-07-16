# 任务支持添加本地文件

## 需求

1. 新建任务表单支持「添加本地文件」
2. 任务详情页「发送消息」支持「添加本地文件」
3. 详情页底部发送区参考 `docs/tmp/send.png`（claude.ai 风格：输入框 + 底部工具条含「+」加号加文件按钮）改版

## 传输机制决策

参考 `D:\project\claude-code-leak`（CC CLI 泄露源码）的附件机制：CC 对大文件/PDF 用「只给路径，让模型用 Read 工具按需读」策略（`src/utils/messages.ts` `compact_file_reference` / `pdf_reference`），小文本才内联伪装成 Read 结果。

本项目架构：claude 以 `claude -p --input-format stream-json` 本地跑在任务 cwd 下，带完整工具权限（`--dangerously-skip-permissions`），消息经 stdin 的 stream-json `content`（纯字符串）传入。

**结论**：不在 Node 侧读文件/base64/判类型，而是**把文件绝对路径注入消息文本尾部，让 claude 用 Read 工具读**。理由：claude 本地全权限、Read 支持任意类型（含图片），一条清晰路径、无过度设计。网络层传结构化 `attachments: string[]`（绝对路径数组），拼接在后端收敛点做。

拼接格式（前端乐观回显 / 后端 stdin 两处统一，改动需同步）：

```
{原始文本}

[附加本地文件 · 请用 Read 工具读取]
- {绝对路径1}
- {绝对路径2}
```

## 改动点

### 后端

| 文件 | 位置 | 改动 |
|---|---|---|
| `lib/session-manager.js` | 收敛点 | 新增导出 `appendAttachments(text, files)`；`sendUserMessage(id, message, attachments)` 加参并拼接；`createSession({..., attachments})` 透传到 line191 |
| `lib/task-runner.js` | `startTask` | 读 `task.attachments` 传入 createSession（resume/新建两分支） |
| `lib/task-runner.js` | `replyTask` | 加 `attachments` 参：live 分支传 sendUserMessage、resume 分支传 createSession |
| `lib/task-actions.js` | `createTask` | 解构 + 规范化 `attachments`（字符串数组、trim、去重、限量）→ 写 `taskJson.attachments` |
| `lib/task-actions.js` | `editTask` / `readTaskEdit` | 读写/回填 `attachments` |
| `lib/task-actions.js` | `replyToTask` | 解构 `attachments` 透传 replyTask |
| `server.js` | 新端点 | `POST /api/pick-file`：Electron dialog `openFile`+`multiSelections`，返回 `{ok, files}`；web 回退提示 |
| `server.js` | `/api/task/reply` | 透传 `payload.attachments` |
| `server.js` | `/api/session/send` | 透传 `payload.attachments` 给 sendUserMessage |

### 前端

| 文件 | 改动 |
|---|---|
| `public/index.html` | 详情 `.reply-composer` 加附件 chip 区 + toolbar「+」按钮；新建 modal Prompt 后加附件区 + 「+ 添加文件」；对应 CSS |
| `public/app.js` | 详情/新建各维护附件数组，「+」→ `/api/pick-file` → 渲染 chip；sendReply/mbSend/newTaskSubmit body 带 `attachments`；乐观回显本地拼接；openEditTask 回填、close 清空 |

## 验证

- 后端：Node 起 platform server，构造 create/reply 请求，断言 task.json 落 attachments、stdin 拼接文本含路径块。
- 前端：起服务用浏览器/jsdom 验「+」按钮渲染、chip 增删、body 组装。
- 端到端：新建带附件任务 → 确认执行 → claude transcript 出现 Read 该文件。
