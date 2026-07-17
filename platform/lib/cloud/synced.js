import fs from 'node:fs';
import path from 'node:path';
import { P } from '../paths.js';

// 对账账本（$DATA_ROOT/runtime/cloud/synced.json）：{ "<taskKey>": "<rev>" }
// 语义是「**已确认云端收到**」，不是「我打算推」——推失败就别记账，下一轮对账自然补上（契约 §7.1 第 7 步）。
const CLOUD_DIR = path.join(P.tmpDir, 'cloud');
const SYNCED_FILE = path.join(CLOUD_DIR, 'synced.json');

/** 读 synced.json → { [taskKey]: rev }；不存在 / 坏 JSON → {}。绝不抛。 */
export function readSynced() {
  try {
    const o = JSON.parse(fs.readFileSync(SYNCED_FILE, 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}

/** 整体覆写（先写 .tmp 再 rename，避免进程中途死掉留半截文件）。 */
export function writeSynced(map) {
  fs.mkdirSync(CLOUD_DIR, { recursive: true });
  const tmp = `${SYNCED_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
  fs.renameSync(tmp, SYNCED_FILE);
}
