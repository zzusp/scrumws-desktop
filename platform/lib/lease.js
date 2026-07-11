import { readConfig } from './runner-config.js';
import { parse } from './timeutil.js';

// lease 判活单份实现（2026-07-08 优化轮下沉；此前 collect.js / logs.js / task-actions.js 三份漂移：
// 60min TTL ×2 + 无 TTL ×1，并发闸门与展示判据打架）。
// 与 scripts/lib/runner-common.ps1 的 Test-LeaseAlive 同语义，改判据两边一起改：
//   pid=0  → claimedAt < 2min 宽限（刚 spawn 未补 pid）
//   pid 死 → dead
//   pid 活 → heartbeat < leaseHardTtlMinutes（默认 240，读 runner-config.json）才算 alive
// 不用 60min 短 TTL：heartbeat 只在轮间 Beat，重活单轮可超 1h，短 TTL 会把在跑 worker 误判为死。

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function leaseAlive(l, now = Date.now()) {
  if (!l) return false;
  const ts = (v) => { const d = parse(v); return d ? d.getTime() : 0; };
  if (!l.pid || l.pid === 0) return !!l.claimedAt && (now - ts(l.claimedAt)) / 60000 < 2;
  if (!pidAlive(l.pid)) return false;
  if (!l.heartbeatAt) return true;
  const ttl = Number(readConfig().leaseHardTtlMinutes) || 240;
  return (now - ts(l.heartbeatAt)) / 60000 < ttl;
}
