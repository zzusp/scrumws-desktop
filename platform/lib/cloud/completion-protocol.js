// 决策 15 / 契约 §8.3：给云端任务的 prompt 尾部追加「完成协议」。
//
// ⚠ 这不是按 source 特判（README:43-47 的不变式）：connector 是这个任务的**创建者**，创建者 compose
// 自己的 prompt 是既有做法（session-manager.js:34 appendAttachments 就往消息尾追加附件清单）。
// 任务一旦建出来，它在状态机里与 manual / cli 任务逐字节同权。本地手敲的任务不带这段 → 不会自我声明
// 完成 → P1 既有行为零回归。
//
// agent 不需要知道 taskKey 的字面值——它只需要知道去哪儿取：session-manager 在 spawn 时注入
// SCRUMWS_TASK_KEY / SCRUMWS_API_BASE（契约 §8.1）。
// 端点是本机 127.0.0.1 的看板端点（server.js 绑 127.0.0.1、无鉴权），agent 带
// --dangerously-skip-permissions 就在这台机器上跑，**现在就能**调它——我们不是给它新权限，
// 只是告诉它该这么用。**绝不给 agent 任何云端凭据**（决策 15）。

/**
 * @param {string} prompt 云端下发的原始 prompt（人写的原文）
 * @returns {string} 尾部追加完成协议后的 prompt
 */
export function appendCompletionProtocol(prompt) {
  return `${String(prompt || '')}

---
[任务完成协议 · 由看板注入]
你在一台开发机上以非交互模式执行本任务，AskUserQuestion 工具已被禁用 —— 需要澄清时**不要猜**：
把问题写在本轮最后的回复里并停下，人会在看板上看到。
做完了要**显式声明**，否则任务只会停在「待人工」等人来判：
  PowerShell:  Invoke-RestMethod -Method Post "$env:SCRUMWS_API_BASE/api/task/complete?taskKey=$env:SCRUMWS_TASK_KEY&resolvedBy=agent"
  bash:        curl -s -X POST "$SCRUMWS_API_BASE/api/task/complete?taskKey=$SCRUMWS_TASK_KEY&resolvedBy=agent"
（两个变量已在你的环境变量里；这是本机 127.0.0.1 的看板端点，不出网。）
判据：确信目标已达成且自查通过才调；没做完别调 —— 漏调只是等人（fail-safe），误调会让人以为做完了。`;
}
