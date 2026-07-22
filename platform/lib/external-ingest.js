import fs from 'node:fs';
import path from 'node:path';
import { P } from './paths.js';
import { createTask, replyToTask } from './task-actions.js';
import { normalizeProvider } from './providers/registry.js';
import { policyPairsOf } from './api-keys.js';

// 外部任务通道（/api/external/*）的业务件：建任务（幂等去重）+ 查状态 + 原生续接。
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
    taskKey, source: task.source || null, provider: normalizeProvider(task.provider), title: task.title || null,
    state: state.state || null, outcome: state.outcome ?? null,
    createdAt: task.createdAt || null, resolvedAt: state.resolvedAt ?? null,
    externalKey: task.externalKey || null,
    model: task.model ?? null, effort: task.effort ?? null, cwd: task.cwd ?? null,
  };
}

function ledgerKey(key, externalKey) {
  return `${normalizeProvider(key.provider)}:${key.source}:${externalKey}`;
}

// per-key 策略执行：密钥必须带 model + effort 组合和目录白名单。请求省略 model/effort 时取首条组合；
// 只传其中一项且匹配多条组合会被拒，避免暗中选择与调用方预期不同的另一项。
// cwd 判定：等于白名单某项或在其之下（Windows 路径大小写不敏感）。
function resolveAgainstPolicy(key, p) {
  const missing = [];
  const pairs = policyPairsOf(key);
  if (!pairs.length) missing.push('模型 + effort 组合');
  if (!Array.isArray(key.allowedCwds) || !key.allowedCwds.length) missing.push('可访问目录');
  if (missing.length) return { err: `该密钥未配置${missing.join(' / ')}（策略必选=无权限），请在「API 密钥」页重新生成` };
  const modelProvided = p.model != null;
  const effortProvided = p.effort != null;
  const model = String(p.model ?? '').trim();
  const effort = String(p.effort ?? '').trim();
  if (!modelProvided && !effortProvided) {
    const ac = key.allowedCwds;
    let cwd = String(p.cwd || '').trim();
    if (!cwd) cwd = ac[0];
    else {
      const norm = path.resolve(cwd).toLowerCase();
      const hit = ac.some((baseCwd) => {
        const base = path.resolve(baseCwd).toLowerCase();
        return norm === base || norm.startsWith(base + path.sep);
      });
      if (!hit) return { err: `cwd 不在该密钥允许范围：${ac.join('；')}` };
    }
    return { model: pairs[0].model, effort: pairs[0].effort, cwd };
  }
  const candidates = pairs.filter((pair) => (!modelProvided || pair.model === model) && (!effortProvided || pair.effort === effort));
  if (!candidates.length) return { err: 'model + effort 组合不在该密钥允许范围' };
  if (candidates.length > 1) return { err: 'model 或 effort 对应多条允许组合，请同时传 model 和 effort' };
  const ac = key.allowedCwds;
  let cwd = String(p.cwd || '').trim();
  if (!cwd) {
    cwd = ac[0];
  } else {
    const norm = path.resolve(cwd).toLowerCase();
    const hit = ac.some((b) => {
      const base = path.resolve(b).toLowerCase();
      return norm === base || norm.startsWith(base + path.sep);
    });
    if (!hit) return { err: `cwd 不在该密钥允许范围：${ac.join('；')}` };
  }
  return { model: candidates[0].model, effort: candidates[0].effort, cwd };
}

// 建任务（幂等）：externalKey（可选，≤200 字符）在同 source 内幂等——台账命中且任务包仍在（含归档）
// 直接返回原任务（existed:true），任务包已被删则掉台账重建。source/plan/策略字段之外原样透传 createTask 校验。
export function createExternalTask(key, payload) {
  const p = payload || {};
  const provider = normalizeProvider(key.provider);
  if (p.provider != null && normalizeProvider(p.provider) !== provider) {
    return { ok: false, error: 'provider 由 API key 绑定，不能在请求中跨 provider 覆盖' };
  }
  const externalKey = String(p.externalKey || '').trim();
  if (externalKey.length > 200) return { ok: false, error: 'externalKey 超长（≤200 字符）' };
  const pol = resolveAgainstPolicy(key, p);
  if (pol.err) return { ok: false, error: pol.err };
  // 直接执行权限：plan:false（跳过看板确认直进 queued 自动执行）需要密钥显式开启 allowQueued
  if (p.plan === false && !key.allowQueued) {
    return { ok: false, error: '该密钥不允许直接排队执行（plan:false）：任务须经看板确认，或在「API 密钥」页为其开启「允许直接执行」' };
  }

  if (externalKey) {
    const ledger = readLedger();
    // Claude 兼读旧版未带 provider 的台账 key；新写一律 provider-qualified。
    const hit = ledger[ledgerKey(key, externalKey)] || (provider === 'claude' ? ledger[`${key.source}:${externalKey}`] : null);
    if (hit?.taskKey) {
      const brief = readTaskBrief(hit.taskKey);
      if (brief && brief.provider === provider) return { ok: true, existed: true, taskKey: hit.taskKey, state: brief.state };
    }
  }

  const r = createTask({
    source: key.source,
    provider,
    title: p.title, prompt: p.prompt, model: pol.model, description: p.description,
    plan: p.plan === false ? false : true,
    cwd: pol.cwd, effort: pol.effort, scheduledAt: p.scheduledAt,
    worktree: p.worktree, baseBranch: p.baseBranch, dynamicWorkflow: p.dynamicWorkflow,
    externalKey: externalKey || undefined,
  });
  if (!r.ok) return r;

  if (externalKey) {
    const ledger = readLedger();
    ledger[ledgerKey(key, externalKey)] = { taskKey: r.taskKey, createdAt: new Date().toISOString().slice(0, 19).replace('T', ' ') };
    writeLedger(ledger);
  }
  return { ...r, existed: false };
}

// 解析外部调用目标：taskKey / externalKey 二选一（externalKey 经台账解析）。只能操作本 source 的任务——
// 跨 source、不存在、externalKey 未登记一律同一句 404（不泄露其它来源任务的存在性）。
function resolveExternalTask(key, { taskKey, externalKey }) {
  let tk = String(taskKey || '').trim();
  const ek = String(externalKey || '').trim();
  if (!tk && !ek) return { ok: false, code: 400, error: 'taskKey 或 externalKey 必传其一' };
  if (!tk) {
    const ledger = readLedger();
    const provider = normalizeProvider(key.provider);
    tk = (ledger[ledgerKey(key, ek)] || (provider === 'claude' ? ledger[`${key.source}:${ek}`] : null))?.taskKey || '';
    if (!tk) return { ok: false, code: 404, error: 'task not found' };
  }
  if (!/^[A-Za-z0-9:_#/-]+$/.test(tk)) return { ok: false, code: 400, error: 'invalid taskKey' };
  const brief = readTaskBrief(tk);
  if (!brief || brief.source !== key.source || brief.provider !== normalizeProvider(key.provider)) return { ok: false, code: 404, error: 'task not found' };
  return { ok: true, brief };
}

// 查状态：外部字段只返回只读摘要，不泄露任务 prompt 或会话内容。
export function externalTaskStatus(key, target) {
  const r = resolveExternalTask(key, target);
  if (!r.ok) return r;
  const { model, effort, cwd, ...brief } = r.brief;
  return { ok: true, ...brief };
}

// 外部续接：只对已经收敛、且确实有历史会话的任务发送下一条指令。
// plan 任务仍须由看板确认执行，不能借此端点绕过人工确认；processing 由 task-actions 拒绝并发续接。
// 续接时以任务原 model/effort/cwd 为默认值，再按密钥的当前白名单复核，防止密钥收窄后继续执行越权旧任务。
export function resumeExternalTask(key, payload) {
  const p = payload || {};
  const target = resolveExternalTask(key, p);
  if (!target.ok) return target;
  const task = target.brief;
  if (!['awaiting-human', 'done'].includes(task.state)) {
    return { ok: false, code: 400, error: `只有 awaiting-human/done 任务可续接（当前 ${task.state || '未知'}）` };
  }
  const policyInput = { cwd: task.cwd };
  if (p.model != null) policyInput.model = p.model;
  else if (task.model != null) policyInput.model = task.model;
  if (p.effort != null) policyInput.effort = p.effort;
  else if (task.effort != null) policyInput.effort = task.effort;
  const selection = resolveAgainstPolicy(key, policyInput);
  if (selection.err) return { ok: false, code: 400, error: selection.err };
  const r = replyToTask({
    taskKey: task.taskKey,
    message: p.message,
    model: selection.model,
    effort: selection.effort,
  });
  return r.ok ? { ...r, state: 'processing' } : { ...r, code: 400 };
}
