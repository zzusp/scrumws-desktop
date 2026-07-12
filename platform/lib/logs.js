import fs from 'node:fs';
import path from 'node:path';
import { P } from './paths.js';
import { parse } from './timeutil.js';
import { leaseAlive } from './lease.js';
function readJson(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

// lazy import 避免顶层循环依赖（logs.js 被 collect.js 引用，而 collect-cli.js/cli-watchlist.js 独立子树）
import * as _cliWatchlist from './cli-watchlist.js';
import * as _collectCli from './collect-cli.js';

// 扫全库 sessionId（runner-state + runner-archive 下每个任务包的 meta.sessionHistory + meta.sessionId），
// 用于 in-flight 检测："孤儿"jsonl = 出现在 CC 项目目录、但不属于任何已知任务的 session。
function collectKnownSessionIds() {
  const ids = new Set();
  for (const root of [P.runnerRoot, P.archiveRoot]) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      const meta = readJson(path.join(root, name, 'meta.json'));
      if (!meta) continue;
      if (meta.sessionId) ids.add(meta.sessionId);
      if (Array.isArray(meta.sessionHistory)) {
        for (const h of meta.sessionHistory) if (h?.sessionId) ids.add(h.sessionId);
      }
    }
  }
  return ids;
}

// 找 in-flight round 1 用的孤儿 jsonl：mtime > lease.claimedAt - 30s、且 sessionId 不在任何已知任务里；
// 有多个候选时无法可靠归属（并发起飞），返回 null 保守起见。
function findOrphanInflight(claimedAt, knownSids) {
  const claimedMs = parse(claimedAt)?.getTime();
  if (!claimedMs) return null;
  const cutoff = claimedMs - 30_000;
  const nowMs = Date.now();
  let names = [];
  try { names = fs.readdirSync(P.ccProjectDir); } catch { return null; }
  const candidates = [];
  for (const f of names) {
    if (!f.endsWith('.jsonl')) continue;
    const sid = f.slice(0, -6);
    if (!/^[a-f0-9-]{36}$/.test(sid)) continue;
    if (knownSids.has(sid)) continue;
    let stat;
    try { stat = fs.statSync(path.join(P.ccProjectDir, f)); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue;
    // 5min 内没写过 = 死会话，不算 in-flight
    if (nowMs - stat.mtimeMs > 5 * 60_000) continue;
    candidates.push({ sid, mtimeMs: stat.mtimeMs });
  }
  if (candidates.length === 0) return null;
  if (candidates.length > 1) return null;   // 并发起飞、无法可靠归属 → 保守跳
  return candidates[0].sid;
}

// 解析 CC 官方 session jsonl 为一问一答的 message pair 列表。
// 保留结构化字段供前端展示 sessionId / usage / thinking / tool_use / tool_result。
function parseCcSession(jsonlText) {
  const events = [];
  for (const line of String(jsonlText).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { events.push(JSON.parse(t)); } catch { /* 忽略非 JSON */ }
  }

  // 死分支过滤（撤回重发 = CC 会话树分叉）：jsonl 是树不是线——用户撤回消息重发时，
  // 新消息挂到同一 parentUuid 形成兄弟分支，原消息成了没有后代的死分支；jsonl 行不删除。
  // `claude resume` 语义 = 只走活跃链（从最后一条消息沿 parentUuid 回溯到根）。
  // 展示对齐 resume：从最后一条 user/assistant 事件回溯出活跃链集合，
  // 有 uuid 但不在链上的非 meta user/assistant 事件 = 被撤回 → 跳过。
  // meta 消息（caveat 等，isMeta=true）不参与过滤——它们常挂在链外的注入位置，误杀反而丢上下文。
  const byUuid = new Map();
  for (const e of events) if (e.uuid) byUuid.set(e.uuid, e);
  let leaf = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if ((e.type === 'user' || e.type === 'assistant') && e.uuid) { leaf = e; break; }
  }
  const activeSet = new Set();
  for (let cur = leaf, guard = 0; cur && guard < 100000; guard++) {
    activeSet.add(cur.uuid);
    cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : null;
  }
  const onDeadBranch = (e) => !!leaf && !!e.uuid && !activeSet.has(e.uuid);

  const messages = [];
  let currentAsst = null;   // 合并同 message id 的连续 assistant delta
  let lastResult = null;
  let firstSystem = null;
  let firstCwd = null;
  for (const e of events) {
    if (e.type === 'system' && !firstSystem) firstSystem = e;
    // cwd 可能出现在任意事件顶层（session jsonl 里 user/queue-operation 都带）——不局限于 system:init
    if (!firstCwd && e.cwd) firstCwd = e.cwd;
    if (e.type === 'result') { lastResult = e; continue; }
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (onDeadBranch(e) && !e.isMeta) continue;   // 撤回的死分支消息不展示（对齐 resume 上下文）
    // 每个 content block 带上所在 jsonl 行的 timestamp（_ts）：assistant 的 tool_use 与 user 的
    // tool_result 各在自己那行落盘，据此前端可算每步耗时（tool_use._ts → tool_result._ts）。
    const stamp = e.timestamp || e.at || null;
    const withTs = (c) => { if (c && typeof c === 'object' && c._ts == null) c._ts = stamp; return c; };
    if (e.type === 'user') {
      currentAsst = null;
      const msg = e.message || {};
      let contentArr;
      if (typeof msg.content === 'string') {
        contentArr = [{ type: 'text', text: msg.content }];
      } else if (Array.isArray(msg.content)) {
        contentArr = msg.content;
      } else {
        contentArr = [];
      }
      contentArr.forEach(withTs);
      messages.push({
        role: 'user',
        at: e.timestamp || e.at || null,
        uuid: e.uuid || null,
        content: contentArr,
        isMeta: !!e.isMeta,   // caveat / hook / system-reminder 等系统性 user 消息标记
      });
    } else {
      // assistant：同 message id 累积（CC 流式输出会拆成多条 delta，都是同一 message.id）
      const msg = e.message || {};
      const mid = msg.id || e.uuid || null;
      if (currentAsst && currentAsst.messageId === mid) {
        // 合并 content（后续 delta 的 content 与已有的 dedupe by type+text）
        for (const c of msg.content || []) {
          const already = currentAsst.content.find((x) =>
            x.type === c.type &&
            (x.text === c.text || (x.name && x.name === c.name && JSON.stringify(x.input) === JSON.stringify(c.input)))
          );
          if (!already) currentAsst.content.push(withTs(c));
        }
        // usage 用最新的
        if (msg.usage) currentAsst.usage = msg.usage;
      } else {
        currentAsst = {
          role: 'assistant',
          at: e.timestamp || e.at || null,
          messageId: mid,
          model: msg.model || null,
          content: (msg.content || []).map(withTs),
          usage: msg.usage || null,
        };
        messages.push(currentAsst);
      }
    }
  }
  // 汇总：CC jsonl 主要存 conversation history，通常没 result/system 事件（那是 stream-json 输出格式独有）；
  // 用最后一条 assistant.usage 推 context size；num_turns 用 assistant 消息数；cost 走 meta.json 侧补齐。
  const lastAsst = [...messages].reverse().find((m) => m.role === 'assistant' && m.usage);
  const contextSize = lastAsst?.usage
    ? (lastAsst.usage.input_tokens || 0) + (lastAsst.usage.cache_read_input_tokens || 0) + (lastAsst.usage.cache_creation_input_tokens || 0)
    : null;
  // 工作时长：turn_duration 事件的 durationMs 累加 = claude 实际在算的时长（不含用户输入间隔）
  let workMs = 0;
  for (const e of events) {
    if (e.type === 'system' && e.subtype === 'turn_duration' && Number(e.durationMs) > 0) workMs += Number(e.durationMs);
  }
  const summary = {
    sessionId: lastResult?.session_id || null,
    numTurns: lastResult?.num_turns ?? messages.filter((m) => m.role === 'assistant').length,
    totalCostUsd: lastResult?.total_cost_usd ?? null,
    tokens: lastResult?.usage || (lastAsst?.usage ? {
      input_tokens: lastAsst.usage.input_tokens || 0,
      output_tokens: lastAsst.usage.output_tokens || 0,
      cache_read_input_tokens: lastAsst.usage.cache_read_input_tokens || 0,
      cache_creation_input_tokens: lastAsst.usage.cache_creation_input_tokens || 0,
    } : null),
    contextSize,
    model: lastAsst?.model || null,
    workMs: workMs > 0 ? workMs : null,
  };
  // 真人 cc: 从 tool_result（dws chat message list 的返回）里提取 sender=孙鹏 + cc: 开头的
  const humanCc = extractHumanCc(messages);
  return { messages, summary, systemInit: firstSystem, cwd: firstCwd, humanCc };
}

// 过滤真人 cc:：只保留"本轮 worker 应处理的" —— cc.at 在 (下界, 本 session startedAt + 60s 宽限] 内
// 下界 = 前一 session endedAt；首个 session 无前值时默认 startedAt - 15min（限制窗口、避免历史老 cc: 混入）
function filterCcByProcessingWindow(cc, prevEndedAt, roundStartedAt) {
  const startBase = roundStartedAt ? new Date(roundStartedAt).getTime() : null;
  const startMs = prevEndedAt
    ? new Date(prevEndedAt).getTime()
    : (startBase !== null ? startBase - 15 * 60000 : null);
  const endMs = startBase !== null ? startBase + 60000 : null;
  return cc.filter((x) => {
    if (!x.at) return true;
    const t = new Date(x.at).getTime();
    if (isNaN(t)) return true;
    if (startMs !== null && t <= startMs) return false;
    if (endMs !== null && t > endMs) return false;
    return true;
  });
}

// S10 收养：全局定位 sessionId 的 jsonl，解析出历史消息 + cwd + model，供 Mode B --resume 续接
// （消息 content block 已带 _ts，历史每步计时同样可显示）。返回 { ok, messages, cwd, model, jsonlPath }。
export function readCcSessionForAdopt(sessionId) {
  if (!sessionId || !/^[a-f0-9-]{36}$/.test(String(sessionId))) return { ok: false, error: 'invalid sessionId' };
  const found = _collectCli.locateJsonlBySid(sessionId);
  if (!found || !found.jsonlPath || !fs.existsSync(found.jsonlPath)) return { ok: false, error: 'session jsonl 未找到（终端会话文件已不存在？）' };
  let parsed;
  try { parsed = parseCcSession(fs.readFileSync(found.jsonlPath, 'utf8')); } catch (e) { return { ok: false, error: `解析失败: ${e.message}` }; }
  return {
    ok: true,
    messages: parsed.messages || [],
    cwd: parsed.cwd || parsed.systemInit?.cwd || null,
    model: parsed.summary?.model || parsed.systemInit?.model || null,
    jsonlPath: found.jsonlPath,
  };
}

// 独立入口：从 sessionId 对应的 CC jsonl 提取真人 cc:（供 collect.js 每任务展示卡片用）
export function extractHumanCcFromSession(ccProjectDir, sessionId) {
  if (!sessionId || !/^[a-f0-9-]{36}$/.test(String(sessionId))) return [];
  const file = path.join(ccProjectDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = parseCcSession(text);
    return parsed.humanCc || [];
  } catch { return []; }
}

// 扫 tool_result 里的 dws JSON、提取 sender=孙鹏 + cc: 开头的消息
function extractHumanCc(messages) {
  const found = [];
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const c of m.content || []) {
      if (c.type !== 'tool_result') continue;
      let body = '';
      if (typeof c.content === 'string') body = c.content;
      else if (Array.isArray(c.content)) body = c.content.map((x) => (x.type === 'text' ? x.text : '')).join('\n');
      // 找 JSON 段：dws 返回一般是 stdout 里一整段 JSON
      const jsonMatch = body.match(/\{[\s\S]+"result"[\s\S]+\}/);
      if (!jsonMatch) continue;
      try {
        const obj = JSON.parse(jsonMatch[0]);
        const msgs = obj?.result?.messages;
        if (!Array.isArray(msgs)) continue;
        for (const msg of msgs) {
          if (msg.sender === '孙鹏' && /^\s*cc[:：]/i.test(String(msg.content || ''))) {
            found.push({ at: msg.createTime || null, text: String(msg.content || '').trim() });
          }
        }
      } catch { /* ignore */ }
    }
  }
  // 按时间去重（同一 cc: 可能在多轮 dws 拉里出现）
  const seen = new Set();
  const dedup = found.filter((x) => {
    const k = (x.at || '') + '|' + x.text;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // 按 createTime 升序（第一条 = 时间上最早的真人 cc:）
  return dedup.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
}

// taskKey → safeTaskKey：chat:group-1 → chat__group-1；issue:HiQ-AI-feedback#42 → issue__HiQ-AI-feedback_42
function safeKeyOf(taskKey) {
  if (!/^[A-Za-z0-9:_#/-]+$/.test(taskKey)) return null;
  return taskKey.replace(/:/g, '__').replace(/#/g, '_');
}

// CLI session 走独立分支：taskKey=cli:<sid[0:8]>；从 watchlist 拿 sid + jsonlPath 解析，
// 不查 runner-state（CLI session 从来不落任务包）；无 rounds 概念，单轮 body 装整段 messages
function readCliWorkerLog(taskKey) {
  const shortSid = taskKey.slice(4);
  const w = _cliWatchlist.readWatchlist();
  const entry = Object.entries(w.sessions).find(([sid]) => sid.startsWith(shortSid));
  if (!entry) return { ok: false, error: 'cli session not in watchlist', taskKey };
  const [sid, meta] = entry;
  let jsonlPath = meta?.jsonlPath;
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    const found = _collectCli.locateJsonlBySid(sid);
    if (!found) return { ok: false, error: 'jsonl not found', taskKey };
    jsonlPath = found.jsonlPath;
  }
  let text = '';
  try { text = fs.readFileSync(jsonlPath, 'utf8'); }
  catch (e) { return { ok: false, error: `读取失败: ${e.message}`, taskKey }; }
  const parsed = parseCcSession(text);
  const stat = fs.statSync(jsonlPath);
  // CLI 无 rounds 概念：整段 messages 装到 round=1
  const round = {
    round: 1,
    sessionId: sid,
    at: null,
    startedAt: parsed.messages[0]?.at || null,
    endedAt: parsed.messages[parsed.messages.length - 1]?.at || null,
    intent: 'cli-interactive',
    metaUsage: null,
    metaCostUsd: null,
    ccSummary: parsed.summary,
    messages: parsed.messages,
    humanCc: [],
    systemInit: parsed.systemInit ? {
      model: parsed.systemInit.model,
      cwd: parsed.systemInit.cwd,
      toolsCount: Array.isArray(parsed.systemInit.tools) ? parsed.systemInit.tools.length : null,
    } : null,
    cwd: parsed.cwd || parsed.systemInit?.cwd || null,
    // mtime <5min 视为"实时",前端会加 pulse 徽章
    inflight: (Date.now() - stat.mtimeMs) < 5 * 60 * 1000,
  };
  return {
    ok: true,
    taskKey,
    safeKey: `cli__${sid}`,
    isArchive: false,
    rounds: [round],
    hasInflight: round.inflight,
    runnerLogTail: null,
    checkerLogTail: null,
  };
}

// worker-log 端点：从 CC 官方 jsonl 拼 sessionHistory[] 多轮内容（阶段 3 起，替代旧 watch-worker-*.log）
export function readWorkerLog(taskKey, maxSessions = 20) {
  if (typeof taskKey === 'string' && taskKey.startsWith('cli:')) return readCliWorkerLog(taskKey);
  const safeKey = safeKeyOf(taskKey);
  if (!safeKey) return { ok: false, error: 'invalid taskKey', taskKey };
  const taskDir = path.join(P.runnerRoot, safeKey);
  const archiveDir = path.join(P.archiveRoot, safeKey);
  let dir = null;
  if (fs.existsSync(taskDir)) dir = taskDir;
  else if (fs.existsSync(archiveDir)) dir = archiveDir;
  if (!dir) return { ok: false, error: 'task not found', taskKey };

  const metaFile = path.join(dir, 'meta.json');
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { }
  const sessionHistory = Array.isArray(meta?.sessionHistory) ? meta.sessionHistory : (meta?.sessionId ? [{ sessionId: meta.sessionId, round: 1 }] : []);

  // 读 rounds.jsonl 拿每 session 的 startedAt/endedAt（用于过滤"本轮 cc:"）
  // 注意：多次 worker spawn 都从 round=1 开始，rounds.jsonl 里 round 号会重复；用 sessionId 做 key 才唯一
  const roundsMetaFile = path.join(dir, 'rounds.jsonl');
  const roundsMetaBySid = {};
  if (fs.existsSync(roundsMetaFile)) {
    try {
      for (const line of fs.readFileSync(roundsMetaFile, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try { const o = JSON.parse(t); if (o.sessionId) roundsMetaBySid[o.sessionId] = o; } catch { }
      }
    } catch { }
  }

  // 按 sessionHistory 时间升序确保 prevEndedAt 累进正确
  const sortedHistory = [...sessionHistory.slice(0, maxSessions)].sort((a, b) => {
    const at = roundsMetaBySid[a.sessionId]?.startedAt || a.at || '';
    const bt = roundsMetaBySid[b.sessionId]?.startedAt || b.at || '';
    return String(at).localeCompare(String(bt));
  });

  const rounds = [];
  let prevEndedAt = null;   // 前一 session 的 endedAt，作为本 session cc: 窗口的下界
  for (const s of sortedHistory) {
    if (!s.sessionId || !/^[a-f0-9-]{36}$/.test(s.sessionId)) continue;
    let jsonlFile = path.join(P.ccProjectDir, `${s.sessionId}.jsonl`);
    // 交互任务 cwd≠数据根时 jsonl 落在别的 CC 项目目录 → 全局按 sid 兜底定位
    if (!fs.existsSync(jsonlFile)) {
      const found = _collectCli.locateJsonlBySid(s.sessionId);
      if (found) jsonlFile = found.jsonlPath;
    }
    if (!fs.existsSync(jsonlFile)) {
      rounds.push({ round: s.round || null, sessionId: s.sessionId, at: s.at || null, body: '（CC jsonl 文件不存在，可能已被清或历史久远）' });
      continue;
    }
    let text = '';
    try {
      // 读整个 jsonl（一般 <5MB）
      text = fs.readFileSync(jsonlFile, 'utf8');
    } catch (e) {
      rounds.push({ round: s.round || null, sessionId: s.sessionId, at: s.at || null, error: `读取失败: ${e.message}` });
      continue;
    }
    const parsed = parseCcSession(text);
    // 本轮 cc: 窗口 = [前一 session endedAt, 本 session startedAt + 60s 宽限]
    // 判据：真人 cc: 是 worker 起飞前发的、time <= startedAt；> prevEndedAt 才归本轮（避免误伤上一轮已处理的）
    const rmeta = roundsMetaBySid[s.sessionId] || {};
    const roundStart = rmeta.startedAt || null;
    const roundEnd = rmeta.endedAt || null;
    const humanCc = filterCcByProcessingWindow(parsed.humanCc || [], prevEndedAt, roundStart);
    prevEndedAt = roundEnd || prevEndedAt;
    rounds.push({
      round: s.round || null,
      sessionId: s.sessionId,
      at: s.at || null,
      startedAt: roundStart,
      endedAt: roundEnd,
      intent: rmeta.intent || null,
      metaUsage: s.usage || null,
      metaCostUsd: s.costUsd || null,
      ccSummary: parsed.summary,
      messages: parsed.messages,
      // 真人 cc: 只保留本轮期间的（>= startedAt - 60s 宽限）
      humanCc,
      systemInit: parsed.systemInit ? {
        model: parsed.systemInit.model,
        cwd: parsed.systemInit.cwd,
        toolsCount: Array.isArray(parsed.systemInit.tools) ? parsed.systemInit.tools.length : null,
      } : null,
      cwd: parsed.cwd || parsed.systemInit?.cwd || null,
    });
  }

  // ---- in-flight round：processing + lease 活着才尝试挂 ----
  // Case A（round 1 首启）：sessionHistory 空 → 从 CC 项目目录扫孤儿 jsonl
  // Case B（--resume 续轮）：sessionHistory 有、meta.sessionId 存在 → 用该 sid 的 jsonl，按上一轮 endedAt 切
  const state = readJson(path.join(dir, 'state.json'));
  const lease = readJson(path.join(dir, 'lease.json'));
  const isProcessing = state?.state === 'processing';
  const isLeaseAlive = leaseAlive(lease);
  let inflight = null;
  if (isProcessing && isLeaseAlive && dir !== archiveDir) {
    const historySids = new Set(rounds.map((r) => r.sessionId).filter(Boolean));
    const lastCompletedRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;
    // Case B 优先：meta 有 sessionId 且 jsonl 存在，说明是 --resume 场景（同 sid 追加写）
    let inflightSid = null;
    let sliceAfterMs = null;
    let inflightRoundNum = 1;
    if (meta?.sessionId) {
      const jf = path.join(P.ccProjectDir, `${meta.sessionId}.jsonl`);
      if (fs.existsSync(jf) && historySids.has(meta.sessionId)) {
        // --resume 续轮：切 messages 到上一轮 endedAt 之后
        inflightSid = meta.sessionId;
        const endedAt = lastCompletedRound?.endedAt || null;
        sliceAfterMs = endedAt ? parse(endedAt)?.getTime() : null;
        inflightRoundNum = (lastCompletedRound?.round || 0) + 1;
      }
    }
    // Case A 兜底：孤儿 jsonl 归属本任务
    if (!inflightSid && rounds.length === 0) {
      const orphan = findOrphanInflight(lease?.claimedAt, collectKnownSessionIds());
      if (orphan) {
        inflightSid = orphan;
        inflightRoundNum = 1;
      }
    }
    if (inflightSid) {
      const jsonlFile = path.join(P.ccProjectDir, `${inflightSid}.jsonl`);
      try {
        const text = fs.readFileSync(jsonlFile, 'utf8');
        const parsed = parseCcSession(text);
        const messages = sliceAfterMs
          ? parsed.messages.filter((m) => {
              const t = m.at ? new Date(m.at).getTime() : NaN;
              return isNaN(t) || t > sliceAfterMs;
            })
          : parsed.messages;
        // 有内容才挂（避免"仅 system.init 未开跑"的空 round 干扰视觉）
        if (messages.length > 0 || rounds.length === 0) {
          inflight = {
            round: inflightRoundNum,
            sessionId: inflightSid,
            at: null,
            startedAt: lease?.claimedAt || null,
            endedAt: null,
            intent: lease?.intent || null,
            metaUsage: null,
            metaCostUsd: null,
            ccSummary: parsed.summary,
            messages,
            humanCc: [],   // in-flight 时窗未定，跳过 cc: 过滤
            cwd: parsed.cwd || parsed.systemInit?.cwd || null,
            systemInit: parsed.systemInit ? {
              model: parsed.systemInit.model,
              cwd: parsed.systemInit.cwd,
              toolsCount: Array.isArray(parsed.systemInit.tools) ? parsed.systemInit.tools.length : null,
            } : null,
            inflight: true,   // 前端据此加"实时"tag、默认展开、模式化角标
          };
          rounds.push(inflight);
        }
      } catch { /* jsonl 读不到 = 忽略 */ }
    }
  }

  // 附带 runner.log 和 checker.log 摘要给 UI 展示（近 50 行）
  const runnerLogFile = path.join(dir, 'runner.log');
  const checkerLogFile = path.join(dir, 'checker.log');
  const readLast = (f, n) => {
    if (!fs.existsSync(f)) return null;
    const t = fs.readFileSync(f, 'utf8');
    return t.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join('\n');
  };

  return {
    ok: true,
    taskKey,
    safeKey,
    isArchive: dir === archiveDir,
    state: state?.state || null,   // SSE 判收敛 / 前端指纹用（state 已在上方从 state.json 读出）
    rounds,
    hasInflight: !!inflight,
    runnerLogTail: readLast(runnerLogFile, 50),
    checkerLogTail: readLast(checkerLogFile, 20),
  };
}


// 编辑任务描述：写 task.json.description。纯用户备注（比如开始前记任务内容、归档前记进展），
// 不拼进任何 claude prompt；任意状态（含归档）都可编辑，空串 = 清除
export function setTaskDescription(taskKey, newDesc) {
  const safeKey = safeKeyOf(taskKey);
  if (!safeKey) return { ok: false, error: 'invalid taskKey' };
  let dir = null;
  if (fs.existsSync(path.join(P.runnerRoot, safeKey))) dir = path.join(P.runnerRoot, safeKey);
  else if (fs.existsSync(path.join(P.archiveRoot, safeKey))) dir = path.join(P.archiveRoot, safeKey);
  if (!dir) return { ok: false, error: 'task not found' };
  const taskFile = path.join(dir, 'task.json');
  let task = {};
  if (fs.existsSync(taskFile)) {
    try { task = JSON.parse(fs.readFileSync(taskFile, 'utf8')); } catch { task = {}; }
  }
  const trimmed = String(newDesc || '').trim().slice(0, 2000);
  if (trimmed) task.description = trimmed;
  else delete task.description;
  task.taskKey = task.taskKey || taskKey;
  fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf8');
  return { ok: true, taskKey, description: task.description || null };
}

// 重命名任务：写 task.json.customTitle（优先级：customTitle > 首条用户消息 > issue title > taskKey）
export function renameTask(taskKey, newTitle) {
  const safeKey = safeKeyOf(taskKey);
  if (!safeKey) return { ok: false, error: 'invalid taskKey' };
  let dir = null;
  if (fs.existsSync(path.join(P.runnerRoot, safeKey))) dir = path.join(P.runnerRoot, safeKey);
  else if (fs.existsSync(path.join(P.archiveRoot, safeKey))) dir = path.join(P.archiveRoot, safeKey);
  if (!dir) return { ok: false, error: 'task not found' };
  const taskFile = path.join(dir, 'task.json');
  let task = {};
  if (fs.existsSync(taskFile)) {
    try { task = JSON.parse(fs.readFileSync(taskFile, 'utf8')); } catch { task = {}; }
  }
  const trimmed = String(newTitle || '').trim().slice(0, 200);
  if (trimmed) {
    task.customTitle = trimmed;
  } else {
    // 空标题 = 清除 customTitle（恢复默认标题）
    delete task.customTitle;
  }
  task.taskKey = task.taskKey || taskKey;
  fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf8');
  return { ok: true, taskKey, customTitle: task.customTitle || null };
}

// 归档 done 任务：docs/tmp/runner-state/<safeKey>/ → docs/tmp/runner-archive/<safeKey>/
export function archiveTask(taskKey) {
  // CLI 走独立分支：手动归档 = watchlist 里写 archivedAt；不动 jsonl
  if (typeof taskKey === 'string' && taskKey.startsWith('cli:')) {
    const shortSid = taskKey.slice(4);
    const w = _cliWatchlist.readWatchlist();
    const entry = Object.entries(w.sessions).find(([sid]) => sid.startsWith(shortSid));
    if (!entry) return { ok: false, error: 'cli session not in watchlist' };
    return _cliWatchlist.setArchivedWatchlist(entry[0], true);
  }
  const safeKey = safeKeyOf(taskKey);
  if (!safeKey) return { ok: false, error: 'invalid taskKey' };
  const from = path.join(P.runnerRoot, safeKey);
  const to = path.join(P.archiveRoot, safeKey);
  if (!fs.existsSync(from)) return { ok: false, error: 'task not found' };
  // 归档条件 = 已收敛（resolvedAt 非空）：done / awaiting-human（含用户中断 outcome=cancelled）都可归档
  // ——归档就是"人工处理完毕"的统一出口（2026-07-10 前 awaiting-human 禁归档，处理完的卡永远糊在看板上清不掉）
  // plan（从未 spawn 的待确认任务）也可归档 = "决定不做了"；queued/processing（未收敛）仍不可归档
  const state = (() => { try { return JSON.parse(fs.readFileSync(path.join(from, 'state.json'), 'utf8')); } catch { return null; } })();
  if (!state || !(state.resolvedAt || state.state === 'plan')) {
    return { ok: false, error: `state=${state?.state || '?'}（resolvedAt=null 未收敛）不可归档` };
  }
  if (!fs.existsSync(P.archiveRoot)) fs.mkdirSync(P.archiveRoot, { recursive: true });
  if (fs.existsSync(to)) return { ok: false, error: '归档目标已存在（可能重复归档）' };
  fs.renameSync(from, to);
  return { ok: true, taskKey, safeKey, from, to };
}

// CLI 取消归档：清 watchlist.archivedAt，回落 mtime 自动判态
export function unarchiveCliTask(taskKey) {
  if (typeof taskKey !== 'string' || !taskKey.startsWith('cli:')) return { ok: false, error: 'not a cli task' };
  const shortSid = taskKey.slice(4);
  const w = _cliWatchlist.readWatchlist();
  const entry = Object.entries(w.sessions).find(([sid]) => sid.startsWith(shortSid));
  if (!entry) return { ok: false, error: 'cli session not in watchlist' };
  return _cliWatchlist.setArchivedWatchlist(entry[0], false);
}

// CLI 人工完成：写 watchlist.doneAt（照抄归档机制，不动 jsonl）。会话之后又有活动 collect 会自动清 doneAt 退出 done。
export function completeCliSession(taskKey) {
  if (typeof taskKey !== 'string' || !taskKey.startsWith('cli:')) return { ok: false, error: 'not a cli task' };
  const shortSid = taskKey.slice(4);
  const w = _cliWatchlist.readWatchlist();
  const entry = Object.entries(w.sessions).find(([sid]) => sid.startsWith(shortSid));
  if (!entry) return { ok: false, error: 'cli session not in watchlist' };
  return _cliWatchlist.setDoneWatchlist(entry[0], true);
}

// CLI 取消完成：清 watchlist.doneAt，回落存活自动判态
export function uncompleteCliTask(taskKey) {
  if (typeof taskKey !== 'string' || !taskKey.startsWith('cli:')) return { ok: false, error: 'not a cli task' };
  const shortSid = taskKey.slice(4);
  const w = _cliWatchlist.readWatchlist();
  const entry = Object.entries(w.sessions).find(([sid]) => sid.startsWith(shortSid));
  if (!entry) return { ok: false, error: 'cli session not in watchlist' };
  return _cliWatchlist.setDoneWatchlist(entry[0], false);
}
