import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { P } from './paths.js';
import { getProviderDefinition, normalizeProvider, validateProviderSelection } from './providers/registry.js';
import { listWorkDirectories } from './runner-config.js';

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

// Codex 的空 model/effort 表示“沿用 CLI 默认”，在 API key 策略白名单中是有意义的值。
function normPolicyArr(v, allowEmpty, max = 20) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of v) {
    const s = String(raw ?? '').trim();
    if ((!s && !allowEmpty) || s.length > 200 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function legacyPolicyPairs(allowedModels, allowedEfforts, definition) {
  const models = normPolicyArr(allowedModels, definition.allowCustomModel);
  if (!models.length) return { error: 'allowedModels 必选：至少勾选一个可用模型（第一个为该密钥默认）' };
  for (const model of models) {
    const selected = validateProviderSelection({ provider: definition.id, model });
    if (!selected.ok) return { error: `allowedModels 非法：${selected.error}` };
  }
  const efforts = normPolicyArr(allowedEfforts, definition.id === 'codex');
  if (!efforts.length) return { error: 'allowedEfforts 必选：至少勾选一个可用 effort（第一个为该密钥默认）' };
  for (const effort of efforts) {
    const selected = validateProviderSelection({ provider: definition.id, effort });
    if (!selected.ok) return { error: `allowedEfforts 非法：${selected.error}` };
  }
  return { pairs: models.flatMap((model) => efforts.map((effort) => ({ model, effort }))) };
}

// 存量密钥没有组合字段，读取时按原「模型白名单 × effort 白名单」语义解释，避免升级后扩权或失权。
export function policyPairsOf(key) {
  if (Array.isArray(key?.allowedModelEfforts) && key.allowedModelEfforts.length) {
    return key.allowedModelEfforts.map((item) => ({ model: String(item?.model ?? '').trim(), effort: String(item?.effort ?? '').trim() }));
  }
  const models = Array.isArray(key?.allowedModels) ? key.allowedModels : [];
  const efforts = Array.isArray(key?.allowedEfforts) ? key.allowedEfforts : [];
  return models.flatMap((model) => efforts.map((effort) => ({ model: String(model ?? '').trim(), effort: String(effort ?? '').trim() })));
}

function policyPairsFromInput(allowedModelEfforts, allowedModels, allowedEfforts, definition) {
  // 保留数组入参仅用于 API 调用方平滑迁移；管理表单一律提交组合字段。
  if (!Array.isArray(allowedModelEfforts)) return legacyPolicyPairs(allowedModels, allowedEfforts, definition);
  const pairs = [];
  const seen = new Set();
  for (const raw of allowedModelEfforts) {
    const model = String(raw?.model ?? '').trim();
    const effort = String(raw?.effort ?? '').trim();
    if (!effort) return { error: 'allowedModelEfforts 中每条组合都必须选择 effort' };
    const selected = validateProviderSelection({ provider: definition.id, model, effort });
    if (!selected.ok) return { error: `allowedModelEfforts 非法：${selected.error}` };
    const id = `${model}\u0000${effort}`;
    if (seen.has(id)) continue;
    seen.add(id);
    pairs.push({ model, effort });
    if (pairs.length >= 20) break;
  }
  if (!pairs.length) return { error: 'allowedModelEfforts 必选：至少添加一条模型 + effort 组合（第一条为该密钥默认）' };
  return { pairs };
}

// 配置校验（create / update 共用）：策略组合和目录均必选。目录只可从「工作目录」菜单维护的列表中选择；
// 外部任务本身仍可使用该目录的子目录。allowQueued（默认 false）决定是否能 plan:false 直进 queued。
function validateKeyConfig({ label, source, provider, allowedModelEfforts, allowedModels, allowedEfforts, allowedCwds, allowQueued }) {
  const lab = String(label || '').trim().slice(0, 100);
  const src = String(source || '').trim();
  const providerId = normalizeProvider(provider);
  const definition = getProviderDefinition(providerId);
  if (!lab) return { ok: false, error: 'label required' };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(src)) return { ok: false, error: `非法 source：${src}（仅 [A-Za-z0-9_-]、首字符字母数字）` };
  if (!definition) return { ok: false, error: `未知 provider：${providerId}` };
  const pairResult = policyPairsFromInput(allowedModelEfforts, allowedModels, allowedEfforts, definition);
  if (pairResult.error) return { ok: false, error: pairResult.error };
  const pairs = pairResult.pairs;
  const cwds = [];
  const configured = new Set(listWorkDirectories().map((cwd) => path.resolve(cwd).toLowerCase()));
  for (const c of normStrArr(allowedCwds)) {
    if (!path.isAbsolute(c)) return { ok: false, error: `allowedCwds 须为绝对路径：${c}` };
    const cwd = path.resolve(c);
    if (!configured.has(cwd.toLowerCase())) return { ok: false, error: `allowedCwds 必须从「工作目录」菜单已配置的目录中选择：${cwd}` };
    cwds.push(cwd);
  }
  if (!cwds.length) return { ok: false, error: 'allowedCwds 必填：至少选择一个「工作目录」菜单已配置的目录（第一项为该密钥默认）' };
  return {
    ok: true,
    cfg: {
      label: lab, source: src, provider: providerId, allowedModelEfforts: pairs,
      // 两份派生数组继续返回给未迁移的调用方；真正的授权判定只认组合。
      allowedModels: [...new Set(pairs.map((item) => item.model))],
      allowedEfforts: [...new Set(pairs.map((item) => item.effort))],
      allowedCwds: cwds, allowQueued: !!allowQueued,
    },
  };
}

// 创建 key：返回 {ok, key(存盘条目), plaintext}。
// 明文随条目落盘（2026-07-17：「复制密钥」= 复制原文）：发起端配置（如 baibu 的
// scrumws-ingest.json）本就在同机存明文，服务端留存不扩大风险面；管理面只听 127.0.0.1，
// 列表直接外带明文供「复制」。鉴权比对仍用 sha256。
export function createApiKey(input) {
  const v = validateKeyConfig(input || {});
  if (!v.ok) return v;
  const plaintext = `swak_${crypto.randomBytes(32).toString('base64url')}`;
  const entry = {
    id: crypto.randomBytes(6).toString('hex'),
    ...v.cfg,
    prefix: plaintext.slice(0, 12),
    hash: sha256Hex(plaintext),
    plaintext,
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
  const v = validateKeyConfig({ ...(input || {}), provider: input?.provider ?? k.provider });
  if (!v.ok) return v;
  Object.assign(k, v.cfg);
  writeKeys(keys);
  return { ok: true, key: publicView(k) };
}

// 列表/响应视图：不外带 hash；plaintext 直接外带（本机管理面「复制」用；明文留存前的旧钥为 null）
function publicView(k) {
  return {
    id: k.id, label: k.label, source: k.source, prefix: k.prefix, createdAt: k.createdAt,
    provider: normalizeProvider(k.provider),
    disabled: !!k.disabled, lastUsedAt: k.lastUsedAt || null,
    allowedModelEfforts: policyPairsOf(k),
    allowedModels: Array.isArray(k.allowedModels) ? k.allowedModels : [...new Set(policyPairsOf(k).map((item) => item.model))],
    allowedEfforts: Array.isArray(k.allowedEfforts) ? k.allowedEfforts : [...new Set(policyPairsOf(k).map((item) => item.effort))],
    allowedCwds: Array.isArray(k.allowedCwds) ? k.allowedCwds : [],
    allowQueued: !!k.allowQueued,
    plaintext: k.plaintext || null,
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
