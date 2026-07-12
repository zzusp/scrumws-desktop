#!/usr/bin/env node
import http from 'node:http';
import { parseArgs } from 'node:util';

// ScrumWS 任务新增 CLI（HTTP 瘦客户端）：把任务推给运行中的 app。queued 即自动起交互式 claude 会话执行，
// plan 待看板确认后执行。供任意来源（聊天机器人 / issue webhook / 脚本 …）新建任务，与看板「新建任务」按钮同一端点。
//
//   node platform/cli.js create --source <s> --title <t> --prompt <p> [--model <m>] [--cwd <dir>] [--desc <备注>] [--plan]
//   node platform/cli.js create --source chat --title "标题" --prompt -          # prompt 从 stdin 读（长文本）
//   node platform/cli.js create --json                                          # 整体 JSON body 从 stdin 读
//
// 端口取 --port ?? SCRUMWS_PORT ?? 8799；服务只 bind 127.0.0.1。exit 0=已提交 / 1=失败。

const HELP = `ScrumWS 任务新增 CLI —— 把任务推给运行中的 app（queued 自动执行 / plan 待看板确认）

用法：
  node platform/cli.js create [选项]

选项：
  --source <s>    来源标签（chat/issue/manual/任意 [A-Za-z0-9_-]，缺省 manual）
  --title  <t>    标题（必填）
  --prompt <p>    交给 claude 的指令（必填；传 "-" 则从 stdin 读）
  --model  <m>    模型（缺省取 runner-config.defaultModel）
  --cwd    <dir>  工作目录绝对路径（可选，须存在且是目录）
  --desc   <备注> 纯用户备注（不进 prompt）
  --plan          落 plan 桶（需在看板「确认执行」后才跑）；缺省落 queued 立即自动起会话执行
  --json          整体 JSON body 从 stdin 读（覆盖上述字段）
  --port   <n>    app 端口（缺省 SCRUMWS_PORT 或 8799）
  -h, --help      本帮助

示例：
  node platform/cli.js create --source issue --title "登录报错" --prompt "修复 #123 的登录 500"
  echo "很长的指令…" | node platform/cli.js create --source chat --title "群里的活" --prompt -
  echo '{"source":"feishu","title":"x","prompt":"y","plan":true}' | node platform/cli.js create --json`;

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => resolve(s));
  });
}

function post(port, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: apiPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
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
        source: { type: 'string' }, title: { type: 'string' }, prompt: { type: 'string' },
        model: { type: 'string' }, cwd: { type: 'string' }, desc: { type: 'string' },
        plan: { type: 'boolean' }, json: { type: 'boolean' }, port: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    console.error(`参数解析失败：${e.message}\n\n${HELP}`);
    process.exit(1);
  }
  if (values.help) { console.log(HELP); process.exit(0); }

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
      source: values.source, title: values.title, prompt,
      model: values.model, cwd: values.cwd, description: values.desc, plan: !!values.plan,
    };
  }

  let r;
  try {
    r = await post(port, '/api/task/create', body);
  } catch (e) {
    console.error(`连不上 app（127.0.0.1:${port}）：${e.message}\n确认 ScrumWS 正在运行（或用 --port / SCRUMWS_PORT 指定端口）。`);
    process.exit(1);
  }

  if (r.json?.ok) {
    const st = r.json.state;
    const label = st === 'processing' ? '已起会话执行' : st === 'plan' ? '已入计划（待看板确认执行）' : '已入队';
    console.log(`✓ ${label} ${r.json.taskKey}（state=${st}）${r.json.startError ? ` · 起会话失败：${r.json.startError}` : ''}`);
    process.exit(0);
  }
  console.error(`✗ 新建失败（HTTP ${r.status}）：${r.json?.error || r.raw || '未知错误'}`);
  process.exit(1);
}

main();
