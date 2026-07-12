# Round 10 · L3 / S10 Mode A→B 收养（终端会话看板续接）

日期：2026-07-12。用户需求：Mode A/B 应互切——终端起的会话加看板后，**终端退出则在看板可继续对话，效果同看板发起**。

## Linchpin + 机制（D9）

- **`--resume <sessionId>` 续上前会话上下文**（`scratchpad/s10-resume-e2e.mjs`，3/3）：会话1 记"teal"→关闭（模拟终端退出）
  →会话2 `--resume` **记得 Teal**，且续的是**同一 session_id**（追加写同一 jsonl）。
- **收养流程**：`readCcSessionForAdopt(sessionId)` = `locateJsonlBySid`（全局扫 `~/.claude/projects/*/<sid>.jsonl`）
  + `parseCcSession`（推 cwd/model + 历史消息，块已带 `_ts`）→ `createSession({resume, seedTranscript})` 预置历史
  → Mode B 视图 SSE 回放历史 + 实时续接。**cwd 是关键**：`--resume` 靠它定位会话文件、也是 Mode B 工作目录。

## 改动

- `platform/lib/logs.js`：`readCcSessionForAdopt(sessionId)` → `{ok, messages, cwd, model, jsonlPath}`。
- `platform/lib/session-manager.js`：`createSession` 加 `seedTranscript` → 预置 `s.transcript` + `claudeSessionId=resume` + `adopted=true`。
- `platform/server.js`：`POST /api/session/adopt {sessionId, model?}` → readCcSessionForAdopt → 历史转 Mode B 事件 seed → createSession。
- `platform/public/app.js`：CLI 会话（非 processing=终端已退出）详情加「⚡ 在看板继续对话」按钮 → `adoptCliSession` → POST /adopt → `#/session/<id>`；processing 时 handler 拦截（防双进程写同一会话）。

## 验证

**收养引擎**（`scratchpad/s10-adopt-e2e.mjs`）**功能 5/5**（脚本记 4/5）：定位+解析历史（7 msgs）、预置 transcript、
**续接后记得 "Mango"**。唯一"FAIL"是 cwd 断言——macOS `/var`↔`/private/var` 软链接致字符串不等
（`hist.cwd` 是 claude 记录的解析后真路径）；功能正确，mango 续接成功即证明 cwd 对（resume 靠 cwd 定位 jsonl）。

**HTTP + SSE 回放**（`scratchpad/s10-http-e2e.mjs`）**3/3**：`POST /api/session/adopt`（seeded=2）→
**SSE synced + 回放帧含 BANANA42**（=看板能看到历史）→ 继续对话仍带上下文（BANANA42 出现在响应=resume 恢复了上下文，
seed 仅看板侧、claude 上下文只能来自 --resume）。

## 状态

- matrix：**36 PASS + 1 BY-INSPECTION**（S10 前端按钮/route 走查，端点+渲染已真跑）。
- L3 收养方向 DONE。整体 sub-goal：14 DONE / 1 部分（S9 未做）/ S10 detach 方向未做。

## 盲点

- ⚠️ 仅「收养」（A→B）；**「detach」**（Mode B 会话退回 Mode A 只读观察）未做——但续接写同一 jsonl，Mode A 观察它
  天然可行，只差显式动作 + UI。
- ⚠️ 收养 UI 按钮/route 未做真浏览器 E2E（需伪造 CLI watchlist + `~/.claude/sessions` 注册表 fixture，成本高）；
  adopt 端点 + SSE 回放 + 续接已 HTTP 真跑，前端为薄 handler + 复用已验渲染路径。
- ⚠️ 收养时终端仍活（processing）会双进程写同一会话——已在按钮可见性 + handler 双重拦截，但未压测竞态。
- ⚠️ "secret code"类措辞下 claude 回复偏保守（"I don't have..."但仍带出 BANANA42）；上下文确实恢复，属措辞非机制问题。
