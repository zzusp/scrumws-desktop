import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { P, ROOT } from './paths.js';
import { fmt } from './timeutil.js';
import { readConfig } from './runner-config.js';

// 派发器平台 v2（2026-07-10 派发链 Node 化，见 docs/spec/dashboard-dispatcher-platform.md v2 / claude-runner.md §19）：
// · 注册表 runtime/dispatchers.json = 单一事实源：{id, type, label, intervalSec, enabled, createdAt}
// · 派发器 = Node 脚本 runtime/dispatchers/<id>.mjs（export default async function tick(ctx)），
//   看板表单直接编辑；新建时按场景模板（dashboard/templates/<type>.mjs）预填
// · 调度 = 看板进程内 scheduler.js（不再是 Windows 计划任务）；Runner Checker 是平台内置 job 不进注册表

const REGISTRY_FILE = path.join(P.tmpDir, 'dispatchers.json');
const SCRIPTS_DIR = path.join(P.tmpDir, 'dispatchers');
// 模板是应用代码资产，跟随本模块解析（ROOT 现在是数据根，不再指向代码目录）
const TEMPLATES_DIR = path.join(import.meta.dirname, '..', 'templates');

// 场景模板：type → 脚本内容（模板文件）/ 默认节拍 / 心跳日志 / 说明。新增场景来源 = 加一条 + 放模板文件。
// singleton：派发脚本状态盘全局单例（dispatch-chat/ dispatch-issue/），同 type 双实例会互踩。
export const DISPATCHER_TYPES = {
  'chat-watch': {
    label: '盯群派发器',
    template: path.join(TEMPLATES_DIR, 'chat-watch.mjs'),
    defaultIntervalSec: 15,
    logFile: P.dispatchChatLog,
    hint: 'dws chat quick check（3+N 会话）→ 新指令触发 spawn watch-worker',
    singleton: true,
  },
  'issue-watch': {
    label: 'Issue 派发器',
    template: path.join(TEMPLATES_DIR, 'issue-watch.mjs'),
    defaultIntervalSec: 180,
    logFile: P.dispatchIssueLog,
    hint: 'gh list HiQ-AI/feedback（line:editor + type:bug）→ spawn issue-worker',
    url: 'https://github.com/HiQ-AI/feedback/issues?q=is%3Aissue+is%3Aopen+label%3A%22line%3Aeditor%22+label%3A%22type%3Abug%22',
    singleton: true,
  },
};

// 平台守护（不是派发器，不进注册表、不可表单编辑）：启停/节拍在 runner-config.json（checkerEnabled / checkerIntervalSec）
export const CHECKER = {
  id: 'runner-checker',
  label: 'Runner Checker',
  script: path.join(import.meta.dirname, 'jobs', 'runner-checker.js'),
  defaultIntervalSec: 180,
  logFile: P.runnerCheckerLog,
  hint: '扫孤儿 → 标 awaiting-human（sid 落 outcomeDetail，从看板处置；平台组件不外发通知）',
};
export function checkerEnabled() { return readConfig().checkerEnabled !== false; }
export function checkerIntervalSec() { return Number(readConfig().checkerIntervalSec) || CHECKER.defaultIntervalSec; }

export function scriptFileOf(id) { return path.join(SCRIPTS_DIR, `${id}.mjs`); }
export function logFileOf(entry) {
  return DISPATCHER_TYPES[entry.type]?.logFile || path.join(P.tmpDir, `dispatch-${entry.id}.log`);
}

const ID_RE = /^[a-z0-9-]+$/;

function writeRegistry(reg) {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2), 'utf8');
}

// 注册表条目缺 intervalSec（v1 遗留 intervalMin）时就地换算；enabled 缺省 true
function normalize(d) {
  const intervalSec = Number(d.intervalSec) > 0 ? Number(d.intervalSec)
    : Number(d.intervalMin) > 0 ? Number(d.intervalMin) * 60
    : DISPATCHER_TYPES[d.type]?.defaultIntervalSec || 180;
  return { id: d.id, type: d.type, label: d.label, intervalSec, enabled: d.enabled !== false, createdAt: d.createdAt || null };
}

export function readRegistry() {
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  if (!fs.existsSync(REGISTRY_FILE)) {
    const seeded = {
      dispatchers: Object.keys(DISPATCHER_TYPES).map((type) => ({
        id: type, type, label: DISPATCHER_TYPES[type].label,
        intervalSec: DISPATCHER_TYPES[type].defaultIntervalSec, enabled: true, createdAt: fmt(new Date()),
      })),
    };
    writeRegistry(seeded);
    for (const d of seeded.dispatchers) ensureScriptFile(d);
    return seeded;
  }
  try {
    const reg = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    reg.dispatchers = (Array.isArray(reg.dispatchers) ? reg.dispatchers : []).map(normalize);
    return reg;
  } catch { return { dispatchers: [] }; }
}

export function findDispatcher(id) {
  return readRegistry().dispatchers.find((d) => d.id === id) || null;
}

// 脚本文件缺失时按场景模板补（注册表为准、脚本可再生）
export function ensureScriptFile(entry) {
  const file = scriptFileOf(entry.id);
  if (fs.existsSync(file)) return file;
  const tpl = DISPATCHER_TYPES[entry.type];
  if (!tpl) throw new Error(`未知场景来源：${entry.type}（无法生成脚本）`);
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  fs.copyFileSync(tpl.template, file);
  return file;
}

export function readScript(id) {
  try { return fs.readFileSync(scriptFileOf(id), 'utf8'); } catch { return null; }
}
export function readTemplate(type) {
  const tpl = DISPATCHER_TYPES[type];
  if (!tpl) return null;
  try { return fs.readFileSync(tpl.template, 'utf8'); } catch { return null; }
}

const validInterval = (v) => Number.isInteger(v) && v >= 5 && v <= 86400;

// ---- 脚本保存安全网（2026-07-10 复盘补强）：契约 + 语法校验不过不落盘；覆写前滚动备份 ----
async function validateScript(content) {
  if (!/export\s+default/.test(content)) {
    return { ok: false, error: '脚本缺少 export default async function tick(ctx) 入口' };
  }
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  const tmp = path.join(SCRIPTS_DIR, `.validate-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    const r = await new Promise((resolve) => {
      execFile(process.execPath, ['--check', tmp], { encoding: 'utf8', windowsHide: true, timeout: 15000 },
        (err, stdout, stderr) => resolve({ code: err ? 1 : 0, msg: `${stderr || ''}${stdout || ''}`.trim() }));
    });
    if (r.code !== 0) return { ok: false, error: `语法校验未通过：${r.msg.replaceAll(tmp, '<脚本>').slice(0, 800)}` };
    return { ok: true };
  } finally { fs.rmSync(tmp, { force: true }); }
}

const HISTORY_DIR = path.join(SCRIPTS_DIR, 'history');
const HISTORY_KEEP = 5;
function backupScript(id) {
  const file = scriptFileOf(id);
  if (!fs.existsSync(file)) return;
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.copyFileSync(file, path.join(HISTORY_DIR, `${id}.${fmt(new Date()).replace(/[: ]/g, '-')}.mjs`));
  const olds = fs.readdirSync(HISTORY_DIR).filter((f) => f.startsWith(`${id}.`)).sort();
  for (const f of olds.slice(0, Math.max(0, olds.length - HISTORY_KEEP))) fs.rmSync(path.join(HISTORY_DIR, f), { force: true });
}

// 新建：id=type（单例）；script 不传则用模板内容（模板已知良好，不重复校验）
export async function createDispatcher({ type, label, intervalSec, script }) {
  const tpl = DISPATCHER_TYPES[type];
  if (!tpl) return { ok: false, error: `未知场景来源：${type}` };
  const reg = readRegistry();
  if (tpl.singleton && reg.dispatchers.some((d) => d.type === type)) {
    return { ok: false, error: `${tpl.label}（${type}）已存在，该场景是单例（状态盘全局唯一）` };
  }
  const id = type;
  if (!ID_RE.test(id)) return { ok: false, error: `非法 id：${id}` };
  const entry = {
    id, type,
    label: (label || '').trim() || tpl.label,
    intervalSec: validInterval(intervalSec) ? intervalSec : tpl.defaultIntervalSec,
    enabled: true,
    createdAt: fmt(new Date()),
  };
  try {
    if (script && String(script).trim()) {
      const v = await validateScript(String(script));
      if (!v.ok) return v;
      fs.writeFileSync(scriptFileOf(id), String(script), 'utf8');
    } else ensureScriptFile(entry);
    reg.dispatchers.push(entry);
    writeRegistry(reg);
    return { ok: true, dispatcher: entry };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function updateDispatcher(id, { label, intervalSec, script, enabled } = {}) {
  const reg = readRegistry();
  const entry = reg.dispatchers.find((d) => d.id === id);
  if (!entry) return { ok: false, error: `未知派发器：${id}` };
  if (intervalSec != null) {
    if (!validInterval(intervalSec)) return { ok: false, error: `间隔需为 5..86400 整数秒：${intervalSec}` };
    entry.intervalSec = intervalSec;
  }
  if (label != null && String(label).trim()) entry.label = String(label).trim();
  if (enabled != null) entry.enabled = !!enabled;
  try {
    if (script != null) {
      if (!String(script).trim()) return { ok: false, error: '脚本内容不能为空' };
      const v = await validateScript(String(script));
      if (!v.ok) return v;              // 校验不过：不落盘、注册表不写
      backupScript(id);                  // 覆写前滚动备份（history/ 留 5 版）
      fs.writeFileSync(scriptFileOf(id), String(script), 'utf8');
    } else ensureScriptFile(entry);
    writeRegistry(reg);
    return { ok: true, dispatcher: entry };
  } catch (e) { return { ok: false, error: e.message }; }
}

// 删除：脚本文件改名保底（用户手写内容不直接销毁），注册表条目移除
export function deleteDispatcher(id) {
  const reg = readRegistry();
  const entry = reg.dispatchers.find((d) => d.id === id);
  if (!entry) return { ok: false, error: `未知派发器：${id}` };
  try {
    const file = scriptFileOf(id);
    let note = '';
    if (fs.existsSync(file)) {
      const bak = `${file}.deleted-${fmt(new Date()).replace(/[: ]/g, '-')}`;
      fs.renameSync(file, bak);
      note = `脚本已保底改名：${path.basename(bak)}`;
    }
    reg.dispatchers = reg.dispatchers.filter((d) => d.id !== id);
    writeRegistry(reg);
    return { ok: true, removed: id, note };
  } catch (e) { return { ok: false, error: e.message }; }
}

// 新建表单用：type → 展示信息 + 是否还能建
export function listTypes() {
  const reg = readRegistry();
  const out = {};
  for (const [type, tpl] of Object.entries(DISPATCHER_TYPES)) {
    out[type] = {
      label: tpl.label,
      defaultIntervalSec: tpl.defaultIntervalSec,
      hint: tpl.hint,
      singleton: !!tpl.singleton,
      exists: reg.dispatchers.some((d) => d.type === type),
    };
  }
  return out;
}
