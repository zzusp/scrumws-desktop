#!/usr/bin/env node
// 云端 P0+P1 后端端到端自测（零依赖，node:http）。
//
//   node docs/acceptance/cloud-control-plane/scripts/verify-cloud-api.mjs \
//        --base http://127.0.0.1:8790 --key swuk_…
//
// 覆盖：登录 → 注册密钥 → 配对码 → enroll（含 4 种负例）→ 心跳 → upsert → digest → 看板查询。
// 重点断言（契约红线）：
//   · enroll 的 rk 失败与 code 失败返回**逐字节相同**的 401（消除 rk 有效性 oracle，§6.5）
//   · 注册密钥列表**永不**返回明文 / key_hash（§6.15）
//   · 配对码单次使用；已撤销 rk 一律 401（§6.16 / §6.5）
//   · history 能截断（不是 append-only，§6.9）
import http from 'node:http';
import https from 'node:https';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { base: { type: 'string', default: 'http://127.0.0.1:8790' }, key: { type: 'string' } } });
if (!values.key) { console.error('缺少 --key <swuk_…>（bootstrap 打印的登录密钥）'); process.exit(2); }
const BASE = values.base.replace(/\/+$/, '');

let cookie = null;
let pass = 0; let fail = 0;

function req(method, path, { body, token, noCookie } = {}) {
  const url = new URL(BASE + path);
  const mod = url.protocol === 'https:' ? https : http;
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = {};
  if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie && !noCookie) headers.cookie = cookie;
  return new Promise((resolve, reject) => {
    const r = mod.request(url, { method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 照常返回 text */ }
        resolve({ status: res.statusCode, json, text, setCookie: sc });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const uuid = () => crypto.randomUUID();

async function main() {
  console.log(`\n=== 云端 P0+P1 后端自测 @ ${BASE} ===\n`);

  console.log('[健康 / 登录]');
  const health = await req('GET', '/api/health');
  check('GET /api/health → 200', health.status === 200, `got ${health.status}`);

  const badLogin = await req('POST', '/api/auth/login', { body: { key: 'swuk_' + 'x'.repeat(43) } });
  check('登录密钥错 → 401 UNAUTHORIZED', badLogin.status === 401 && badLogin.json?.error?.code === 'UNAUTHORIZED', `got ${badLogin.status} ${badLogin.text}`);

  const login = await req('POST', '/api/auth/login', { body: { key: values.key } });
  check('登录成功 → 200 + user/workspace', login.status === 200 && !!login.json?.user?.id && !!login.json?.workspace?.id, `got ${login.status} ${login.text}`);
  const sc = (login.setCookie || [])[0] || '';
  check('Set-Cookie 带 HttpOnly + Secure + SameSite=Lax', /HttpOnly/i.test(sc) && /Secure/i.test(sc) && /SameSite=Lax/i.test(sc), sc);
  cookie = sc.split(';')[0];

  const me = await req('GET', '/api/auth/me');
  check('GET /api/auth/me → 200', me.status === 200 && me.json?.user?.id === login.json.user.id, `got ${me.status}`);
  const noAuth = await req('GET', '/api/auth/me', { noCookie: true });
  check('无 cookie 的 /api/auth/me → 401', noAuth.status === 401, `got ${noAuth.status}`);

  console.log('\n[注册密钥 swrk_]');
  const rkRes = await req('POST', '/api/registration-keys', { body: { label: '自测' } });
  const rk = rkRes.json?.key;
  check('生成注册密钥 → 201 + 明文只此一次', rkRes.status === 201 && typeof rk === 'string' && rk.startsWith('swrk_') && rk.length === 48, `got ${rkRes.status} ${rkRes.text}`);

  const rkList = await req('GET', '/api/registration-keys');
  const listRaw = rkList.text;
  check('列出注册密钥 → 200', rkList.status === 200 && Array.isArray(rkList.json?.keys), `got ${rkList.status}`);
  check('列表**不含**明文 key', !listRaw.includes(rk), '响应体里出现了明文！');
  check('列表**不含** key_hash 字段', !/key_hash|keyHash/.test(listRaw), '响应体里出现了 hash！');
  check('列表含 keyPrefix / lastUsedAt（轮换依据）', rkList.json.keys.some((k) => k.keyPrefix?.startsWith('swrk_') && 'lastUsedAt' in k));

  console.log('\n[配对码]');
  const codeRes = await req('POST', '/api/machines/enrollment-codes', { body: {} });
  const code = codeRes.json?.code;
  check('生成配对码 → 201 + 8 位 + ttl 600', codeRes.status === 201 && /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(code || '') && codeRes.json.ttlSec === 600, `got ${codeRes.status} ${codeRes.text}`);

  console.log('\n[enroll 负例 —— 401 必须逐字节相同]');
  const machineUid = uuid();
  const baseBody = { machineUid, hostname: 'SELFTEST-PC', platform: 'win32', arch: 'x64', appVersion: '0.1.0', claudeVersion: '2.1.207' };

  const noRk = await req('POST', '/api/machine/enroll', { body: { ...baseBody, code } });
  check('缺 registrationKey → 400 BAD_REQUEST（形状问题，与凭据内容无关）', noRk.status === 400 && noRk.json?.error?.code === 'BAD_REQUEST', `got ${noRk.status} ${noRk.text}`);

  const badRk = await req('POST', '/api/machine/enroll', { body: { ...baseBody, registrationKey: 'swrk_' + 'x'.repeat(43), code } });
  check('注册密钥无效 → 401', badRk.status === 401, `got ${badRk.status}`);
  const bodyA = badRk.text;

  const wrongPrefix = await req('POST', '/api/machine/enroll', { body: { ...baseBody, registrationKey: 'swmt_' + 'x'.repeat(43), code } });
  check('拿 swmt_ 冒充 swrk_ → 401（前缀不匹配，连库都不查）', wrongPrefix.status === 401, `got ${wrongPrefix.status}`);
  check('  ↳ 与「注册密钥无效」逐字节相同', wrongPrefix.text === bodyA);

  const goodRkBadCode = await req('POST', '/api/machine/enroll', { body: { ...baseBody, registrationKey: rk, code: 'ZZZZZZZZ' } });
  check('★ 注册密钥对但配对码错 → 401', goodRkBadCode.status === 401, `got ${goodRkBadCode.status}`);
  check('★ ↳ 与「注册密钥无效」**逐字节相同**（消除 rk 有效性 oracle）', goodRkBadCode.text === bodyA, `A=${bodyA} B=${goodRkBadCode.text}`);

  // 已撤销的 rk：另生成一把 → 撤销 → 拿它 enroll
  const rk2Res = await req('POST', '/api/registration-keys', { body: { label: '自测-待撤销' } });
  const rk2 = rk2Res.json.key;
  const rev = await req('POST', `/api/registration-keys/${rk2Res.json.id}/revoke`, { body: {} });
  check('撤销注册密钥 → 200 ok', rev.status === 200 && rev.json?.ok === true && !!rev.json.revokedAt, `got ${rev.status} ${rev.text}`);
  const rev2 = await req('POST', `/api/registration-keys/${rk2Res.json.id}/revoke`, { body: {} });
  check('重复撤销 → 幂等（revokedAt 不变）', rev2.status === 200 && rev2.json.revokedAt === rev.json.revokedAt);
  const revokedRk = await req('POST', '/api/machine/enroll', { body: { ...baseBody, registrationKey: rk2, code } });
  check('已撤销的注册密钥 → 401', revokedRk.status === 401, `got ${revokedRk.status}`);
  check('  ↳ 与「注册密钥无效」逐字节相同', revokedRk.text === bodyA);
  const revNotFound = await req('POST', `/api/registration-keys/${uuid()}/revoke`, { body: {} });
  check('撤销不存在的注册密钥 → 404', revNotFound.status === 404, `got ${revNotFound.status}`);

  console.log('\n[enroll 正例]');
  const enroll = await req('POST', '/api/machine/enroll', { body: { ...baseBody, registrationKey: rk, code, displayName: '自测机' } });
  const token = enroll.json?.token;
  check('enroll → 201 + swmt_ 令牌', enroll.status === 201 && typeof token === 'string' && token.startsWith('swmt_') && token.length === 48, `got ${enroll.status} ${enroll.text}`);
  check('enroll 返回 machineId / workspaceName / displayName', !!enroll.json.machineId && !!enroll.json.workspaceName && enroll.json.displayName === '自测机');
  const machineId = enroll.json?.machineId;

  const reuse = await req('POST', '/api/machine/enroll', { body: { ...baseBody, registrationKey: rk, code } });
  check('配对码单次使用：重放同一个码 → 401', reuse.status === 401, `got ${reuse.status}`);
  check('  ↳ 与「注册密钥无效」逐字节相同', reuse.text === bodyA);

  const rkList2 = await req('GET', '/api/registration-keys');
  const used = rkList2.json.keys.find((k) => k.keyPrefix === rk.slice(0, 9));
  check('enroll 后 rk 的 lastUsedAt 前进（轮换依据）', !!used?.lastUsedAt, JSON.stringify(used));

  console.log('\n[心跳]');
  const badToken = await req('POST', '/api/machine/heartbeat', { token: 'swmt_' + 'x'.repeat(43), body: { appVersion: '0.1.0', load: { processing: 0, queued: 0, cap: 5 } } });
  check('机器令牌无效 → 401', badToken.status === 401, `got ${badToken.status}`);
  const noToken = await req('POST', '/api/machine/heartbeat', { body: { appVersion: '0.1.0', load: { processing: 0, queued: 0, cap: 5 } } });
  check('无 Bearer → 401（会话 cookie 不能当机器令牌用）', noToken.status === 401, `got ${noToken.status}`);

  const hb = await req('POST', '/api/machine/heartbeat', { token, body: { claudeVersion: '2.1.207', appVersion: '0.1.0', load: { processing: 2, queued: 1, cap: 5 } } });
  check('心跳 → 200 + serverTime/machineId', hb.status === 200 && !!hb.json?.serverTime && hb.json.machineId === machineId, `got ${hb.status} ${hb.text}`);

  console.log('\n[上行 upsert]');
  const keyA = 'manual:20260716132301-482';
  const keyB = 'cli:9c2f1a2b';
  const taskA = {
    taskKey: keyA,
    rev: 'a'.repeat(40),
    spec: {
      title: '修复看板卡片排序', prompt: '把 done 桶按 resolvedAt 倒序'.repeat(3), model: 'claude-opus-4-8',
      effort: 'xhigh', cwd: 'D:\\project\\scrumws-desktop', worktree: false, baseBranch: null,
      description: null, scheduledAt: null, source: 'manual', createdAt: '2026-07-16T05:23:01.000Z',
    },
    status: {
      state: 'processing', outcome: null, enteredAt: '2026-07-16T05:23:01.000Z', resolvedAt: null,
      sessionId: '9c2f0000-0000-4000-8000-000000000001', rounds: 3, numTurns: 12, totalCostUsd: 0.421337,
      usage: { input_tokens: 1234, output_tokens: 567, cache_read_input_tokens: 89, cache_creation_input_tokens: 0 },
      gitBranch: null, worktreeBranch: 'worktree-foo', backgroundTaskCount: 0, isArchive: false,
      lastActivityAt: '2026-07-16T05:25:11.000Z',
    },
    history: [
      { seq: 0, state: 'queued', at: '2026-07-16T05:23:01.000Z', by: 'create:manual' },
      { seq: 1, state: 'processing', at: '2026-07-16T05:23:02.000Z', by: 'session' },
      { seq: 2, state: 'awaiting-human', at: '2026-07-16T05:24:02.000Z', by: null },
    ],
  };
  const taskB = {
    taskKey: keyB, rev: 'b'.repeat(40),
    spec: { title: 'CLI 观察态会话', prompt: null, model: null, effort: null, cwd: null, worktree: null, baseBranch: null, description: null, scheduledAt: null, source: 'cli', createdAt: null },
    status: { state: 'done', outcome: 'success', enteredAt: null, resolvedAt: '2026-07-16T06:00:00.000Z', sessionId: null, rounds: 1, numTurns: 2, totalCostUsd: 0.01, usage: null, gitBranch: 'main', worktreeBranch: null, backgroundTaskCount: 0, isArchive: true, lastActivityAt: '2026-07-16T06:00:00.000Z' },
    history: [],
  };

  const up = await req('POST', '/api/machine/tasks/upsert', { token, body: { tasks: [taskA, taskB] } });
  check('upsert 2 条 → 200 accepted=2', up.status === 200 && up.json?.accepted === 2 && up.json.results.every((r) => r.ok), `got ${up.status} ${up.text}`);

  const upNoAuth = await req('POST', '/api/machine/tasks/upsert', { body: { tasks: [taskA] } });
  check('upsert 无机器令牌 → 401（人类会话写不了 task_status）', upNoAuth.status === 401, `got ${upNoAuth.status}`);

  const over = await req('POST', '/api/machine/tasks/upsert', { token, body: { tasks: Array.from({ length: 51 }, () => taskA) } });
  check('upsert 51 条 → 400（上限 50/批）', over.status === 400 && over.json?.error?.code === 'BAD_REQUEST', `got ${over.status}`);

  console.log('\n[看板查询]');
  // ⚠ 一律带 machineId 作用域：本脚本要能在**已有数据的库上反复跑**，
  //   断言全局 total 会让它只在空库上绿一次（下一轮就是假红）。
  const mine = `machineId=${machineId}`;
  const tasks = await req('GET', `/api/tasks?${mine}`);
  check('GET /api/tasks → 200 + 本机 total=2', tasks.status === 200 && tasks.json?.total === 2, `got ${tasks.status} ${tasks.text?.slice(0, 200)}`);
  const rowA = tasks.json.tasks.find((t) => t.localTaskKey === keyA);
  check('卡片字段齐（machine/origin/source/status.mirror）', rowA?.machine?.displayName === '自测机' && rowA.origin === 'local' && rowA.source === 'manual' && rowA.status.mirror === 'live', JSON.stringify(rowA));
  check('totalCostUsd 是数字（numeric 列没漏成字符串）', typeof rowA?.status?.totalCostUsd === 'number' && Math.abs(rowA.status.totalCostUsd - 0.421337) < 1e-9, `got ${JSON.stringify(rowA?.status?.totalCostUsd)}`);
  check('排序 last_activity_at desc nulls last', tasks.json.tasks[0].localTaskKey === keyB, tasks.json.tasks.map((t) => t.localTaskKey).join(','));

  const filtered = await req('GET', `/api/tasks?state=processing&${mine}&mirror=live`);
  check('筛选 state/machineId/mirror', filtered.status === 200 && filtered.json.tasks.every((t) => t.status.state === 'processing'), `got ${filtered.status} ${filtered.text?.slice(0, 200)}`);
  const searched = await req('GET', `/api/tasks?${mine}&q=` + encodeURIComponent('看板卡片'));
  check('q 命中 title（ILIKE）', searched.json?.tasks?.some((t) => t.localTaskKey === keyA), searched.text?.slice(0, 200));
  const searchedMiss = await req('GET', `/api/tasks?${mine}&q=` + encodeURIComponent('%'));
  check('q 里的 % 被转义（不当通配）', searchedMiss.json?.total === 0, `total=${searchedMiss.json?.total}`);

  const detail = await req('GET', `/api/tasks/${rowA.id}`);
  check('GET /api/tasks/:id → prompt 全文 + usage + history', detail.status === 200 && detail.json.prompt?.length > 10 && detail.json.status.usage?.input_tokens === 1234 && detail.json.history.length === 3, `got ${detail.status} ${detail.text?.slice(0, 300)}`);
  check('history 按 seq 升序、by 可空', detail.json.history[0].seq === 0 && detail.json.history[2].by === null, JSON.stringify(detail.json.history));
  const detail404 = await req('GET', `/api/tasks/${uuid()}`);
  check('不存在的任务 → 404 NOT_FOUND', detail404.status === 404 && detail404.json?.error?.code === 'NOT_FOUND', `got ${detail404.status}`);

  console.log('\n[history 截断 —— 不能只 append]');
  const shrunk = { ...taskA, rev: 'c'.repeat(40), history: taskA.history.slice(0, 1) };
  const up2 = await req('POST', '/api/machine/tasks/upsert', { token, body: { tasks: [shrunk] } });
  check('重推 history 变短 → 200', up2.status === 200 && up2.json.accepted === 1, up2.text);
  const detail2 = await req('GET', `/api/tasks/${rowA.id}`);
  check('★ 云端 history 跟着截断到 1 条（无幽灵历史）', detail2.json.history.length === 1, `got ${detail2.json.history.length} 条`);
  check('幂等：同 taskKey 重推不新增行', detail2.json.id === rowA.id);

  console.log('\n[digest 全量对账]');
  const d1 = await req('POST', '/api/machine/tasks/digest', { token, body: { tasks: [{ taskKey: keyA, rev: 'c'.repeat(40) }, { taskKey: keyB, rev: 'b'.repeat(40) }] } });
  check('rev 全对上 → needFull 空、markedMissing 0', d1.status === 200 && d1.json.needFull.length === 0 && d1.json.markedMissing === 0, JSON.stringify(d1.json));

  const d2 = await req('POST', '/api/machine/tasks/digest', { token, body: { tasks: [{ taskKey: keyA, rev: 'deadbeef' }, { taskKey: 'manual:nonexistent', rev: 'x' }] } });
  check('rev 对不上 / 云端没有 → 进 needFull', d2.json.needFull.includes(keyA) && d2.json.needFull.includes('manual:nonexistent'), JSON.stringify(d2.json));
  check('★ 云端有、本地没有 → 标 local_missing（不删行、不动 state）', d2.json.markedMissing === 1, JSON.stringify(d2.json));

  const missTask = await req('GET', `/api/tasks?${mine}&mirror=local_missing`);
  check('  ↳ local_missing 可筛出，state 未被改动', missTask.json.tasks.length === 1 && missTask.json.tasks[0].localTaskKey === keyB && missTask.json.tasks[0].status.state === 'done', JSON.stringify(missTask.json.tasks[0]?.status));

  const d3 = await req('POST', '/api/machine/tasks/digest', { token, body: { tasks: [{ taskKey: keyA, rev: 'c'.repeat(40) }, { taskKey: keyB, rev: 'b'.repeat(40) }] } });
  check('本地又出现 → mirror 复位 live', d3.json.markedMissing === 0);
  const relived = await req('GET', `/api/tasks?${mine}&mirror=live`);
  check('  ↳ 两条都回到 live', relived.json.total === 2, `total=${relived.json.total}`);

  console.log('\n[机器列表]');
  const machines = await req('GET', '/api/machines');
  const me2 = machines.json?.machines?.find((m) => m.id === machineId);
  check('GET /api/machines → 200 + 本机在列', machines.status === 200 && !!me2, `got ${machines.status}`);
  check('status=online + load 快照 + owner', me2?.status === 'online' && me2.load.processing === 2 && me2.load.queued === 1 && me2.load.cap === 5 && !!me2.owner?.name, JSON.stringify(me2));
  check('★ taskCounts 按看板 6 桶（归档任务算 archived 不算 done）', me2?.taskCounts?.processing === 1 && me2.taskCounts.archived === 1 && me2.taskCounts.done === 0, JSON.stringify(me2?.taskCounts));

  console.log('\n[撤销机器 = 踢下线]');
  const mrev = await req('POST', `/api/machines/${machineId}/revoke`, { body: {} });
  check('撤销机器 → 200 ok', mrev.status === 200 && mrev.json.ok === true, mrev.text);
  const hbAfter = await req('POST', '/api/machine/heartbeat', { token, body: { appVersion: '0.1.0', load: { processing: 0, queued: 0, cap: 5 } } });
  check('★ 撤销后心跳 → 401（本地据此终局解绑）', hbAfter.status === 401, `got ${hbAfter.status}`);
  const afterList = await req('GET', '/api/machines');
  check('默认隐藏已撤销机器', !afterList.json.machines.some((m) => m.id === machineId));
  const afterList2 = await req('GET', '/api/machines?includeRevoked=1');
  check('?includeRevoked=1 才带上', afterList2.json.machines.some((m) => m.id === machineId));
  const tasksAfter = await req('GET', `/api/tasks?${mine}`);
  check('★ 撤销机器不删任务数据（历史仍可看）', tasksAfter.json.total === 2, `total=${tasksAfter.json.total}`);

  console.log('\n[登出]');
  const logout = await req('POST', '/api/auth/logout', { body: {} });
  check('登出 → 200', logout.status === 200);
  const meAfter = await req('GET', '/api/auth/me');
  check('登出后会话失效 → 401', meAfter.status === 401, `got ${meAfter.status}`);

  console.log(`\n=== 结果：PASS ${pass} / FAIL ${fail} ===\n`);
  return fail === 0 ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error('自测脚本异常：', e); process.exit(1); });
