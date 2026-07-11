import fs from 'node:fs';
import path from 'node:path';
import { P } from './paths.js';

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

// 暂停/恢复全局派发
export function setPauseInvestigation(paused) {
  writeConfig({ pauseInvestigation: !!paused });
  return { ok: true, pauseInvestigation: !!paused };
}
