import fs from 'node:fs';
import path from 'node:path';
import { P } from '../paths.js';

// 云端下发链接（$DATA_ROOT/runtime/cloud/links/<intentId>.json，一个 intent 一个文件）。
//
// 【决策 14（cloud-control-plane.md §6.3 / 决策表 14）】本地任务**不全量上云**：
//   只有「云端下发」的任务（有 cloud link 的）才经对账上行；本地手敲 / CLI / API / 手机中继建的活
//   不出机器——云端是**派活平台**，不是监控大盘。手机主人要看自己机器全部任务走 `/m/` 实时中继，零冲突。
//
// 一个文件承载两个用途（决策 14 消费方 = 对账；P2 下发消费方 = connector）：
//   ① 意图下行的**幂等锚**：同一个 intentId 无论被拉几次，本地只建一个任务（ack 丢包必然重拉）。
//      taskKey=null 的条目是「占位」——建任务前先落，崩在半路时下一轮认得出来（契约 §7.4 分支 a'）。
//   ② 决策 14 的**过滤依据**：readCloudLinks() 汇出已下发任务的 taskKey 集合，reconcile 只上报这些。
//
// ⚠ 目录格式（而非单文件）是**与 #67 共享的双向契约**：#67 的对账过滤（reconcile.js）import readCloudLinks，
//   它读的就是这个目录。connector 写 link（含 taskKey:null 占位），两侧靠 <intentId>.json 的
//   {taskKey|null} 对齐。占位态（taskKey=null）绝不能被 readCloudLinks 当成「已建成」上报。
// 每文件 tmp+rename 原子写，避免半截文件让幂等锚不可读 = 重建任务。永不修剪（留着才幂等）。

const LINKS_DIR = path.join(P.tmpDir, 'cloud', 'links');
const linkPath = (id) => path.join(LINKS_DIR, `${String(id).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);

/**
 * 读全部 link 文件，汇出「已被云端下发」的本地 taskKey 集合（#67 的对账过滤唯一入口）。
 * 目录不存在（未 enroll / 无下发）→ 空集；坏文件逐个跳过；占位（taskKey=null）不计入。绝不抛。
 * @returns {Set<string>} 已下发任务的本地 taskKey
 */
export function readCloudLinks() {
  let names;
  try { names = fs.readdirSync(LINKS_DIR); }
  catch { return new Set(); }
  const keys = new Set();
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const o = JSON.parse(fs.readFileSync(path.join(LINKS_DIR, n), 'utf8'));
      // ack 体字段名 localTaskKey；兼容裸 taskKey 写法
      const k = o?.localTaskKey ?? o?.taskKey;
      if (typeof k === 'string' && k) keys.add(k);
    } catch { /* 单个坏 link 不连累其余 */ }
  }
  return keys;
}

/** 读单个 intent 的 link → 条目对象；不存在 / 坏 JSON → null。绝不抛。 */
export function readLink(id) {
  try {
    const o = JSON.parse(fs.readFileSync(linkPath(id), 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

/** 写单个 intent 的 link（tmp+rename 原子）。entry 形如 { taskKey|null, reservedAt, createdAt, ackedAt }。 */
export function writeLink(id, entry) {
  fs.mkdirSync(LINKS_DIR, { recursive: true });
  const p = linkPath(id);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/** 删单个 intent 的 link（撤占位 / reject 终局）。不存在也不抛。 */
export function deleteLink(id) {
  try { fs.unlinkSync(linkPath(id)); } catch { /* 已不在 */ }
}
