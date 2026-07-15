import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 近 30 天每天用量（总 token，含 cache）：扫 ~/.claude/projects 下所有项目的 CC session jsonl 按本地日分桶。
// 全局 = 所有 assistant 行；platform = sessionId ∈ scrumws 分身任务集合的行（全局的子集，供柱状图对比）。
// CC jsonl 无 costUSD，故用 token 而非 cost。只读近 30 天 mtime 的文件（更早的不含近 30 天的行）压缩扫描量。
// 30 天全量约 1680 文件/530MB → TTL 5min + 后台异步重扫（逐文件 await 让出，不阻塞 /api/state 事件循环）。
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DAYS = 30;
const TTL = 5 * 60_000;

let cache = { at: 0, data: null };   // 后台重扫写入；getDailyUsage 只读它，不阻塞事件循环
let inflight = null;

// 本地日期键 YYYY-MM-DD（分桶按本机时区，与看板其它时间展示一致）
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 近 DAYS 天空桶（旧→新），每天细分 input/output/cache/total + platform（scrumws 子集的 total）
function emptyDays(now) {
  const days = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now); d.setDate(now.getDate() - i); d.setHours(0, 0, 0, 0);
    days.push({ date: dayKey(d), input: 0, output: 0, cache: 0, total: 0, platform: 0 });
  }
  return days;
}

// 列近 DAYS 天 mtime 有改动的 jsonl 全路径（跨全部项目目录）
function recentJsonls(cutMs) {
  const out = [];
  let projs = [];
  try { projs = fs.readdirSync(PROJECTS_DIR); } catch { return out; }
  for (const p of projs) {
    const pdir = path.join(PROJECTS_DIR, p);
    let files = [];
    try { if (!fs.statSync(pdir).isDirectory()) continue; files = fs.readdirSync(pdir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(pdir, f);
      try { if (fs.statSync(fp).mtimeMs >= cutMs) out.push(fp); } catch { /* 文件消失 */ }
    }
  }
  return out;
}

// 扫描聚合（async：逐文件 await readFile 让出事件循环，把 CPU 解析切成小段不长时间独占）
async function scan(sessionIds) {
  const now = new Date();
  const days = emptyDays(now);
  const idx = new Map(days.map((d, i) => [d.date, i]));
  const cutMs = now.getTime() - DAYS * 86400_000;
  for (const fp of recentJsonls(cutMs)) {
    let text;
    try { text = await fs.promises.readFile(fp, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line || line.indexOf('"type":"assistant"') === -1) continue;   // 快筛，避免 full parse 非 assistant 行
      let o; try { o = JSON.parse(line); } catch { continue; }
      const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
      if (!Number.isFinite(ts) || ts < cutMs) continue;
      const i = idx.get(dayKey(new Date(ts)));
      if (i == null) continue;
      const u = o.message?.usage || {};
      const inp = Number(u.input_tokens) || 0;
      const out = Number(u.output_tokens) || 0;
      const cch = (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
      const tot = inp + out + cch;
      const d = days[i];
      d.input += inp; d.output += out; d.cache += cch; d.total += tot;
      const sid = o.sessionId || o.session_id;
      if (sid && sessionIds.has(sid)) d.platform += tot;
    }
  }
  return days;
}

// 读缓存返回（可能 null=首次未扫完）；TTL 到点则后台异步重扫（不 await，绝不阻塞 /api/state）。
// 语义对齐 collect.js detectClaudeRuntime 的自查节流。返回近 30 天 [{date,input,output,cache,total,platform}]。
export function getDailyUsage(sessionIds) {
  if ((!cache.data || Date.now() - cache.at >= TTL) && !inflight) {
    inflight = scan(sessionIds || new Set())
      .then((data) => { cache = { at: Date.now(), data }; inflight = null; return data; })
      .catch(() => { inflight = null; return cache.data; });
  }
  return cache.data;
}
