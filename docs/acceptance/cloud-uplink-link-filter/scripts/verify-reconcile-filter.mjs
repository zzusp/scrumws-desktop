// 决策 14 对账过滤验证：桌面 connector 只上行「带 cloud link」的任务。
//
// 手法：沙箱 SCRUMWS_DATA_ROOT + 一个记录请求体的 mock cloud（node:http），
// 直接驱动真实 reconcileOnce()，核对它发给 /api/machine/tasks/{digest,upsert} 的 body。
// 零外部依赖、不碰真实云端 / 共享库 / 8799。
//
// 断言：
//   P1 有 link → 该任务上行；同一 snapshot 里的本地任务**不**出现在 digest / upsert（决策 14 主张）。
//   P2 移除 link → 下一轮对账把它摘掉：digest 集合空、无 upsert（证明是 link 在门控，非 no-op）。
//   全程本地任务 'manual:local-1' 从未出现在任何请求体（负对照，防「假绿」）。

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 沙箱数据根：务必在 import 平台模块之前设好（paths.js 在加载时读它） ──
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-filter-'));
process.env.SCRUMWS_DATA_ROOT = DATA_ROOT;

const LINKS_DIR = path.join(DATA_ROOT, 'runtime', 'cloud', 'links');
fs.mkdirSync(LINKS_DIR, { recursive: true });

const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1; };
const ok = (m) => console.log('PASS:', m);

// ── mock cloud：记录每次 upsert/digest 的 body ──
let captured = { digest: null, upsert: [] };
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    let out = {};
    if (req.url === '/api/machine/tasks/digest') { captured.digest = body; out = { needFull: [], markedMissing: 0 }; }
    else if (req.url === '/api/machine/tasks/upsert') { captured.upsert.push(body); out = { results: (body?.tasks || []).map((t) => ({ taskKey: t.taskKey, ok: true })) }; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});

const listen = () => new Promise((r) => server.listen(0, '127.0.0.1', r));

// snapshot 里两张卡：一张会被下发（linked），一张纯本地（local）。字段给足够 taskRev / buildUpload 用。
const card = (taskKey, state) => ({
  taskKey, safeTaskKey: taskKey.replace(/[:/]/g, '_'), title: taskKey, state,
  source: taskKey.split(':')[0], history: [], meta: {}, cli: {},
});
const snapshot = {
  lifecycle: {
    plan: [], processing: [card('cloud:linked-1', 'processing')],
    queued: [card('manual:local-1', 'queued')],
    done: [], awaitingHuman: [], archived: [],
  },
};

const keysIn = (body) => (body?.tasks || []).map((t) => t.taskKey).sort();
const everSawLocal = () =>
  [captured.digest, ...captured.upsert].some((b) => keysIn(b).includes('manual:local-1'));

await listen();
const target = { cloudUrl: `http://127.0.0.1:${server.address().port}`, token: 'swmt_test' };
const { reconcileOnce } = await import('../../../../platform/lib/cloud/reconcile.js');

try {
  // ── P1：linked 有 link 文件 ──
  fs.writeFileSync(path.join(LINKS_DIR, 'intent-abc.json'), JSON.stringify({ localTaskKey: 'cloud:linked-1' }));
  captured = { digest: null, upsert: [] };
  const r1 = await reconcileOnce(target, snapshot, { full: true });

  const up1 = captured.upsert.flatMap(keysIn);
  if (JSON.stringify(up1) === JSON.stringify(['cloud:linked-1'])) ok('P1 upsert 只含 linked 任务');
  else fail(`P1 upsert 应只含 cloud:linked-1，实得 ${JSON.stringify(up1)}`);

  if (JSON.stringify(keysIn(captured.digest)) === JSON.stringify(['cloud:linked-1'])) ok('P1 digest 只含 linked 任务');
  else fail(`P1 digest 应只含 cloud:linked-1，实得 ${JSON.stringify(keysIn(captured.digest))}`);

  if (r1.pushed === 1) ok('P1 pushed === 1'); else fail(`P1 pushed 应为 1，实得 ${r1.pushed}`);

  // ── P2：移除 link → 该任务应被摘掉（证明门控在 link，不是恒上行） ──
  fs.rmSync(path.join(LINKS_DIR, 'intent-abc.json'));
  captured = { digest: null, upsert: [] };
  const r2 = await reconcileOnce(target, snapshot, { full: true });

  if (keysIn(captured.digest).length === 0) ok('P2 无 link → digest 集合为空');
  else fail(`P2 digest 应为空，实得 ${JSON.stringify(keysIn(captured.digest))}`);

  if (captured.upsert.length === 0) ok('P2 无 link → 无 upsert 调用');
  else fail(`P2 不应有 upsert，实得 ${JSON.stringify(captured.upsert.flatMap(keysIn))}`);

  if (r2.pushed === 0) ok('P2 pushed === 0'); else fail(`P2 pushed 应为 0，实得 ${r2.pushed}`);

  // ── 负对照：本地任务全程不得外泄 ──
  if (!everSawLocal()) ok('负对照：manual:local-1 从未出现在任何请求体');
  else fail('负对照失败：本地任务被上行了');
} finally {
  server.close();
  fs.rmSync(DATA_ROOT, { recursive: true, force: true });
}

console.log(process.exitCode ? '\n=== 有用例 FAIL ===' : '\n=== 全部 PASS ===');
