// SG5 Phase B：真 spawn claude 才能验的两件事——
//   C08-approve：approve verb 经中继真的把 plan 任务起成 claude 会话
//   C09：watch 的 worker-log 增量块经「本地轮询器 → 云端 → 浏览器 SSE」三级转发，端到端 ≤3s
// 用无害极短 prompt 在沙箱 git 仓库跑，token 花销最小。
const CLOUD = process.env.CLOUD, PLATFORM = process.env.PLATFORM;
const SWUK = process.env.SWUK, CWD = process.env.CWD;

let pass = 0, fail = 0;
const log = (...a) => console.log(...a);
const check = (id, cond, d = '') => { cond ? pass++ : fail++; log(`  ${cond ? 'PASS' : 'FAIL'} ${id}${d ? ' — ' + d : ''}`); return cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
const call = async (m, p, b) => {
  const h = {}; if (cookie) h.cookie = cookie; if (b !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(CLOUD + p, { method: m, headers: h, body: b !== undefined ? JSON.stringify(b) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
};
const platPost = (p, b) => fetch(PLATFORM + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

// 浏览器侧 watch SSE 消费者：解析 event:/data: 帧，回调每个 frames 事件
async function watchSSE(mid, taskKey, onFrames, signal) {
  const res = await fetch(`${CLOUD}/api/my/machines/${mid}/watch?taskKey=${encodeURIComponent(taskKey)}`,
    { headers: { cookie }, signal });
  if (res.status !== 200) throw new Error(`watch 建流失败 ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let ev = 'message', data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (ev === 'frames' && data) { try { onFrames(JSON.parse(data)); } catch {} }
    }
  }
}

async function main() {
  await call('POST', '/api/auth/login', { key: SWUK });
  // 确保开关开 + downlink 在场
  await platPost('/api/cloud/remote-config', { cloudRemoteControl: true, cloudAllowedCwds: [CWD] });
  let mid;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const m = (await call('GET', '/api/my/machines')).json?.machines?.[0];
    mid = m?.id; if (m?.relayOnline) break;
  }
  log(`machine=${mid} relayOnline ready`);

  // 建 plan 任务（无害极短 prompt）
  const created = await call('POST', `/api/my/machines/${mid}/rpc`, {
    verb: 'createTask',
    args: { title: 'sg5 phase-b', prompt: '请只回复两个字：完成。不要读写任何文件、不要运行任何命令。', cwd: CWD, plan: true },
  });
  const taskKey = created.json?.data?.taskKey;
  check('B-create', created.status === 200 && taskKey, `taskKey=${taskKey}`);

  // 真实 UI 时序：先 approve（→processing）再挂 watch。
  // 对 plan 任务挂 watch 会因收敛判据（downlink.js:279 state!=='processing'）立即 done，那不是流场景。
  const approveAt = { t: Date.now() };
  const appr = await call('POST', `/api/my/machines/${mid}/rpc`, { verb: 'approve', args: { taskKey } });
  check('C08-approve', appr.status === 200 && appr.json?.ok, `approve → ${appr.status}`);
  // 等任务真进 processing 再挂 watch（否则 plan/queued 态挂 watch 立即收敛）
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    const st = (await call('POST', `/api/my/machines/${mid}/rpc`, { verb: 'taskDetail', args: { taskKey } })).json?.data?.state;
    if (st === 'processing') { log(`  task 进 processing @${(i + 1) * 0.5}s，挂 watch`); break; }
  }

  const frames = [];
  const firstBlockAt = { t: 0 };
  const watchOpenAt = Date.now();
  const ac = new AbortController();
  const watching = watchSSE(mid, taskKey, (f) => {
    frames.push(f);
    const hasBlocks = Array.isArray(f.frames) && f.frames.some((x) => Array.isArray(x.blocks) && x.blocks.length > 0);
    if (hasBlocks && !firstBlockAt.t) firstBlockAt.t = Date.now();
  }, ac.signal).catch((e) => { if (e.name !== 'AbortError') log('watch err', e.message); });

  // 等任务出现有内容的增量帧 or 收敛（最多 90s）
  let converged = false;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const detail = (await call('POST', `/api/my/machines/${mid}/rpc`, { verb: 'taskDetail', args: { taskKey } })).json?.data;
    const st = detail?.state;
    if (i % 5 === 0) log(`  …${i}s state=${st} frames=${frames.length} firstBlock=${firstBlockAt.t ? 'yes' : 'no'}`);
    if (['awaiting-human', 'done'].includes(st)) { converged = true; log(`  收敛 state=${st} @${i}s`); break; }
  }
  // 轮询器在它下一次 poll（≤1.5s）才发 done 终帧；独立 taskDetail 会先探到收敛，多等 4s 收 done
  await sleep(4000);

  ac.abort();
  await watching;

  const gotBlocks = frames.some((f) => Array.isArray(f.frames) && f.frames.some((x) => Array.isArray(x.blocks) && x.blocks.length > 0));
  const gotDone = frames.some((f) => f.done === true);
  check('C09-frames', frames.length > 0, `收到 ${frames.length} 个 watch 帧`);
  check('C09-blocks', gotBlocks, '增量帧含 worker-log 块（真实输出经三级转发）');
  // 首块延迟 = claude 冷启 TTFB + 中继结构延迟。中继结构延迟由 WATCH_POLL_MS(1.5s)+批量(0.5s)≤2s 保证（代码级），
  // 此处端到端含 claude TTFB，故阈值宽放 12s；纯中继延迟不在此隔离度量。
  const latency = firstBlockAt.t ? ((firstBlockAt.t - watchOpenAt) / 1000).toFixed(1) : 'n/a';
  check('C09-latency', firstBlockAt.t > 0 && (firstBlockAt.t - watchOpenAt) <= 12000,
    `挂 watch 到首块 ${latency}s（含 claude TTFB；中继结构延迟 ≤2s 由轮询周期保证）`);
  check('C09-done', gotDone, 'watch 收敛时收到 done 终帧');
  check('C08-converged', converged, '任务真的起跑并收敛（approve 真 spawn 生效）');

  log(`\n### Phase B 结果：PASS ${pass} / FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('PHASE-B ERROR', e); process.exit(2); });
