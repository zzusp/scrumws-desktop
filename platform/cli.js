#!/usr/bin/env node
import http from 'node:http';
import { parseArgs } from 'node:util';

// ScrumWS 任务新增 CLI（外部通道瘦客户端）：凭 API 密钥把任务推给运行中的 app。
// 2026-07-18 起走 /api/external/task/create（swak_ 鉴权 + per-key 策略 + externalKey 幂等）；
// 无鉴权的 /api/task/create 已同源收口、仅限看板页面自用，程序化调用一律拒绝。
// 密钥在桌面端「API 密钥」页生成；来源（source）与可用模型/effort/目录/直执权限由密钥决定。
//
//   node platform/cli.js create --title <t> --prompt <p> [--key <swak_…>] [--model <m>] [--effort <e>]
//                               [--cwd <dir>] [--desc <备注>] [--external-key <id>] [--queued]
//
// 端口取 --port ?? SCRUMWS_PORT ?? 8799；密钥取 --key ?? SCRUMWS_API_KEY。exit 0=已提交 / 1=失败。

const HELP = `ScrumWS 任务新增 CLI —— 凭 API 密钥把任务推给运行中的 app（缺省落 plan 待看板确认；--queued 直接执行需密钥开「允许直接执行」）

用法：
  node platform/cli.js create [选项]

选项：
  --key    <k>    API 密钥（swak_…；缺省读环境变量 SCRUMWS_API_KEY。在桌面端「API 密钥」页生成/复制）
  --title  <t>    标题（必填）
  --prompt <p>    交给 claude 的指令（必填；传 "-" 则从 stdin 读）
  --model  <m>    模型（须在密钥可用模型内；缺省取密钥白名单首项）
  --effort <e>    推理档位（须在密钥可用 effort 内；缺省取密钥白名单首项）
  --cwd    <dir>  工作目录绝对路径（须在密钥可访问目录内；缺省取密钥白名单首项）
  --desc   <备注> 纯用户备注（不进 prompt）
  --external-key <id>  幂等键（来源侧唯一事件 id；同键重复提交不重复建任务）
  --queued        直进 queued 立即自动执行（需密钥开「允许直接执行」）；缺省落 plan 待看板确认
  --json          整体 JSON body 从 stdin 读（覆盖上述字段；鉴权仍用 --key / SCRUMWS_API_KEY）
  --port   <n>    app 端口（缺省 SCRUMWS_PORT 或 8799）
  -h, --help      本帮助

任务来源（source）由密钥绑定，无需也不能在 CLI 指定。完整契约见 docs/api/external-api-guide.md。

示例：
  set SCRUMWS_API_KEY=swak_xxxx（或 $env:SCRUMWS_API_KEY='swak_xxxx'）
  node platform/cli.js create --title "登录报错" --prompt "修复 #123 的登录 500"
  echo "很长的指令…" | node platform/cli.js create --title "群里的活" --prompt - --external-key evt-001`;

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => resolve(s));
  });
}

function post(port, apiPath, body, key) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: apiPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: `Bearer ${key}` },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(out || '{}') }); }
        catch { resolve({ status: res.statusCode, json: null, raw: out }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(HELP);
    process.exit(cmd ? 0 : 1);
  }
  if (cmd !== 'create') {
    console.error(`未知子命令：${cmd}\n\n${HELP}`);
    process.exit(1);
  }

  let values;
  try {
    ({ values } = parseArgs({
      args: argv.slice(1),
      options: {
        key: { type: 'string' }, title: { type: 'string' }, prompt: { type: 'string' },
        model: { type: 'string' }, effort: { type: 'string' }, cwd: { type: 'string' }, desc: { type: 'string' },
        'external-key': { type: 'string' }, queued: { type: 'boolean' }, json: { type: 'boolean' }, port: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    console.error(`参数解析失败：${e.message}\n\n${HELP}`);
    process.exit(1);
  }
  if (values.help) { console.log(HELP); process.exit(0); }

  const key = String(values.key || process.env.SCRUMWS_API_KEY || '').trim();
  if (!key) {
    console.error('缺 API 密钥：传 --key swak_… 或设环境变量 SCRUMWS_API_KEY。\n密钥在桌面端「API 密钥」页生成（已有的可用行内「复制」取回原文）。');
    process.exit(1);
  }

  const port = Number(values.port || process.env.SCRUMWS_PORT || 8799);
  let body;
  if (values.json) {
    const raw = await readStdin();
    try { body = JSON.parse(raw); }
    catch (e) { console.error(`--json：stdin 不是合法 JSON：${e.message}`); process.exit(1); }
  } else {
    let prompt = values.prompt;
    if (prompt === '-') prompt = (await readStdin()).trim();
    body = {
      title: values.title, prompt,
      model: values.model, effort: values.effort, cwd: values.cwd, description: values.desc,
      externalKey: values['external-key'],
    };
    if (values.queued) body.plan = false;
  }

  let r;
  try {
    r = await post(port, '/api/external/task/create', body, key);
  } catch (e) {
    console.error(`连不上 app（127.0.0.1:${port}）：${e.message}\n确认 ScrumWS 正在运行（或用 --port / SCRUMWS_PORT 指定端口）。`);
    process.exit(1);
  }

  if (r.json?.ok) {
    const st = r.json.state;
    const label = st === 'processing' ? '已起会话执行' : st === 'plan' ? '已入计划（待看板确认执行）' : '已入队';
    const dedup = r.json.existed ? ' · 幂等命中（同 externalKey 任务已存在，未重复建）' : '';
    console.log(`✓ ${label} ${r.json.taskKey}（state=${st}）${dedup}${r.json.startError ? ` · 起会话失败：${r.json.startError}` : ''}`);
    process.exit(0);
  }
  if (r.status === 401) {
    console.error('✗ 鉴权失败（HTTP 401）：密钥错误 / 已禁用 / 已删除。到桌面端「API 密钥」页核对。');
    process.exit(1);
  }
  console.error(`✗ 新建失败（HTTP ${r.status}）：${r.json?.error || r.raw || '未知错误'}`);
  process.exit(1);
}

main();
