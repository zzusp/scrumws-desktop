// 云端验收前置：bootstrap 用户 → 登录拿会话 → 生成 swrk_ → 生成配对码。
// 明文凭据只写 scratchpad（仓库外），绝不进仓库 / 日志 / 文档。
//
// 用法：node setup-cloud-fixture.mjs <cloudUrl> <outDir>
//   outDir 里产出：cookies.txt（curl 格式 cookie jar）、rk.txt、code.txt、swuk.txt
// 前置：DATABASE_URL 已指向验收库，且 bootstrap 已跑过（本脚本只登录，不建人）。
import fs from 'node:fs';
import path from 'node:path';

const [, , CLOUD, OUT] = process.argv;
if (!CLOUD || !OUT) throw new Error('用法：node setup-cloud-fixture.mjs <cloudUrl> <outDir>');
fs.mkdirSync(OUT, { recursive: true });

const swuk = fs.readFileSync(path.join(OUT, 'swuk.txt'), 'utf8').trim();

// 1. 登录
const login = await fetch(CLOUD + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: swuk }),
});
if (login.status !== 200) throw new Error('登录失败 HTTP ' + login.status + ' ' + await login.text());
const setCookie = login.headers.get('set-cookie') || '';
const m = /swsession=([^;]+)/.exec(setCookie);
if (!m) throw new Error('登录响应没有 swsession cookie');
const sess = m[1];
// 写成 curl 的 Netscape cookie jar（其它脚本共用）
fs.writeFileSync(path.join(OUT, 'cookies.txt'),
  `# Netscape HTTP Cookie File\n127.0.0.1\tFALSE\t/\tFALSE\t0\tswsession\t${sess}\n`);
const who = await login.json();
console.log(`登录成功：user=${who.user.name} workspace=${who.workspace.name}`);

const cookie = `swsession=${sess}`;
const post = async (p, body) => {
  const r = await fetch(CLOUD + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};

// 2. 注册密钥（明文只此一次）
const rk = await post('/api/registration-keys', { label: 'P1 验收' });
if (rk.status !== 201) throw new Error('生成 rk 失败 HTTP ' + rk.status);
fs.writeFileSync(path.join(OUT, 'rk.txt'), rk.json.key);
console.log(`注册密钥：prefix=${rk.json.keyPrefix} 长度=${rk.json.key.length}（明文只落 scratchpad）`);

// 3. 配对码（10min TTL，单次使用）
const code = await post('/api/machines/enrollment-codes', {});
if (code.status !== 201) throw new Error('生成配对码失败 HTTP ' + code.status);
fs.writeFileSync(path.join(OUT, 'code.txt'), code.json.code);
console.log(`配对码：${code.json.code}  expiresAt=${code.json.expiresAt} ttl=${code.json.ttlSec}s`);
