# Round 8 · L2 / S7 Mode B 每步计时 + 实时 token 计数器

日期：2026-07-12。环境：macOS，claude 2.1.207。

## 实测发现（先证后写，修正早期分析）

三次真 claude 探针（`scratchpad/s7-probe*.mjs`）定死了 stream-json 的形状：

1. **`message_delta` 每轮只在末尾发一次**（含最终 `output_tokens`）——短句 137 tokens、400 字 essay 898 tokens
   均只 1 次。⇒ **逐 token 增长的下行计数器不可得**（修正最初调研 agent"message_delta 增量到达"）。
2. **`assistant` 事件是增量**：同 `message.id` 拆成 thinking / text / tool_use 各一条（非累积）——与 Mode A
   jsonl 同构，需前端按 id 合并。
3. **assistant/user 事件不带 `timestamp`**——每步计时得用「SessionManager 收到时刻」打戳。
4. `message_start.usage` 开跑即含 input+cache（上行真值，即时）。

## 改动

- `platform/lib/session-manager.js`：`handleLine` 给 assistant/user 的 content block 补收到时刻 `_ts`
  （tool_use 与 tool_result 各在自己事件到达时打戳）。
- `platform/public/app.js`：
  - **`mbToRounds` 按 `message.id` 合并**增量 assistant 事件（thinking/text/tool_use 归一，与 parseCcSession 同语义）
    —— 修掉消息被拆开、tool_use 与 usage 对不上；块带 `_ts` → renderCcTool 出每步耗时/进行中跳秒。
  - **实时 token 读数**（`#mbLiveTokens` 会话头）：`message_start` → 上行即时真值；生成中按累计 delta 字符
    （text/thinking/tool 入参）`~` 估算下行、增量刷新；末尾 `message_delta` 校正为真值，并**贴回最近 assistant
    事件的 `message.usage`** 供每轮 footer 显示真值；`result` 清「生成中」。

## 验证 · 真浏览器（`scripts/browser-e2e-modeb-s7.cjs`）7/7 PASS

token 读数序列（MutationObserver 捕获，最能说明问题）：
```
↑ 29,737 / ↓ ~0 → ~31 → ~199 → ~377 （生成中·估算增长）→ ↓ 528（末尾真值·无~）
↑ 30,346 / ↓ ~0 → ~65 → ↓ 73 → 最终 ↑ 30,346 / ↓ 73（无生成中）
```
- **P2 上行即时真值** ↑29,737（message_start）；**下行生成中 ~估算增长 → 末尾真值** 528/73。
- **P1 每步耗时徽章** `· 540ms`（完成工具）+ **进行中工具 live 跳秒**（Mode B 现有 `_ts`）。
- **P2 footer 真值** token（贴回 message_delta usage）。
- 权限卡/允许/执行 顺带复验。

**回归**：`browser-e2e-modeb.cjs`（S5）合并逻辑改后仍 **9/9**。

## 状态

- matrix：**31 PASS**（macOS）。L2：S4/S5/S6/S7 全 DONE（地基 + #1 权限 + #2 打断转向 + #3 逐字/计时/token）。
- 固化脚本 5 个：`verify-modeb.mjs` + `browser-e2e-{modeb,modea,interrupt,modeb-s7}.cjs`（均实跑）。

## 盲点

- ⚠️ 下行「生成中」是 `~` 字符估算（thinking 不可见→偏低，实测 ~377 vs 真值 528）；这是数据源约束（无增量
  message_delta），已明确标 `~`，末尾给真值。可接受。
- ⚠️ 未做：S9 会话内切模型 / S10 会话迁移 / 多会话并管 / 会话持久化。
- ⚠️ E2E 未显式结束会话会残留 claude 子进程（已手动清）；产品侧 `closeSession` 正常收敛，属测试脚本卫生问题。
