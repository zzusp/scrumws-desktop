import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { P } from '../paths.js';

// 机器身份持久化（$DATA_ROOT/runtime/cloud/identity.json）。
// ⚠ 字段是穷举：{ machineUid, cloudUrl, machineId, token, workspaceId, workspaceName, enrolledAt }。
// 注册密钥 swrk_ 绝不进这里——它是入场券，只在 enroll 那一次请求体里出现，用完即弃（契约 §7.1）。
// machineUid 与 enroll 解耦：未 enroll 时也只有 {machineUid}；改机器名不该变成新机器。
/** @typedef {{machineUid:string, cloudUrl?:string, machineId?:string, token?:string,
 *             workspaceId?:string, workspaceName?:string, enrolledAt?:string}} Identity */

const CLOUD_DIR = path.join(P.tmpDir, 'cloud');
const IDENTITY_FILE = path.join(CLOUD_DIR, 'identity.json');

// 文件含机器令牌 swmt_ → 尽力 0600（Windows 上 chmod 基本无效，失败不影响功能）
function writeIdentity(obj) {
  fs.mkdirSync(CLOUD_DIR, { recursive: true });
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(obj, null, 2), 'utf8');
  try { fs.chmodSync(IDENTITY_FILE, 0o600); } catch { /* 平台不支持则算了 */ }
  return obj;
}

/** 读 identity.json；文件不存在 / 坏 JSON → null。绝不抛。 */
export function readIdentity() {
  try {
    const o = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
    return o && typeof o === 'object' && o.machineUid ? o : null;
  } catch { return null; }
}

/** 取 machineUid；无则 randomUUID() 生成并落盘（首次启动即调，与 enroll 无关）。 */
export function ensureMachineUid() {
  const cur = readIdentity();
  if (cur?.machineUid) return cur.machineUid;
  const machineUid = crypto.randomUUID();
  writeIdentity({ machineUid });
  return machineUid;
}

/** 合并写入（浅合并）+ 尽力 chmod 0600。返回合并后的完整 Identity。 */
export function saveIdentity(patch) {
  const next = { machineUid: ensureMachineUid(), ...(readIdentity() || {}), ...(patch || {}) };
  return writeIdentity(next);
}

/** 解绑：删掉云端绑定字段，**保留 machineUid**（重新 enroll 仍是同一台机器）。 */
export function clearCloudBinding() {
  return writeIdentity({ machineUid: ensureMachineUid() });
}

/** 是否已 enroll（token 与 cloudUrl 齐全）。 */
export function isEnrolled() {
  const id = readIdentity();
  return !!(id?.token && id?.cloudUrl);
}
