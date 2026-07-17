import crypto from 'node:crypto';

// 卡片内容指纹（契约 §5.2 v1，逐字实现）。**本地是唯一实现**：云端把 rev 当不透明字符串原样存、
// digest 时只做字符串相等比较，绝不重算（§5.5）。所以这里的稳定性只对「同一台机器的两次扫描」负责。
const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');
export const REV_ALGO = 'v1';

// 数值规范化：JS 浮点直接 String() 会因累加误差在两次扫描间抖动（0.1+0.2 类），
// 固定 6 位小数（USD 成本到微元足够）→ 同一份数据永远得同一个串。
const money = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0).toFixed(6);
const int   = (v) => Math.trunc(Number(v) || 0);

/**
 * 计算一张卡的内容指纹。
 * @param {object} card - collectState() lifecycle 各桶里的卡片对象（原样传入，不要预处理）
 * @returns {string} 40 位小写 hex
 */
export function taskRev(card) {
  const payload = [
    REV_ALGO,
    // —— status 面 ——
    card.state ?? null,                      // 是 displayState（§5.4：后台子任务在跑的 awaiting-human 显示成 processing）
    card.outcome ?? null,
    card.enteredAt ?? null,
    card.resolvedAt ?? null,
    Array.isArray(card.history) ? card.history.length : 0,
    card.meta?.sessionId ?? null,
    int(card.meta?.rounds),
    int(card.meta?.numTurns),
    money(card.meta?.totalCostUsd),
    card.lastActivityMs ?? null,
    int(card.backgroundTaskCount),
    card.isArchive ? 1 : 0,                  // 归档只挪目录、不动 state/history → 不进指纹就永久漏
    card.cli?.gitBranch ?? null,             // 上行了就得进指纹
    card.worktreeBranch ?? null,
    // —— spec 面（rename / describe / edit 不写 history、不动任何时间戳 → 必须进指纹）——
    card.title ?? null,
    card.description ?? null,
    card.cwd ?? null,
    card.model ?? card.meta?.model ?? null,  // collectOne 补的 model；CLI 观察态卡片走 meta.model
    card.effort ?? null,
    card.worktree ? 1 : 0,
    card.baseBranch ?? null,
    card.scheduledAt ?? null,
    card.source ?? null,
    card.promptSha ?? null,                  // prompt 原文最长 100000 字符，不进卡片，只进指纹
  ];
  // 用 JSON.stringify(数组) 而非 '|' 拼接：title/description 里可能有 '|'，拼接会产生歧义
  // （'a|b'+'c' 与 'a'+'b|c' 同串）；JSON 转义是单射的，且 null 与 '' 天然可区分。
  // 同款先例：server.js:65 的 wlFingerprint。
  return sha1(JSON.stringify(payload));
}
