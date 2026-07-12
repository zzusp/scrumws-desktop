# Round 3 · L1 / S3 每轮上/下行 token 展示

日期：2026-07-12。环境：macOS。纯前端渲染补齐（数据 usage 早已在 `logs.js` 解析）。

## 需求

每轮末尾（"Worked for X" 那行）补上该轮**上行 / 下行 token**，让处理中/历史轮都能看到 token 走向。

## 改动

- `platform/public/app.js`
  - 新增 `roundTokenStats(round)`：从已解析的 `message.usage` 聚合——
    - **上行** = 最后一条 assistant 的 `input+cache_read+cache_creation`（本轮上下文峰值，快照口径）
    - **下行** = 本轮所有 assistant `output_tokens` 之和（累计生成）
    - **缓存** = 最后一条的 `cache_read_input_tokens`（上下文里命中缓存的部分，与上行同为快照）
    - messages 无 usage（老数据/归档）→ 退回 `ccSummary.tokens` / `metaUsage`
  - `renderDetailTab`：每轮 footer 由"仅时长"扩为"时长 + `↑ 上行 / ↓ 下行 · 缓存 X`"，
    带 title 悬浮说明口径；无时长有 token 也渲染。

**口径修正**（开发中踩的）：初版把"缓存"做成跨消息 Σcache_read，真实会话下 =13,180,039，
远大于上行 256,841 —— 快照与累计两个轴混一起会误导。改为**缓存取最后一条快照**，与上行同轴，
"上下文 257K、其中缓存命中 256K（≈99%）"才自洽。

## 验证

**单元测试（抽取 app.js 里真实 `roundTokenStats` eval 后断言，非复制版）**：`scratchpad/s3-token-test.mjs`，**5/5 PASS**。
- 多消息聚合 `{up:1050, down:25, cacheRead:950}`（下行 5+8+12、上行末条 100+950+0、缓存末条 950）
- 退回 ccSummary / 退回 metaUsage / 无数据返回 null / 缺字段容错。

**真实数据 sanity**（本会话 jsonl，按 message.id 合并后）：上行 256,841（input2+cache_read256,376+cache_creation463）、
下行 154,985（87 条 Σoutput）、缓存 256,376 —— 数量级合理、字段名与真实 usage 结构吻合。

## 盲点

- ⚠️ 渲染 HTML 串为**按代码走查 + `node --check` 通过**，未在真 Electron 里目测；随 S1 一起手动冒烟即可覆盖。
