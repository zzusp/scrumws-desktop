import fs from 'node:fs';
import path from 'node:path';
import { P } from '../paths.js';
import { parse } from '../timeutil.js';
import { taskRev } from './rev.js';
import { readSynced, writeSynced } from './synced.js';
import { cloudRequest } from './http.js';

const UPSERT_BATCH = 50;          // 契约 §6.9：50 条/批（prompt 最长 100000 字符，兜住 body 体积）

// 本地时间串（'yyyy-MM-dd HH:mm:ss'，无时区，本机为 Asia/Shanghai）→ ISO-8601。
// parse() 按「本机本地时间」解释，与写盘时的 fmt() 严格互逆。裸串直接塞 timestamptz 会被云端
// 按服务器时区解释——东八区机器 + UTC 云端就是整整 8 小时的静默偏移，还不报错（契约 §4）。
const toIso = (s) => { const d = parse(s); return d ? d.toISOString() : null; };

/** 把 collectState() 快照的 6 个 lifecycle 桶摊平成卡片数组（顺序无关）。 */
export function flattenCards(snapshot) {
  const lc = snapshot?.lifecycle || {};
  return [
    ...(lc.plan || []), ...(lc.processing || []), ...(lc.queued || []),
    ...(lc.done || []), ...(lc.awaitingHuman || []), ...(lc.archived || []),
  ];
}

// prompt 不在卡片里（原文最长 100000 字符，塞进 /api/state 会撑爆前端轮询）——只在要上行这张卡时
// 单独读一次它自己的 task.json。观察态 CLI 卡片没有任务包目录 → 天然 null。
function readPrompt(card) {
  const root = card.isArchive ? P.archiveRoot : P.runnerRoot;
  try {
    const t = JSON.parse(fs.readFileSync(path.join(root, card.safeTaskKey, 'task.json'), 'utf8'));
    return typeof t?.prompt === 'string' ? t.prompt : null;
  } catch { return null; }
}

/** 单卡 → upsert 载荷（读 task.json 补 prompt；本地时间串转 ISO）。 */
export function buildUpload(card) {
  return {
    taskKey: card.taskKey,
    rev: taskRev(card),
    spec: {
      title: card.title ?? null,
      prompt: readPrompt(card),
      model: card.model ?? card.meta?.model ?? null,   // 与 taskRev 同口径
      effort: card.effort ?? null,
      cwd: card.cwd ?? null,
      worktree: !!card.worktree,
      baseBranch: card.baseBranch ?? null,
      description: card.description ?? null,
      scheduledAt: toIso(card.scheduledAt),
      source: card.source ?? null,                     // 仅元数据（不变式 2：不据此分支）
      createdAt: toIso(card.createdAt),
    },
    status: {
      state: card.state ?? null,                       // 显示态（§5.4），与本地看板一致
      outcome: card.outcome ?? null,
      enteredAt: toIso(card.enteredAt),
      resolvedAt: toIso(card.resolvedAt),
      sessionId: card.meta?.sessionId ?? null,
      rounds: Math.trunc(Number(card.meta?.rounds) || 0),
      numTurns: Math.trunc(Number(card.meta?.numTurns) || 0),
      totalCostUsd: Number(card.meta?.totalCostUsd) || 0,
      usage: card.meta?.usage ?? null,                 // 原样透传（末轮快照，云端不得重新聚合）
      gitBranch: card.cli?.gitBranch ?? null,          // §9 已知缺口：托管任务恒 null，不为它反读 jsonl
      worktreeBranch: card.worktreeBranch ?? null,
      backgroundTaskCount: Math.trunc(Number(card.backgroundTaskCount) || 0),
      isArchive: !!card.isArchive,
      lastActivityAt: card.lastActivityMs ? new Date(card.lastActivityMs).toISOString() : null,
    },
    history: (Array.isArray(card.history) ? card.history : []).map((h, seq) => ({
      seq,
      state: h.state ?? null,
      at: toIso(h.at),
      by: h.by ?? null,                                // 可空：CLI 合成时间线前两条只有 {state, at}
    })),
  };
}

/**
 * 一轮对账。
 * @param {{cloudUrl:string, token:string}} target
 * @param {object} snapshot  getState() 的结果（调用方给，本函数绝不自己触发扫描）
 * @param {{full?:boolean}} [opts]  full=true 则先跑 digest、把 needFull 并入待推集合
 * @returns {Promise<{pushed:number, needFull:string[], markedMissing:number, errors:string[]}>}
 */
export async function reconcileOnce(target, snapshot, opts = {}) {
  const cards = flattenCards(snapshot);
  const cur = new Map();
  for (const c of cards) if (c?.taskKey) cur.set(c.taskKey, taskRev(c));
  const prev = readSynced();
  const errors = [];
  let needFull = [];
  let markedMissing = 0;

  // 待推 = 指纹与账本对不上的
  const pending = new Map();
  for (const c of cards) {
    if (!c?.taskKey) continue;
    if (prev[c.taskKey] !== cur.get(c.taskKey)) pending.set(c.taskKey, c);
  }

  // 全量对账：云端没有 / rev 对不上的补进待推集合；云端有而本地没有的由云端标 local_missing
  if (opts.full) {
    try {
      const r = await cloudRequest(target, 'POST', '/api/machine/tasks/digest', {
        tasks: [...cur].map(([taskKey, rev]) => ({ taskKey, rev })),
      });
      if (r.status === 200 && r.json) {
        needFull = Array.isArray(r.json.needFull) ? r.json.needFull : [];
        markedMissing = Number(r.json.markedMissing) || 0;
        const byKey = new Map(cards.filter((c) => c?.taskKey).map((c) => [c.taskKey, c]));
        for (const k of needFull) { const c = byKey.get(k); if (c) pending.set(k, c); }
      } else {
        errors.push(`digest 失败：HTTP ${r.status}${r.json?.error?.code ? ` ${r.json.error.code}` : ''}`);
      }
    } catch (e) { errors.push(`digest 失败：${e.message}`); }
  }

  // 账本收缩：本地已不存在的 taskKey 别攒着（先只保留 cur 里还在的，再逐批记新账）
  const next = {};
  for (const k of cur.keys()) if (prev[k] !== undefined) next[k] = prev[k];

  let pushed = 0;
  const list = [...pending.values()];
  for (let i = 0; i < list.length; i += UPSERT_BATCH) {
    const batch = list.slice(i, i + UPSERT_BATCH);
    let r;
    try {
      r = await cloudRequest(target, 'POST', '/api/machine/tasks/upsert', { tasks: batch.map(buildUpload) });
    } catch (e) {
      errors.push(`upsert 失败：${e.message}`);   // 网络抖动 → 不记账，下一 tick 自然重试
      break;
    }
    if (r.status !== 200) {
      errors.push(`upsert 失败：HTTP ${r.status}${r.json?.error?.code ? ` ${r.json.error.code}` : ''}`);
      break;
    }
    // 只把真正成功的 taskKey 记进账本：账本是「已确认云端收到」，不是「我打算推」。
    // 云端逐条回 ok；漏回 results 则按整批 200 计。
    const failed = new Set((r.json?.results || []).filter((x) => x && x.ok === false).map((x) => x.taskKey));
    for (const c of batch) {
      if (failed.has(c.taskKey)) { errors.push(`upsert 拒绝：${c.taskKey}`); continue; }
      next[c.taskKey] = cur.get(c.taskKey);
      pushed++;
    }
  }

  writeSynced(next);
  return { pushed, needFull, markedMissing, errors };
}
