// 契约 §6.5.2「rk 只管入场，不管在场」：撤销注册密钥 → 已在线的机器**不受任何影响**
// （它靠机器令牌 swmt_ 活着，enroll 早结束了）；同时新机器再也进不来。
// 要踢机器得撤 machine_token（§6.8），别把这两件事混了。
//
// 用法：node rk-revoke-online-machine.mjs <cloudUrl> <rkFile> <cookieFile>
import fs from 'node:fs';
import crypto from 'node:crypto';

const [, , CLOUD, RK_FILE, COOKIE_FILE] = process.argv;
if (!CLOUD || !RK_FILE || !COOKIE_FILE) throw new Error('用法：node rk-revoke-online-machine.mjs <cloudUrl> <rkFile> <cookieFile>');

const rk = fs.readFileSync(RK_FILE, 'utf8').trim();
const cookie = (() => {
  for (const l of fs.readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/)) {
    const p = l.split('\t');
    if (p.length >= 7 && p[5] === 'swsession') return `swsession=${p[6]}`;
  }
  throw new Error('cookie jar 里没有 swsession');
})();

const get = async (p) => (await fetch(CLOUD + p, { headers: { cookie } })).json();
const post = async (p, b, hdr = {}) => {
  const r = await fetch(CLOUD + p, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie, ...hdr }, body: JSON.stringify(b) });
  return { status: r.status, text: await r.text() };
};
const machine = async () => (await get('/api/machines')).machines.find((m) => m.hostname !== 'NEG-TEST');

let pass = true;
const check = (name, ok, detail) => { if (!ok) pass = false; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n      ' + detail : ''}`); };

// 0. 前置：机器必须此刻在线
const m0 = await machine();
console.log(`前置：机器 ${m0.displayName} status=${m0.status} lastSeenAt=${m0.lastSeenAt}\n`);
check('前置 · 机器当前在线', m0.status === 'online');

// 1. 找到它 enroll 时用的那把 rk，撤销它
const keys = (await get('/api/registration-keys')).keys;
const prefix = rk.slice(0, 9);
const target = keys.find((k) => k.keyPrefix === prefix && !k.revokedAt);
if (!target) throw new Error('找不到该 rk（prefix=' + prefix + '）或它已被撤销');
console.log(`撤销 rk：prefix=${target.keyPrefix} label=${target.label} lastUsedAt=${target.lastUsedAt}`);
const rv = await post(`/api/registration-keys/${target.id}/revoke`, {});
check('撤销 rk → 200', rv.status === 200, rv.text);

// 2. 撤销后：新机器进不来（同一把 rk enroll → 401）
const code = (await post('/api/machines/enrollment-codes', {})).text;
const codeVal = JSON.parse(code).code;
const tryEnroll = await post('/api/machine/enroll', {
  registrationKey: rk, code: codeVal, machineUid: crypto.randomUUID(),
  hostname: 'NEG-TEST', platform: 'win32', arch: 'x64', appVersion: '0.1.0', claudeVersion: null,
});
check('撤销后 · 用这把 rk 拉新机器入场 → 401（新机器进不来）', tryEnroll.status === 401, tryEnroll.text);

// 3. 关键：已在线的机器**不受影响** —— 等 >2 个心跳周期，它必须仍 online 且 lastSeenAt 在前进
console.log('\n等 40s（>2 个心跳周期），看已在线的机器是否被误伤…');
const seen0 = m0.lastSeenAt;
await new Promise((r) => setTimeout(r, 40_000));
const m1 = await machine();
console.log(`  撤销前 lastSeenAt = ${seen0}`);
console.log(`  撤销后 lastSeenAt = ${m1.lastSeenAt}`);
check('已在线机器仍 online（rk 撤销不管在场）', m1.status === 'online', `status=${m1.status}`);
check('心跳仍在前进（机器令牌照常工作，没被 rk 撤销牵连）', new Date(m1.lastSeenAt) > new Date(seen0));

console.log('\n→ 结论：rk 只管入场（新机器 401），不管在场（老机器照常心跳）。');
console.log('   要踢掉某台机器得撤它的 machine_token（§6.8 /api/machines/:id/revoke），不是撤 rk。');
process.exit(pass ? 0 : 1);
