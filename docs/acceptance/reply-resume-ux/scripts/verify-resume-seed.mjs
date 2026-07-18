// 真实驱动 reply --resume 的 seed 路径：起真 Mode B 会话跑一轮 → 关掉(模拟取消) →
// readCcSessionForAdopt 读回历史 → ccMessagesToModeBSeed + reply 回显 → resume 会话，
// 断言 resume 会话 transcript 立即含完整历史 + 回显（= SSE 回放给详情的内容 → 历史可见）。
// 运行：node docs/acceptance/reply-resume-ux/scripts/verify-resume-seed.mjs（仓库根执行；需本机可用 claude）
import { createSession, getSession, closeSession } from '../../../../platform/lib/session-manager.js';
import { readCcSessionForAdopt, ccMessagesToModeBSeed } from '../../../../platform/lib/logs.js';

const cwd = process.cwd();
const MODEL = 'claude-haiku-4-5-20251001';

function waitFor(id, pred, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = getSession(id);
    const to = setTimeout(() => { s.emitter.off('event', h); reject(new Error('timeout waiting event')); }, timeoutMs);
    const h = (ev) => { if (pred(ev)) { clearTimeout(to); s.emitter.off('event', h); resolve(ev); } };
    s.emitter.on('event', h);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 起真实 Mode B 会话，跑一轮（首轮 = queued/startTask 语义）
const r1 = createSession({ cwd, model: MODEL, prompt: '只回复"第一轮完成"这五个字，别做任何工具调用', bypass: true });
if (!r1.ok) { console.error('createSession1 失败:', r1.error); process.exit(1); }
console.log('会话1 id:', r1.id);
await waitFor(r1.id, (ev) => ev.type === 'turn_completed', 120000);
const sid = getSession(r1.id).sessionId;
const round1msgs = getSession(r1.id).transcript.filter((e) => e.type === 'message');
console.log('claudeSessionId:', sid, '| round1 消息数:', round1msgs.length);

// 2) 关会话（模拟用户取消 cancelTaskSession → 进程死）
closeSession(r1.id);
await sleep(2500);
console.log('会话1 已关闭（模拟取消），state:', getSession(r1.id)?.state);

// 3) reply resume 路径的读取器读回历史
const hist = readCcSessionForAdopt(sid);
console.log('readCcSessionForAdopt.ok:', hist.ok, '| 历史消息数:', hist.messages?.length);
if (!hist.ok) { console.error('FAIL: 历史读回失败:', hist.error); process.exit(1); }

// 4) seed 只放历史；reply 由 createSession→sendUserMessage 统一记录，避免重复。
const seed = ccMessagesToModeBSeed(hist.messages);
console.log('seed 历史长度:', seed.length);

// 5) resume 会话，验证 transcript 立即含历史（不等 claude 响应，这就是 SSE 一连上回放给详情的内容）
const r2 = createSession({ cwd, model: MODEL, resume: sid, prompt: '继续', seedTranscript: seed, bypass: true });
if (!r2.ok) { console.error('createSession2(resume) 失败:', r2.error); process.exit(1); }
const tr = getSession(r2.id).transcript;
const last = tr.at(-1);
const echoOk = last?.type === 'message' && last.message?.role === 'user' && JSON.stringify(last.message?.content || '').includes('继续');
const historyOk = tr.length >= seed.length + 1 && tr.slice(0, seed.length).some((e) => e.type === 'message' && e.message?.role === 'assistant');
console.log('resume 会话 transcript 长度:', tr.length, '| >= seed+1:', tr.length >= seed.length + 1);
console.log('含历史 assistant 消息:', historyOk, '| 末条=reply回显"继续":', echoOk);
console.log('sessionId 立即回填:', getSession(r2.id).sessionId === sid);

closeSession(r2.id);
await sleep(500);

if (historyOk && echoOk && tr.length >= seed.length + 1) {
  console.log('\n✅ PASS：resume 会话 transcript = 完整历史 + reply 回显 → 详情连 live 即回放全部（问题2 修复）');
  process.exit(0);
} else {
  console.log('\n❌ FAIL：seed 未按预期生效');
  process.exit(1);
}
