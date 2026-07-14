// 端到端：真 claude 驱动「退回 plan → 编辑 → 再执行续对话」全链路。
// 第 1 轮让 claude 记住一个数字；退回 plan；编辑 prompt 改成「刚让你记的数字是多少」；再执行（走 startTask
// 的 resume 分支）；断言答复里含该数字 = 确实 --resume 续上了之前的对话，而非从头新起。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SANDBOX = path.join(os.tmpdir(), `replan-e2e-${Date.now()}`);
process.env.SCRUMWS_DATA_ROOT = SANDBOX;
fs.mkdirSync(path.join(SANDBOX, 'runtime', 'runner-state'), { recursive: true });

const here = path.dirname(fileURLToPath(import.meta.url));
const platform = (f) => pathToFileURL(path.join(here, '../../../../platform/lib/', f)).href;
const { createTask, moveTaskToPlan, editTask, restartTask } = await import(platform('task-actions.js'));
const { startTask, getTaskSessionId } = await import(platform('task-runner.js'));
const { getSession } = await import(platform('session-manager.js'));

const MODEL = 'claude-haiku-4-5-20251001';
const NUMBER = '4271';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runnerRoot = path.join(SANDBOX, 'runtime', 'runner-state');
const readState = (safeKey) => { try { return JSON.parse(fs.readFileSync(path.join(runnerRoot, safeKey, 'state.json'), 'utf8')); } catch { return null; } };
const readMeta = (safeKey) => { try { return JSON.parse(fs.readFileSync(path.join(runnerRoot, safeKey, 'meta.json'), 'utf8')); } catch { return null; } };

// 收集某 Mode B 会话的 assistant 文本，result 事件到达即 resolve
function waitRound(sessionUiId, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const s = getSession(sessionUiId);
    if (!s) return reject(new Error('session not found: ' + sessionUiId));
    let text = '';
    const to = setTimeout(() => { s.emitter.off('event', on); reject(new Error('round timeout')); }, timeoutMs);
    const on = (ev) => {
      if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const c of ev.message.content) if (c?.type === 'text' && c.text) text += c.text + '\n';
      } else if (ev.type === 'result') {
        clearTimeout(to); s.emitter.off('event', on); resolve(text.trim());
      } else if (ev.type === 'error') {
        clearTimeout(to); s.emitter.off('event', on); reject(new Error('session error: ' + ev.error));
      }
    };
    s.emitter.on('event', on);
  });
}
async function waitState(safeKey, want, timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (readState(safeKey)?.state === want) return true;
    await sleep(1000);
  }
  throw new Error(`等 state=${want} 超时（当前 ${readState(safeKey)?.state}）`);
}

let fail = 0;
const assert = (cond, name, extra = '') => { console.log(`  ${cond ? '✅' : '❌'} ${name} ${cond ? '' : extra}`); if (!cond) fail++; };

try {
  // ---- 第 1 轮：记住数字 ----
  console.log('\n[1] 建 plan 任务 + 确认执行第 1 轮（记住数字）');
  const c = createTask({ source: 'manual', title: 'replan-e2e', model: MODEL, plan: true,
    prompt: `请牢牢记住这个暗号数字：${NUMBER}。现在只需回复「记住了」两个字，不要复述数字。` });
  if (!c.ok) throw new Error('createTask 失败: ' + c.error);
  const taskKey = c.taskKey;
  const safeKey = taskKey.replace(/:/g, '__');
  console.log('    taskKey =', taskKey);
  const a1 = restartTask({ taskKey, approve: true });
  if (!a1.ok || !a1.spawned) throw new Error('approve/spawn 失败: ' + JSON.stringify(a1));
  assert(a1.resumed === undefined, '第 1 轮是全新会话（无 resume）', JSON.stringify(a1));
  const r1 = await waitRound(a1.sessionUiId);
  console.log('    round1 答复:', JSON.stringify(r1.slice(0, 80)));
  await waitState(safeKey, 'awaiting-human');
  const sid1 = readMeta(safeKey)?.sessionId;
  assert(!!sid1, '第 1 轮落 meta.sessionId', JSON.stringify(readMeta(safeKey)));

  // ---- 退回计划 ----
  console.log('\n[2] moveTaskToPlan 退回计划');
  const mp = moveTaskToPlan({ taskKey });
  assert(mp.ok && readState(safeKey)?.state === 'plan', '退回 plan 成功', JSON.stringify(mp));
  assert(readMeta(safeKey)?.sessionId === sid1, 'meta.sessionId 保留', readMeta(safeKey)?.sessionId);
  // 等空转会话彻底关闭，避免第 2 轮 startTask 撞「已有活跃会话」
  for (let i = 0; i < 15 && getTaskSessionId(taskKey); i++) await sleep(500);
  assert(!getTaskSessionId(taskKey), '空转会话已关闭', 'still alive');

  // ---- 编辑 prompt：问刚才的数字 ----
  console.log('\n[3] 编辑 plan 任务的 prompt（问刚才记的数字）');
  const e = editTask({ taskKey, title: 'replan-e2e', model: MODEL,
    prompt: '我刚才让你记住的那个暗号数字是多少？请只回复那串数字本身。' });
  assert(e.ok, 'editTask 成功', JSON.stringify(e));

  // ---- 第 2 轮：确认执行 → 应走 resume 续对话 ----
  console.log('\n[4] 再次确认执行（应 --resume 续上第 1 轮对话）');
  const a2 = restartTask({ taskKey, approve: true });
  if (!a2.ok || !a2.spawned) throw new Error('第 2 轮 approve/spawn 失败: ' + JSON.stringify(a2));
  // resume 分支才会把会话 claudeSessionId 预置为被 --resume 的 sid（session-manager seedTranscript 分支）
  const cs2 = getSession(a2.sessionUiId)?.info()?.claudeSessionId;
  assert(cs2 === sid1, '第 2 轮走 resume 分支（会话 claudeSessionId=第1轮sid）', `${cs2} vs ${sid1}`);
  const r2 = await waitRound(a2.sessionUiId);
  console.log('    round2 答复:', JSON.stringify(r2.slice(0, 120)));
  assert(r2.includes(NUMBER), `答复含暗号 ${NUMBER} = 确实续上了之前的对话`, JSON.stringify(r2));

  // 收尾：关掉可能仍活的会话
  const live = getTaskSessionId(taskKey);
  if (live) { const s = getSession(live); try { s?.child?.kill(); } catch {} }
} catch (e) {
  console.log('  ❌ 异常:', e.message);
  fail++;
} finally {
  await sleep(500);
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
}

console.log(`\n==== ${fail === 0 ? '✅ E2E PASS' : '❌ E2E FAIL'} : ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
