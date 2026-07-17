import fs from 'node:fs';
import path from 'node:path';
import { P } from '../paths.js';

// 下行幂等账本（$DATA_ROOT/runtime/cloud/links.json）：
//   { "<intentId>": { taskKey: "cloud:2026…-482"|null, reservedAt: ISO, createdAt: ISO|null, ackedAt: ISO|null } }
// 两个用途，缺一不可：
//   ① 意图下行的幂等锚：同一个 intentId 无论被拉到几次，本地只建一个任务（ack 响应丢包必然重拉）。
//      taskKey=null 的条目是「占位」——建任务前先落，崩在半路时下一轮认得出来（契约 §7.4 分支 a'）。
//   ② 决策 14 的过滤依据：只有云端下发的任务才上报，本地手敲的活不上云 → linkedTaskKeys() 就是那张名单。
// ⚠ 单文件而非设计 §6.4 画的 links/<intentId>.json 目录：对账每 15s 都要一次全量反向索引（taskKey 集合），
//   目录形态每轮要 readdir + N 次读；单文件一次读就够，写入一次 rename = 原子（形态照抄 synced.js:19-25）。
// ⚠ 格式为**与 #67 共享的双向契约**（契约 §7.3）：本文件写 link（含 taskKey:null 占位），#67 的对账过滤
//   读 linkedTaskKeys()。占位态绝不能被当成「已建成」上报。
// 容量：一条约 120 字节，一个 intent 一条，永不修剪（契约 §12 缺口 4：留着才幂等）。
const CLOUD_DIR = path.join(P.tmpDir, 'cloud');
const LINKS_FILE = path.join(CLOUD_DIR, 'links.json');

/** 读 links.json → { [intentId]: link }；不存在 / 坏 JSON → {}。绝不抛。 */
export function readLinks() {
  try {
    const o = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}

/** 整体覆写（先写 .tmp 再 rename，避免进程中途死掉留半截文件 → 幂等锚不可读 = 会重建任务）。 */
export function writeLinks(map) {
  fs.mkdirSync(CLOUD_DIR, { recursive: true });
  const tmp = `${LINKS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
  fs.renameSync(tmp, LINKS_FILE);
}

/**
 * 已建出本地任务的 taskKey 集合（占位条目 taskKey=null 不算 —— 它还没有对应的本地任务）。
 * **对账的过滤依据**（决策 14，#67 消费）：不在这个集合里的卡片一律不上报。
 * @returns {Set<string>}
 */
export function linkedTaskKeys() {
  const out = new Set();
  for (const v of Object.values(readLinks())) {
    if (v && typeof v.taskKey === 'string' && v.taskKey) out.add(v.taskKey);
  }
  return out;
}
