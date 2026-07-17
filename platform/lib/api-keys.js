import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { P } from './paths.js';
import { ALLOWED_MODELS, ALLOWED_EFFORTS } from './task-actions.js';

// 外部任务 API 的密钥件（swak_ = ScrumWS Api Key）。铸造/存储模式对齐 cloud/src/auth.js：
// 随机 32B base64url、明文只在创建响应里回一次、落盘只存 sha256。每个 key 绑定一个 source——
// 外部建的任务 source 一律取 key 绑定值（来源身份由持钥方证明，不信请求体），查询也只能查本 source。
const KEYS_FILE = path.join(P.tmpDir, 'api-keys.json');

function readKeys() {
  if (!fs.existsSync(KEYS_FILE)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'))?.keys;
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function writeKeys(keys) {
  fs.mkdirSync(P.tmpDir, { recursive: true });
  fs.writeFileSync(KEYS_FILE, JSON.stringify({ keys }, null, 2), 'utf8');
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 去重 + trim 的字符串数组归一（策略白名单入参用）
function normStrArr(v, max = 20) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of v) {
    const s = String(raw || '').trim();
    if (!s || s.length > 500 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

// 配置校验（create / update 共用）：label 必填；source 规则与 createTask.source 一致；
// 策略白名单**三项必选**（全不选 = 没有权限）：allowedModels / allowedEfforts 须为全局白名单子集、
// allowedCwds 须为绝对路径（请求省略对应字段时取首项为默认）；allowQueued（默认 false）= 是否允许
// plan:false 直进 queued 自动执行（关闭时该密钥只能建 plan 任务，须看板确认）。
function validateKeyConfig({ label, source, allowedModels, allowedEfforts, allowedCwds, allowQueued }) {
  const lab = String(label || '').trim().slice(0, 100);
  const src = String(source || '').trim();
  if (!lab) return { ok: false, error: 'label required' };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(src)) return { ok: false, error: `非法 source：${src}（仅 [A-Za-z0-9_-]、首字符字母数字）` };
  const models = normStrArr(allowedModels);
  if (!models.length) return { ok: false, error: 'allowedModels 必选：至少勾选一个可用模型（第一个为该密钥默认）' };
  for (const m of models) if (!ALLOWED_MODELS.has(m)) return { ok: false, error: `allowedModels 含非白名单模型：${m}（可用：${Array.from(ALLOWED_MODELS).join(', ')}）` };
  const efforts = normStrArr(allowedEfforts);
  if (!efforts.length) return { ok: false, error: 'allowedEfforts 必选：至少勾选一个可用 effort（第一个为该密钥默认）' };
  for (const e of efforts) if (!ALLOWED_EFFORTS.has(e)) return { ok: false, error: `allowedEfforts 含非法档位：${e}（可用：${Array.from(ALLOWED_EFFORTS).join(', ')}）` };
  const cwds = [];
  for (const c of normStrArr(allowedCwds)) {
    if (!path.isAbsolute(c)) return { ok: false, error: `allowedCwds 须为绝对路径：${c}` };
    cwds.push(path.resolve(c));
  }
  if (!cwds.length) return { ok: false, error: 'allowedCwds 必填：至少一个可访问目录（绝对路径；第一行为该密钥默认）' };
  return { ok: true, cfg: { label: lab, source: src, allowedModels: models, allowedEfforts: efforts, allowedCwds: cwds, allowQueued: !!allowQueued } };
}

// 创建 key：返回 {ok, key(存盘条目), plaintext}；plaintext 只此一次，之后任何端点不再可取。
export function createApiKey(input) {
  const v = validateKeyConfig(input || {});
  if (!v.ok) return v;
  const plaintext = `swak_${crypto.randomBytes(32).toString('base64url')}`;
  const entry = {
    id: crypto.randomBytes(6).toString('hex'),
    ...v.cfg,
    prefix: plaintext.slice(0, 12),
    hash: sha256Hex(plaintext),
    createdAt: nowStr(),
    disabled: false,
    lastUsedAt: null,
  };
  const keys = readKeys();
  keys.push(entry);
  writeKeys(keys);
  return { ok: true, key: publicView(entry), plaintext };
}

// 编辑已有 key：可改 label / source / 策略 / allowQueued；密钥本体（prefix/hash）与
// createdAt / disabled / lastUsedAt 不动——明文不可复原，"换钥"只能删了重建或复制克隆。
export function updateApiKey(input) {
  const id = String(input?.id || '');
  const keys = readKeys();
  const k = keys.find((x) => x.id === id);
  if (!k) return { ok: false, error: 'key not found' };
  const v = validateKeyConfig(input || {});
  if (!v.ok) return v;
  Object.assign(k, v.cfg);
  writeKeys(keys);
  return { ok: true, key: publicView(k) };
}

// 列表/响应视图：永不外带 hash
function publicView(k) {
  return {
    id: k.id, label: k.label, source: k.source, prefix: k.prefix, createdAt: k.createdAt,
    disabled: !!k.disabled, lastUsedAt: k.lastUsedAt || null,
    allowedModels: Array.isArray(k.allowedModels) ? k.allowedModels : [],
    allowedEfforts: Array.isArray(k.allowedEfforts) ? k.allowedEfforts : [],
    allowedCwds: Array.isArray(k.allowedCwds) ? k.allowedCwds : [],
    allowQueued: !!k.allowQueued,
  };
}

export function listApiKeys() {
  return readKeys().map(publicView);
}

export function setApiKeyDisabled(id, disabled) {
  const keys = readKeys();
  const k = keys.find((x) => x.id === String(id || ''));
  if (!k) return { ok: false, error: 'key not found' };
  k.disabled = !!disabled;
  writeKeys(keys);
  return { ok: true, key: publicView(k) };
}

export function deleteApiKey(id) {
  const keys = readKeys();
  const idx = keys.findIndex((x) => x.id === String(id || ''));
  if (idx < 0) return { ok: false, error: 'key not found' };
  keys.splice(idx, 1);
  writeKeys(keys);
  return { ok: true };
}

// 校验 Authorization 头：`Bearer swak_…`。sha256 后 timingSafeEqual 逐条比对（等长 hex，无长度侧信道）；
// 命中即刷 lastUsedAt（低频调用，直接写穿）。失败一律 {ok:false}，不区分"不存在/已禁用"（不泄露 key 状态）。
export function verifyApiKey(authorizationHeader) {
  const m = /^Bearer\s+(swak_[A-Za-z0-9_-]+)$/.exec(String(authorizationHeader || '').trim());
  if (!m) return { ok: false };
  const givenHash = Buffer.from(sha256Hex(m[1]), 'hex');
  const keys = readKeys();
  for (const k of keys) {
    let stored;
    try { stored = Buffer.from(String(k.hash || ''), 'hex'); } catch { continue; }
    if (stored.length !== givenHash.length) continue;
    if (crypto.timingSafeEqual(stored, givenHash)) {
      if (k.disabled) return { ok: false };
      k.lastUsedAt = nowStr();
      try { writeKeys(keys); } catch { /* lastUsedAt 刷新失败不影响鉴权 */ }
      return { ok: true, key: publicView(k) };
    }
  }
  return { ok: false };
}
