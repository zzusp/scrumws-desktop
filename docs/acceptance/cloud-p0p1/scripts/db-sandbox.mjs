// 一次性验收库：建库 → 跑全量迁移 → 用完 drop。
// 为什么不就地用 .env 的 scrumws：多 worktree 共用同一远程 dev 库，就地验会把验收数据混进去，
// 且别人的残留行会让「云端看到 5 个任务」这类断言失去意义（用户 CLAUDE.md「共享远程资源别就地验证」）。
//
// 用法（DATABASE_URL 从仓库根 .env 注入，绝不落命令行 / 日志）：
//   node db-sandbox.mjs --check    零副作用自检：连库、验迁移文件、打印将要做什么
//   node db-sandbox.mjs --create   建库 + 跑 001_p0p1_init.sql
//   node db-sandbox.mjs --drop     DROP DATABASE ... WITH (FORCE)
//   node db-sandbox.mjs --url      只打印验收库的连接串（供其它脚本 eval 取用）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadEnv, REPO_ROOT } from './env.mjs';

loadEnv();

// pg 从 cloud/ 解析：本脚本住在 docs/ 下（无 node_modules），而根 package.json 必须保持
// 只有 electron / electron-builder 两个 devDep（契约 §1.1 红线）——绝不为验收脚本往根上装依赖。
const pg = createRequire(path.join(REPO_ROOT, 'cloud/package.json'))('pg');

export const SANDBOX_DB = 'scrumws_p1_verify';
const MIGRATION = path.join(REPO_ROOT, 'cloud/migrations/001_p0p1_init.sql');

/** 把连接串的库名换成验收库；其余（主机/端口/凭据）原样沿用。 */
function withDb(name) {
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = '/' + name;
  return u.toString();
}
/** 打印用：绝不回显主机 / 凭据 —— 只说库名。 */
const safe = (name) => `<DATABASE_URL 同主机>/${name}`;

export const sandboxUrl = () => withDb(SANDBOX_DB);

const adminUrl = () => {
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = '/postgres'; // 建/删库不能连在目标库上
  return u.toString();
};

async function withClient(url, fn) {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const arg = process.argv[2] || '--check';

if (arg === '--url') {
  process.stdout.write(sandboxUrl());
} else if (arg === '--check') {
  if (!fs.existsSync(MIGRATION)) throw new Error('找不到迁移文件：' + MIGRATION);
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const tables = [...sql.matchAll(/create table (\w+)/g)].map((m) => m[1]);
  await withClient(adminUrl(), async (c) => {
    const v = await c.query('select version()');
    console.log('[check] 库可达：', v.rows[0].version.split(',')[0]);
    const e = await c.query('select 1 from pg_database where datname=$1', [SANDBOX_DB]);
    console.log('[check] 验收库', safe(SANDBOX_DB), e.rowCount ? '已存在（--create 会先 drop 再建）' : '不存在（--create 会新建）');
  });
  console.log(`[check] 迁移 001_p0p1_init.sql 将建 ${tables.length} 张表：`, tables.join(' '));
  console.log('[check] 零副作用自检完成，未写任何行');
} else if (arg === '--create') {
  await withClient(adminUrl(), async (c) => {
    await c.query(`drop database if exists ${SANDBOX_DB} with (force)`);
    await c.query(`create database ${SANDBOX_DB}`);
  });
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  await withClient(sandboxUrl(), async (c) => { await c.query(sql); });
  const n = await withClient(sandboxUrl(), (c) =>
    c.query("select count(*)::int n from information_schema.tables where table_schema='public'"));
  console.log(`[create] ${safe(SANDBOX_DB)} 就绪，public 表数 = ${n.rows[0].n}`);
} else if (arg === '--drop') {
  await withClient(adminUrl(), (c) => c.query(`drop database if exists ${SANDBOX_DB} with (force)`));
  console.log(`[drop] ${safe(SANDBOX_DB)} 已删除`);
} else {
  throw new Error('未知参数：' + arg);
}
