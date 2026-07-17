import fs from 'node:fs';
import path from 'node:path';
import { P } from './paths.js';
import { createTask } from './task-actions.js';

// 外部任务通道（/api/external/*）的业务件：建任务（幂等去重）+ 查状态。
// 与 /api/task/create 的差异只有三点：source 强制取 API key 绑定值（不信请求体）、缺省落 plan 桶
// （外部推入的活先人工确认）、externalKey 幂等（同一外部事件重复推不重复建任务）。
// 建出的任务与其它来源走完全一致的状态机（source 只是元数据，不特判）。
const LEDGER_FILE = path.join(P.tmpDir, 'external-ingest.json');

function readLedger() {
  if (!fs.existsSync(LEDGER_FILE)) return {};
  try {
    const obj = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch { return {}; }
}

function writeLedger(ledger) {
  fs.mkdirSync(P.tmpDir, { recursive: true });
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2), 'utf8');
}

// taskKey → 任务包目录（对齐 safeKey 约定：':'→'__'、'#'→'_'）；不在 runner-state 就找 runner-archive
function findTaskDir(taskKey) {
  const safeKey = String(taskKey).replace(/:/g, '__').replace(/#/g, '_');
  for (const root of [P.runnerRoot, P.archiveRoot]) {
    const dir = path.join(root, safeKey);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function readTaskBrief(taskKey) {
  const dir = findTaskDir(taskKey);
  if (!dir) return null;
  let task = {}; let state = {};
  try { task = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8')); } catch { }
  try { state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { }
  return {
    taskKey, source: task.source || null, title: task.title || null,
    state: state.state || null, outcome: state.outcome ?? null,
    createdAt: task.createdAt || null, resolvedAt: state.resolvedAt ?? null,
    externalKey: task.externalKey || null,
  };
}

// 建任务（幂等）：externalKey（可选，≤200 字符）在同 source 内幂等——台账命中且任务包仍在（含归档）
// 直接返回原任务（existed:true），任务包已被删则掉台账重建。source/plan 之外的字段原样透传 createTask 校验。
export function createExternalTask(key, payload) {
  const p = payload || {};
  const externalKey = String(p.externalKey || '').trim();
  if (externalKey.length > 200) return { ok: false, error: 'externalKey 超长（≤200 字符）' };

  if (externalKey) {
    const ledger = readLedger();
    const hit = ledger[`${key.source}:${externalKey}`];
    if (hit?.taskKey) {
      const brief = readTaskBrief(hit.taskKey);
      if (brief) return { ok: true, existed: true, taskKey: hit.taskKey, state: brief.state };
    }
  }

  const r = createTask({
    source: key.source,
    title: p.title, prompt: p.prompt, model: p.model, description: p.description,
    plan: p.plan === false ? false : true,
    cwd: p.cwd, effort: p.effort, scheduledAt: p.scheduledAt,
    worktree: p.worktree, baseBranch: p.baseBranch, dynamicWorkflow: p.dynamicWorkflow,
    externalKey: externalKey || undefined,
  });
  if (!r.ok) return r;

  if (externalKey) {
    const ledger = readLedger();
    ledger[`${key.source}:${externalKey}`] = { taskKey: r.taskKey, createdAt: new Date().toISOString().slice(0, 19).replace('T', ' ') };
    writeLedger(ledger);
  }
  return { ...r, existed: false };
}

// 查状态：taskKey / externalKey 二选一（externalKey 经台账解析）。只能查本 source 的任务——
// 跨 source、不存在、externalKey 未登记一律同一句 404（不泄露其它来源任务的存在性）。
export function externalTaskStatus(key, { taskKey, externalKey }) {
  let tk = String(taskKey || '').trim();
  const ek = String(externalKey || '').trim();
  if (!tk && !ek) return { ok: false, code: 400, error: 'taskKey 或 externalKey 必传其一' };
  if (!tk) {
    tk = readLedger()[`${key.source}:${ek}`]?.taskKey || '';
    if (!tk) return { ok: false, code: 404, error: 'task not found' };
  }
  if (!/^[A-Za-z0-9:_#/-]+$/.test(tk)) return { ok: false, code: 400, error: 'invalid taskKey' };
  const brief = readTaskBrief(tk);
  if (!brief || brief.source !== key.source) return { ok: false, code: 404, error: 'task not found' };
  return { ok: true, ...brief };
}
