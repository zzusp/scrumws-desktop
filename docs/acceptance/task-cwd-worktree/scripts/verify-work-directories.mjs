// 工作目录管理端点验收：独立目录列表、worktree → base 收敛、与云端白名单隔离。
// 自带临时数据根和 standalone 进程，绝不读取或写入真实 ~/.scrumws。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'scrumws-workdirs-'));
const getPort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const port = await getPort();
const base = `http://127.0.0.1:${port}`;
const repo = 'D:\\project\\managed-repo';
const wt = `${repo}\\.claude\\worktrees\\fix-cwd`;
const other = 'D:\\project\\other-repo';
fs.mkdirSync(path.join(ROOT, 'runtime'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'runtime', 'runner-config.json'), JSON.stringify({ cloudAllowedCwds: ['D:\\cloud-only'] }, null, 2));

const child = spawn(process.execPath, ['platform/standalone.js'], {
  cwd: path.resolve(import.meta.dirname, '../../../..'),
  env: { ...process.env, SCRUMWS_DATA_ROOT: ROOT, SCRUMWS_PORT: String(port), SCRUMWS_SCHEDULER: '0' },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let output = '';
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });

async function request(method, pathname, body) {
  const r = await fetch(base + pathname, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}
async function ready() {
  for (let i = 0; i < 50; i++) {
    try { if ((await request('GET', '/api/work-directories')).status === 200) return; } catch { /* 等服务监听 */ }
    await wait(100);
  }
  throw new Error(`standalone 未在预期时间启动：${output}`);
}
let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) failed++;
}

try {
  await ready();
  let r = await request('GET', '/api/task/cwds');
  check('C1-cloud-list-not-reused', r.status === 200 && r.json?.cwds?.length === 0,
    `云端白名单存在时，新建任务下拉仍为空 → ${JSON.stringify(r.json?.cwds)}`);

  r = await request('POST', '/api/work-directories', { directories: [wt, repo, other, `${wt}\\src`] });
  check('C2-normalize-worktree-and-dedupe', r.status === 200 && JSON.stringify(r.json?.directories) === JSON.stringify([repo, other]),
    `保存 worktree/重复目录 → ${JSON.stringify(r.json?.directories)}`);

  r = await request('GET', '/api/task/cwds');
  check('C3-task-dropdown-managed-only', r.status === 200 && JSON.stringify(r.json?.cwds) === JSON.stringify([
    { cwd: repo, source: 'managed' }, { cwd: other, source: 'managed' },
  ]), `下拉仅返回已管理路径 → ${JSON.stringify(r.json?.cwds)}`);

  r = await request('POST', '/api/work-directories', { directories: 'not-array' });
  check('C4-reject-invalid-payload', r.status === 400 && r.json?.ok === false, `非数组拒绝 → ${r.status}`);

  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime', 'runner-config.json'), 'utf8'));
  check('C5-preserve-cloud-policy-and-store-paths', JSON.stringify(config.workDirectories) === JSON.stringify([repo, other])
    && JSON.stringify(config.cloudAllowedCwds) === JSON.stringify(['D:\\cloud-only']),
  `workDirectories=${JSON.stringify(config.workDirectories)} cloudAllowedCwds=${JSON.stringify(config.cloudAllowedCwds)}`);
} finally {
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  fs.rmSync(ROOT, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
