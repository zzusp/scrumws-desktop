// 负例：注册密钥（swrk_）的门口校验（契约 §6.5 / §6.5.2）。
// 验四条：
//   ① 不带 rk        → 拒绝（形状问题，契约 §6.5 第 0 步定的是 400 BAD_REQUEST）
//   ② 带错 rk        → 401
//   ③ 带已撤销的 rk  → 401
//   ④ rk 对但 code 错 → 401，且响应体与 ②③ **逐字节相同**（否则就是 rk 有效性 oracle）
// 另验：rk 失败不消费配对码（rk 在 code 之前校验，§6.5 顺序即契约）。
//
// 用法：node enroll-negative.mjs <cloudUrl> <rkPlaintext> <sessionCookieFile>
import fs from 'node:fs';
import crypto from 'node:crypto';

const [, , CLOUD_URL, RK, COOKIE_FILE] = process.argv;
if (!CLOUD_URL || !RK || !COOKIE_FILE) throw new Error('用法：node enroll-negative.mjs <cloudUrl> <rk> <cookieFile>');

// 从 curl cookie jar 里取会话 cookie（只取值，不打印）
const cookie = (() => {
  for (const l of fs.readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/)) {
    const p = l.split('\t');
    if (p.length >= 7 && p[5] === 'swsession') return `swsession=${p[6]}`;
  }
  throw new Error('cookie jar 里没有 swsession');
})();

const post = async (path, body, headers = {}) => {
  const r = await fetch(CLOUD_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
};

const newCode = async () => {
  const r = await fetch(CLOUD_URL + '/api/machines/enrollment-codes', {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: '{}',
  });
  return (await r.json()).code;
};

const baseBody = (code) => ({
  code,
  machineUid: crypto.randomUUID(),
  displayName: '负例机器',
  hostname: 'NEG-TEST',
  platform: 'win32',
  arch: 'x64',
  appVersion: '0.1.0',
  claudeVersion: null,
});

const results = [];
const record = (name, r, expectStatus) => {
  const pass = r.status === expectStatus;
  results.push({ name, status: r.status, expect: expectStatus, body: r.text, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      → HTTP ${r.status}（期望 ${expectStatus}）  ${r.text}`);
};

// ① 不带 rk（字段缺失 = 形状问题）
{
  const code = await newCode();
  const b = baseBody(code);
  const r = await post('/api/machine/enroll', b);   // 不放 registrationKey
  record('① 不带注册密钥 → 拒绝（契约 §6.5 第 0 步：形状问题 → 400）', r, 400);
  // rk 缺失时配对码不该被消费
  const still = await post('/api/machine/enroll', { ...b, registrationKey: RK });
  console.log(`      └ 该配对码随后配好 rk 仍可用 → HTTP ${still.status}（201 = 缺 rk 那次没消费掉它）`);
}

// ② 带错 rk（格式合法但库里没有）
let wrongRkBody;
{
  const code = await newCode();
  const bogus = 'swrk_' + crypto.randomBytes(32).toString('base64url');
  const r = await post('/api/machine/enroll', { ...baseBody(code), registrationKey: bogus });
  record('② 带错注册密钥 → 401', r, 401);
  wrongRkBody = r.text;
}

// ③ 带已撤销的 rk
{
  // 现生成一把 → 立刻撤销 → 拿它 enroll
  const mk = await fetch(CLOUD_URL + '/api/registration-keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ label: 'to-be-revoked' }),
  });
  const rk2 = await mk.json();
  const rv = await fetch(`${CLOUD_URL}/api/registration-keys/${rk2.id}/revoke`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: '{}',
  });
  console.log(`      （已撤销一把新 rk：prefix=${rk2.keyPrefix} revoke→HTTP ${rv.status}）`);
  const code = await newCode();
  const r = await post('/api/machine/enroll', { ...baseBody(code), registrationKey: rk2.key });
  record('③ 带已撤销的注册密钥 → 401', r, 401);
  console.log(`      └ 与②「带错 rk」响应体逐字节相同：${r.text === wrongRkBody}`);
}

// ④ rk 对但 code 错 → 必须与 ②③ 不可区分
{
  const r = await post('/api/machine/enroll', { ...baseBody('ZZZZZZZZ'), registrationKey: RK });
  record('④ rk 正确但配对码错 → 401', r, 401);
  const same = r.text === wrongRkBody;
  console.log(`      └ 与②「带错 rk」响应体逐字节相同：${same}  ← 这条是 §6.5 的核心：不可区分`);
  results.push({ name: '④b rk错 与 code错 响应不可区分', pass: same, status: '-', expect: '逐字节相同' });
}

console.log('\n===== 汇总 =====');
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
