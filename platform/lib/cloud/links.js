import fs from 'node:fs';
import path from 'node:path';
import { P } from '../paths.js';

// 云端下发链接（$DATA_ROOT/runtime/cloud/links/<intentId>.json）。
//
// 【决策 14（cloud-control-plane.md §6.3 / 决策表 14）】本地任务**不全量上云**：
//   只有「云端下发」的任务（有 cloud link 的）才经对账上行；本地手敲 / CLI / API / 手机中继建的活
//   不出机器——云端是**派活平台**，不是监控大盘。手机主人要看自己机器的全部任务走 `/m/` 实时中继，
//   与本过滤零冲突（中继不读云库）。
//
// link 文件由 P2「下发消费」流程写（spec §6.4 step e：connector 消费 intent → createTask → 写 link），
// 本模块**只读**。P2 未落地前该目录为空 → 上行集合为空（决策 14 承认的目标终态：下行落地前云端是空的）。
// 分支据的是「有没有 link」这条独立事实，不是 source（不变式 2：绝不按来源特判）。

const LINKS_DIR = path.join(P.tmpDir, 'cloud', 'links');

/**
 * 读全部 link 文件，汇出「已被云端下发」的本地 taskKey 集合。
 * 目录不存在（未 enroll / 无下发）→ 空集；坏文件逐个跳过，绝不抛。
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
      // spec §6.4 ack 体字段名 localTaskKey；兼容裸 taskKey 写法
      const k = o?.localTaskKey ?? o?.taskKey;
      if (typeof k === 'string' && k) keys.add(k);
    } catch { /* 单个坏 link 不连累其余 */ }
  }
  return keys;
}
