# round-2 · 前端统一（真浏览器 E2E · Electron/Chromium 驱动真 index.html+app.js）

脚本：`scripts/browser-e2e-unify.cjs`。沙盒数据根 `~/.unify-e2e-sandbox`，端口 8796，haiku。

## 结果：11/11 PASS

```
无独立交互会话入口(newSessionBtn 已删)          PASS
新建任务入口存在                                 PASS
新建任务 modal 打开                              PASS
提交后路由到实时会话面 #/session/<id>            PASS
view-session 可见                                PASS
逐字 #mbLive 流式增长（seq=[30,56]）             PASS
assistant 文本(mango)已渲染                      PASS
会话头含「任务」面包屑（任务manual:… + cwd）     PASS
会话头含「← 看板」返回                           PASS
composer 续一轮 assistant(mango2) 已渲染          PASS
返回看板可见该任务卡                             PASS
```

## 关键点

- **单入口**：删「新建交互会话」按钮 + modal + create JS；`newTaskBtn` 为唯一创建入口。
- **自动跑 + 路由**：新建任务（uncheck「先计划」）→ 后端 queued 自动起会话 → 前端跳 `#/session/<sessionUiId>`（新建提交读 `r.sessionUiId`）。
- **卡片路由**：`openTaskModal` 按 `mbSessionId` 分流——有 live 会话 → `#/session/<id>` 实时面；无 → `#/task/<key>` 只读详情。
- **续轮走任务通道**：会话面 composer 检测 `mb.info.taskKey` → 发 `/api/task/reply?taskKey`（内部 markProcessing + sendUserMessage），保证每轮 state=processing。
- **会话头**：加「← 看板」返回 + 「任务」面包屑（`session.info.taskKey`）。
- **dws 残留清理**：删前端 authBanner（HTML + renderAuthBanner + 复制/关闭 JS）+ `pauseInvestigation` 消费。

## 首轮两处假阴（已定位为测试问题，非产品 bug）

- 逐字增长 seq=[5]：turn-1 prompt 只回一个词，1 token 太短观察器只抓到 1 步 → 改用「一句话 + mango」长回答，seq=[30,56] PASS。
- 返回看板无卡片：查询在 800ms 内跑，早于异步自动刷新重画 → 改轮询等重画，PASS。

## 盲点

- 工具权限流（`can_use_tool` 挂起 → 详情面点「允许」）本轮用无工具 prompt 未覆盖；机制已在
  `board-interactive-session` Round 6/9 验过，本次仅继承（会话面渲染路径不变）。
- 真·kill server → 重启 → runner-checker 收孤儿的完整链路仍未跑（round-1 已用 close 会话近似 --resume 兜底）。
</content>
