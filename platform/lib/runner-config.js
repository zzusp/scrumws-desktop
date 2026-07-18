import fs from 'node:fs';
import path from 'node:path';
import { P } from './paths.js';
import { getProviderDefinition, listProviderDefinitions, normalizeProvider, resolveProviderSelection } from './providers/registry.js';

// runner-config.json 的位置（与 scripts 侧共享）
const CONFIG_FILE = path.join(P.tmpDir, 'runner-config.json');

export function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

export function writeConfig(patch) {
  const cfg = readConfig();
  Object.assign(cfg, patch);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

// 旧配置只在读取时解释，不做静默落盘迁移：defaultModel 仅作为 Claude 默认；Codex 使用 registry 默认。
export function providerConfig(config = readConfig()) {
  const requestedDefault = normalizeProvider(config.defaultProvider);
  const defaultProvider = getProviderDefinition(requestedDefault) ? requestedDefault : 'claude';
  const providerDefaults = {};
  for (const definition of listProviderDefinitions()) {
    const selected = resolveProviderSelection({ provider: definition.id }, config);
    providerDefaults[definition.id] = selected.ok
      ? { model: selected.model, effort: selected.effort }
      : { model: definition.defaultModel, effort: definition.defaultEffort };
  }
  return { defaultProvider, providerDefaults };
}

// model context 的规范 key 为 provider:model；旧的裸 model key 只归到 Claude。
export function normalizeModelContextLimits(limits) {
  const out = {};
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return out;
  for (const [rawKey, rawValue] of Object.entries(limits)) {
    const key = String(rawKey || '').trim();
    if (!key) continue;
    out[key.includes(':') ? key : `claude:${key}`] = rawValue;
  }
  return out;
}
