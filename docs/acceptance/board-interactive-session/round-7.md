# Round 7 · Mode A 渲染真浏览器 E2E 补验 + L2/S6 打断转向

日期：2026-07-12。环境：macOS，claude 2.1.207。用户定"顺手把 3 个 Mode A 渲染项清了，再进 S6"。

## Part 1 · 清 S1/S2/S3 三个 Mode A 渲染 BY-INSPECTION

新增 `scripts/browser-e2e-modea.cjs`：造一个 processing 任务 + in-flight jsonl（assistant = 带 usage 的 text
+ 无 result 的 Bash 工具、`_ts` 设 6s 前），Electron 开 `#/task/` 断言。**6/6 PASS**：

- **S3 token footer**：`↑ 5,112 / ↓ 34 · 缓存 5,000`（上行=input12+cache_read5000+cache_creation100，精确）
- **S2 进行中步骤 live 跳秒**：`· 9s → · 11s`（`.cc-live-timer[data-since]` 真随秒增长）
- **S1 SSE 块级推送**：追加 content block **~400ms** 到达前端（远快于 5s 轮询）
- **S1 回落轮询**：删 `window.EventSource` 后重进详情 → 仍在 ≤6s 内更新（fallback 生效）
- 附：详情页渲染工具 Bash

⇒ 三项 BY-INSPECTION 转 PASS（含 Mode A 首次真浏览器验证）。

## Part 2 · S6 打断/转向（interrupt + 插话）

原语（`interruptSession` + 前端「打断」按钮 + 输入框插话）此前就位、本轮真 claude 验证。

**引擎 E2E** `scratchpad/s6-interrupt-e2e.mjs` **6/6**：
- 长输出 turn（600 字 essay）流出 123 字后 `interruptSession`
- **turn 距打断 ~200ms 结束**（收到 result）
- **输出截断**：123 字 → 最终 143 字（完整 essay 应 >3000 字）→ 确证被打断
- **转向**：interrupt 后 `sendUserMessage` 新指令 → 拿到新响应 `REDIRECTED`

**真浏览器 E2E** `scripts/browser-e2e-interrupt.cjs` **4/4**：
- 会话流式输出中，「打断」按钮 running 时可用
- **点「打断」→ turn 截断**（523 → 4s 后 577 字，vs 完整 >3000）
- **输入框发转向指令 → `REDIRECTED` 出现在会话流**

## 结果

- matrix：**26 PASS + 0 BY-INSPECTION**。
- L2 已完成：S4（地基）/ S5（#1 权限确认）/ S6（#2 打断转向）。
- 固化脚本：`scripts/browser-e2e-{modeb,modea,interrupt}.cjs`（均实跑过、可复跑）。

## 盲点 / 未收敛

- ⚠️ 打断竞态边界（打断与 result 几乎同时、连续快速打断）未压测——常规路径已稳。
- ⚠️ Mode B 每步计时 / 实时 token 计数器（S7）、切模型（S9）、会话迁移（S10）未做。
- ⚠️ 多会话并管、会话持久化（server 重启丢会话）仍未处理。
- ⚠️ 打断/转向的语义细节：当前是「interrupt→等 result→发新消息」清晰路径；「running 中直接插话（不先打断）」未定义行为，未测。
