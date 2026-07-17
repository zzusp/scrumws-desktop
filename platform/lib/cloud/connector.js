import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getState, peekState } from '../collect.js';
import * as scheduler from '../scheduler.js';
import { readConfig } from '../runner-config.js';
import { createTask } from '../task-actions.js';
import { readIdentity, ensureMachineUid, saveIdentity, clearCloudBinding } from './identity.js';
import { readSynced } from './synced.js';
import { readLinks, writeLinks } from './links.js';
import { isCwdAllowed } from './cwd-allow.js';
import { computeAutoExec } from './gate.js';
import { appendCompletionProtocol } from './completion-protocol.js';
import { cloudRequest } from './http.js';
import { reconcileOnce } from './reconcile.js';
import { syncDownlink, stopDownlink, downlinkStatus } from './downlink.js';

// 云端 connector：纯出站（心跳 15s + 对账 15s + 意图下行 15s 同 tick + 全量 digest 每 5min）。
// · 只在持 scheduler.lock 的主实例起（server.js 与 usage timer 同位置），副实例「只看不调度」不重复上报
// · 云端不可达 → 记 lastError 静默退避到下一 tick，绝不影响本地看板
// · 全程只做 HTTP + 读写 JSON，不 spawn 任何进程

const TICK_MS = 15000;
const DIGEST_EVERY = 20;          // 每 20 tick 一次全量对账 = 5min

// 应用版本：随代码走（import.meta.dirname = platform/lib/cloud → 仓库根）
const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8')).version || null;
  } catch { return null; }
})();

let timer = null;
let tickN = 0;
let running = false;              // 上一轮未结束 → 本轮跳过（对齐 scheduler 的 IgnoreNew 语义）

let lastHeartbeatAt = null;
let lastHeartbeatOk = null;
let lastReconcileAt = null;
let lastIntentAt = null;              // 最近一次成功拉取意图的时刻（设置页排障用；绝不放凭据字段）
let lastHeartbeatPendingIntents = null;  // 心跳带回的待下发意图计数（取件门铃，§5.7b）；null=未知/心跳未成
let lastPushed = 0;
let lastError = null;

// 云端 URL 归一：去空白 + 去尾斜杠（'https://h:8790/' 与 'https://h:8790' 必须是同一个 base）
const normalizeUrl = (s) => String(s || '').trim().replace(/\/+$/, '');

// §7.4：401 = 令牌被撤销/无效 → **终局**，清身份 + 停上报，人重新贴 rk + 配对码才能回来
// （被踢下线的机器不该能自己爬回来，否则撤销就白撤了）。网络错误则是重试，两者绝不可混。
function onUnauthorized() {
  clearCloudBinding();
  stopConnector();
  lastHeartbeatOk = false;
  lastError = '已被云端解绑（令牌无效或已撤销），需重新连接';
}

async function heartbeat(target, snap) {
  const body = {
    claudeVersion: snap.runtime?.version ?? null,
    appVersion: APP_VERSION,
    load: {
      processing: snap.lifecycle.processing.length,
      queued: snap.lifecycle.queued.length,
      cap: snap.runnerConfig.maxConcurrentRunners,
    },
  };
  lastHeartbeatAt = new Date().toISOString();   // 最近一次心跳**尝试**：成败由 lastHeartbeatOk 说
  let r;
  try {
    r = await cloudRequest(target, 'POST', '/api/machine/heartbeat', body);
  } catch (e) {
    // 网络失败也是「心跳没成」。不置 false 的话，云端一挂设置页会一直挂着上次那个绿标
    lastHeartbeatOk = false;
    lastHeartbeatPendingIntents = null;    // 心跳没成 → 门铃计数作废，下一轮 pullIntents 兜底照拉
    lastError = `心跳失败：${e.message}`;
    return false;
  }
  if (r.status === 401) { onUnauthorized(); return false; }
  lastHeartbeatOk = r.status === 200;
  // 门铃：只信任成功心跳带回的数字；缺字段（老云端 / P1）→ null → 下一轮兜底照拉（§7.4 的 ?? 1）
  lastHeartbeatPendingIntents = lastHeartbeatOk && typeof r.json?.pendingIntents === 'number'
    ? r.json.pendingIntents : null;
  if (!lastHeartbeatOk) lastError = `心跳失败：HTTP ${r.status}${r.json?.error?.code ? ` ${r.json.error.code}` : ''}`;
  // 成功时不动 lastError：紧随其后的 reconcileOnce 会按本轮结果置/清它
  return lastHeartbeatOk;
}

// ---- 意图下行（契约 §7）----
// 云端只提供**输入**（cwd / autoRun / createdBy），**结论全在本地**：cwd 白名单 + 自动执行闸门。
// 任何把「跑不跑」的决定权挪到云端的改法都不许过（不变式 4）。

/** ack 回执：本地任务已建出来，把 taskKey 告诉云端。失败只记 lastError —— 下一轮凭 link 重 ack（§5.4 幂等）。 */
async function ackIntent(target, id, localTaskKey) {
  let r;
  try { r = await cloudRequest(target, 'POST', `/api/machine/intents/${id}/ack`, { localTaskKey }); }
  catch (e) { lastError = `ack 失败：${e.message}`; return; }
  if (r.status === 401) return onUnauthorized();
  if (r.status === 200) {
    const m = readLinks();
    if (m[id]) { m[id].ackedAt = new Date().toISOString(); writeLinks(m); }
    return;
  }
  if (r.status === 404) {
    // §5.2 竞态：意图已被云端取消删除 → 撤 link，本地任务成可见孤儿，主人自行中断 / 归档
    const m = readLinks(); delete m[id]; writeLinks(m);
    lastError = `意图 ${id} 已被云端取消，本地任务留作孤儿`;
    return;
  }
  // 409 等 → 本地任务已建，**不回滚**（回滚会造出「云端以为发过、本地什么都没有」的黑洞）；留给人看
  lastError = `ack 失败：HTTP ${r.status}`;
}

/** reject 拒收：本地防线挡下了这个意图。**不需要本地记账**——云端置 rejected 后就不在 pending 集合里；
 *  请求丢包 → 意图仍 pending → 下轮重新拉到 → 重新判定 → 再 reject。天然幂等（§5.5）。 */
async function rejectIntent(target, id, reason) {
  let r;
  try { r = await cloudRequest(target, 'POST', `/api/machine/intents/${id}/reject`, { reason: String(reason || '').slice(0, 500) }); }
  catch (e) { lastError = `reject 失败：${e.message}`; return; }
  if (r.status === 401) return onUnauthorized();
  if (r.status !== 200) lastError = `reject 失败：HTTP ${r.status}`;
}

/** 单个意图的处理（契约 §7.4 的 a–f）：幂等 → cwd 白名单 → 闸门 → 先占位 → createTask → 落 link → ack。 */
async function handleIntent(target, intent) {
  const id = String(intent?.intentId || '');
  if (!id) return;
  const links = readLinks();
  const link = links[id];

  // a. 幂等：已建过 → 直接重 ack（上一轮 ack 的响应丢了才会走到这），绝不建第二个任务
  if (link?.taskKey) return void await ackIntent(target, id, link.taskKey);
  // a'. 有占位但没 taskKey = 上一轮崩在 createTask 中途 → fail-closed，绝不重建第二个。
  //     宁可漏一个要人重发，不可多跑一个没人知道的（两个系统之间不存在 exactly-once）。
  if (link) return void await rejectIntent(target, id, '本地上次创建被中断（占位残留），请在云端重新下发');

  // b. cwd 白名单（§7.2）——唯一不依赖云端诚实的防线，放在最前。默认空 = 拒绝一切
  const cfg = readConfig();
  if (!isCwdAllowed(intent.cwd, cfg.cloudAllowedCwds)) {
    return void await rejectIntent(target, id, `工作目录不在本机白名单：${intent.cwd ?? '(空)'}`);
  }

  // c. 闸门（§7.2）：本地算，云端说了不算
  const autoExec = computeAutoExec({ intent, cfg, identity: readIdentity() });

  // d. 先占位：崩在 d–e 之间时，下一轮认得出来（走 a'），不会建出第二个任务
  const reservedAt = new Date().toISOString();
  writeLinks({ ...links, [id]: { taskKey: null, reservedAt } });

  // e. 同一条代码路径（README:43-47 的不变式）——不新写 runner，不碰 planSources（那是整来源一刀切，
  //    我们要的是逐任务）。source='cloud' 只是来源元数据，任务建出来后与其它来源逐字节同权。
  const r = createTask({
    source: 'cloud',
    title: intent.title,
    prompt: appendCompletionProtocol(intent.prompt),   // §8.3：创建者 compose prompt，不是按 source 分支
    cwd: intent.cwd,
    model: intent.model || undefined,                  // 空 → 机器自己的 defaultModel（task-actions.js:430）
    effort: intent.effort || undefined,
    description: intent.description || undefined,
    worktree: !!intent.worktree,
    baseBranch: intent.baseBranch || undefined,
    plan: !autoExec,                                   // ★ 闸门的唯一去处（planFirst，task-actions.js:466）
  });
  if (!r.ok) {
    const next = readLinks(); delete next[id]; writeLinks(next);   // 撤占位：这次没建出来，reject 是终局
    return void await rejectIntent(target, id, `本地建任务失败：${r.error}`);
  }
  // f. 落 link 再 ack（顺序不可换：先 ack 后落盘时，崩在中间会让下一轮重建第二个任务）
  writeLinks({ ...readLinks(), [id]: { taskKey: r.taskKey, reservedAt, createdAt: new Date().toISOString(), ackedAt: null } });
  await ackIntent(target, id, r.taskKey);
}

/** 拉取本机的待下发意图并逐条处理。网络错 / 401 / 503 / 其它非 200 → 记 lastError，下一 tick 重试。 */
async function pullIntents(target) {
  let r;
  try { r = await cloudRequest(target, 'GET', '/api/machine/intents'); }
  catch (e) { lastError = `拉取意图失败：${e.message}`; return; }
  if (r.status === 401) return onUnauthorized();                       // §7.4：401 是终局
  if (r.status === 503) { lastError = '云端未放行下行（CLOUD_ACCEPT_PLAINTEXT_DISPATCH 未设）'; return; }
  if (r.status !== 200) { lastError = `拉取意图失败：HTTP ${r.status}`; return; }
  for (const it of (r.json?.intents || [])) await handleIntent(target, it);
  lastIntentAt = new Date().toISOString();
}

async function tick() {
  if (running) return;
  const id = readIdentity();
  // 手机中继下行通道：随 cloudRemoteControl 热起停（默认 false = 零下行面），未 enroll 同样保持关闭
  try { syncDownlink(id); } catch { /* 下行通道故障不影响心跳/对账 */ }
  if (!id?.token || !id?.cloudUrl) return;   // 未 enroll → 空转（不扫描、不报错）
  running = true;
  const target = { cloudUrl: id.cloudUrl, token: id.token };
  try {
    // 关键：不自己触发扫描。UI 默认 15s 一轮 /api/state，这个窗口基本必然命中它那次扫描的缓存；
    // UI 关着时才由本 tick 触发（上报必需）。
    const snap = await getState({ maxAgeMs: TICK_MS });
    // 心跳在前：令牌被撤销时这里就终局解绑了，本轮不再对账。
    // 对账途中才被撤销（罕见）→ 记 errors，下一 tick 的心跳在 15s 内收口。
    if (!(await heartbeat(target, snap))) return;
    const r = await reconcileOnce(target, snap, { full: tickN % DIGEST_EVERY === 0 });
    lastReconcileAt = new Date().toISOString();
    lastPushed = r.pushed;
    lastError = r.errors.length ? r.errors[0] : null;
    // 意图下行放最后：处理意图抛错也不该影响上报；且 createTask 自己会立刻起会话，不靠本 tick 的后续步骤。
    // 复用这个 15s tick 而不另起定时器。门铃（§7.4）：心跳显式报 0 才跳过，未知（null）兜底照拉——
    // 少一次请求可以，漏一个意图不行。新建的任务下一轮（≤15s）才被对账报上去：本轮 snap 在 createTask
    // 之前取的，不为此强制重扫（「connector 不得自己触发扫描」是承重墙，实测 getState P50 112ms）。
    if ((lastHeartbeatPendingIntents ?? 1) > 0) await pullIntents(target);
  } catch (e) {
    lastError = e.message;   // 5xx / 超时 / DNS / ECONNREFUSED → 下一 tick 照常重试，不动 identity / synced
  } finally {
    running = false;
    tickN++;
  }
}

/**
 * 启动定时器。未 enroll → 空转不报错（tick 里读不到 token 就直接返回，连扫描都不触发）。
 * 幂等：重入只会重排同一个定时器，永远只有一个在跑。
 * ⚠ 不能写成 `if (timer) return`：boot 时（未 enroll）就已经把定时器挂上了，enroll 后再调就会被那句
 * 挡掉 —— 既不立刻上报（用户要盯着「等待首次心跳」15s），tickN 也不复位（换云端后首 tick 不做全量
 * digest，新云端要等 5min 才补齐）。
 *
 * ⚠ 上报权归持 scheduler.lock 的主实例：闸门放在这里（唯一的启动入口），boot 与 enroll 两条路径都得过。
 * 只在 server.js 的 boot 处判会漏掉 enroll —— 副实例（同 dataRoot、不同端口 → mode='disabled-lock'）
 * 从设置页点「连接」就会起自己的 connector，与主实例用同一个 token 双份 heartbeat + upsert。
 * 副实例 enroll 照常写 identity.json，主实例那个空转的 tick 会在 15s 内捡起来接管上报。
 */
export function startConnector() {
  if (scheduler.status().mode !== 'running') return;
  if (timer) clearInterval(timer);
  tickN = 0;                       // 首 tick 即全量 digest：重连 / 换云端后账本与云端一次对齐
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  tick();                          // 立即跑一轮，别让用户等 15s 才看到状态
}

/** 停止定时器（连带下行通道：解绑 / 401 终局后不许残留下行面）。 */
export function stopConnector() {
  if (timer) { clearInterval(timer); timer = null; }
  stopDownlink();
}

/**
 * 设置页用。⚠ 返回字段是**穷举**：这里**没有** registrationKey，也永远不许加（§7.1 红线）——
 * 它压根不在进程里。
 */
export function connectorStatus() {
  const id = readIdentity();
  return {
    enrolled: !!(id?.token && id?.cloudUrl),
    cloudUrl: id?.cloudUrl || null,
    machineId: id?.machineId || null,
    workspaceName: id?.workspaceName || null,
    machineUid: ensureMachineUid(),
    lastHeartbeatAt,
    lastHeartbeatOk,
    lastReconcileAt,
    lastIntentAt,
    lastPushed,
    lastError,
    syncedCount: Object.keys(readSynced()).length,
    remoteControl: downlinkStatus(),   // 手机中继：{enabled, connected, lastError, lastEventAt}
  };
}

/**
 * 注册：调 /api/machine/enroll → 落 identity.json → 立刻起 connector。
 * @param {{cloudUrl:string, registrationKey:string, code:string}} args
 *   registrationKey / code 都是**只用一次**的入场券：只作请求体字段传给云端，
 *   不落盘、不留驻模块级变量、不进 lastError（报错只用云端返回的 message，绝不回显请求体）。
 */
export async function enroll({ cloudUrl, registrationKey, code }) {
  const url = normalizeUrl(cloudUrl);
  if (!url) return { ok: false, error: '请填写云端 URL' };
  if (!registrationKey) return { ok: false, error: '请填写注册密钥' };
  if (!code) return { ok: false, error: '请填写配对码' };

  // claudeVersion 取最近一次扫描的缓存，不为 enroll 触发全量扫描；从没扫过则 null，
  // 15s 后第一次心跳就把真实版本补上（契约 §6.5：claudeVersion 可 null）。
  const claudeVersion = peekState()?.snapshot?.runtime?.version ?? null;
  const hostname = os.hostname();
  let r;
  try {
    r = await cloudRequest({ cloudUrl: url }, 'POST', '/api/machine/enroll', {
      registrationKey,
      code,
      machineUid: ensureMachineUid(),
      displayName: hostname,
      hostname,
      platform: process.platform,
      arch: process.arch,
      appVersion: APP_VERSION,
      claudeVersion,
    }, { timeoutMs: 20000 });
  } catch (e) {
    return { ok: false, error: `连接云端失败：${e.message}` };
  }

  if (r.status !== 201 && r.status !== 200) {
    return { ok: false, error: r.json?.error?.message || `云端返回 HTTP ${r.status}` };
  }
  const d = r.json || {};
  if (!d.token || !d.machineId) return { ok: false, error: '云端响应缺少 token / machineId' };

  saveIdentity({
    cloudUrl: url,
    machineId: d.machineId,
    token: d.token,
    workspaceId: d.workspaceId || null,
    workspaceName: d.workspaceName || null,
    // 机器主人：owner-only 闸门的唯一判据，enroll 时钉死（identity.js 头注说明为何不由心跳刷新）。
    // 云端没给（P1 老云端）→ null → owner-only 档恒失配 → 一切云端任务落 plan（fail-closed，§7.5）。
    ownerUserId: d.ownerUserId ?? null,
    enrolledAt: new Date().toISOString(),
  });
  lastError = null;
  lastHeartbeatOk = null;
  startConnector();
  return { ok: true, workspaceName: d.workspaceName || null };
}

/** 解绑：停 connector + 清云端绑定（保留 machineUid）。不通知云端——它靠 90s stale 自然置 offline。 */
export function unenroll() {
  stopConnector();
  clearCloudBinding();
  lastHeartbeatAt = null;
  lastHeartbeatOk = null;
  lastReconcileAt = null;
  lastIntentAt = null;
  lastHeartbeatPendingIntents = null;
  lastPushed = 0;
  lastError = null;
  return { ok: true };
}
