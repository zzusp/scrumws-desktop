// 一次性验收库上验证 002_p2_intent_dispatch.sql：建库 → 跑 001 → 跑 002 → 断言 → 无论成败都 DROP。
// 绝不碰生产库 scrumws（用户 CLAUDE.md「共享远程资源别就地验证」+ 本任务硬约束 3）。
//
// 用法（DATABASE_URL 从仓库根 .env 注入，绝不落命令行 / 日志）：
//   node verify-002.mjs --check   零副作用自检：连库、验两个迁移文件在位、打印将要做什么
//   node verify-002.mjs --run     建一次性库 scrumws_p2_verify → 001 → 灌样本行 → 002 → 断言 → DROP
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');

// pg 从 cloud/ 解析（根 package.json 只准有 electron/electron-builder 两个 devDep，硬约束 1）
const pg = createRequire(path.join(REPO_ROOT, 'cloud/package.json'))('pg');

const M001 = path.join(REPO_ROOT, 'cloud/migrations/001_p0p1_init.sql');
const M002 = path.join(REPO_ROOT, 'cloud/migrations/002_p2_intent_dispatch.sql');
const SANDBOX_DB = 'scrumws_p2_verify';

function loadEnv() {
  const file = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(file)) throw new Error('仓库根缺少 .env');
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const val = m[2].trim().replace(/^["'](.*)["']$/, '$1');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
  if (!process.env.DATABASE_URL) throw new Error('.env 里没有 DATABASE_URL');
}

const urlWithDb = (name) => { const u = new URL(process.env.DATABASE_URL); u.pathname = '/' + name; return u.toString(); };
const adminUrl = () => urlWithDb('postgres');
const sandboxUrl = () => urlWithDb(SANDBOX_DB);
const safe = (name) => `<DATABASE_URL 同主机>/${name}`;

async function withClient(url, fn) {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

let pass = 0, fail = 0;
function assert(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

const arg = process.argv[2] || '--check';

if (arg === '--check') {
  loadEnv();
  for (const f of [M001, M002]) if (!fs.existsSync(f)) throw new Error('找不到迁移文件：' + f);
  await withClient(adminUrl(), async (c) => {
    const v = await c.query('select version()');
    console.log('[check] 库可达：', v.rows[0].version.split(',')[0]);
    const e = await c.query('select 1 from pg_database where datname=$1', [SANDBOX_DB]);
    console.log('[check] 验收库', safe(SANDBOX_DB), e.rowCount ? '已存在（--run 会先 drop 再建）' : '不存在（--run 会新建）');
  });
  console.log('[check] 001 + 002 均在位；--run 会在一次性库上跑并断言后 DROP');
  console.log('[check] 零副作用自检完成，未写任何行，未碰生产库');
} else if (arg === '--run') {
  loadEnv();
  // 建库 + 001 + 002
  await withClient(adminUrl(), async (c) => {
    await c.query(`drop database if exists ${SANDBOX_DB} with (force)`);
    await c.query(`create database ${SANDBOX_DB}`);
  });
  console.log(`[run] 已建一次性库 ${safe(SANDBOX_DB)}`);
  try {
    await withClient(sandboxUrl(), async (c) => {
      await c.query(fs.readFileSync(M001, 'utf8'));
      console.log('[run] 001_p0p1_init.sql 跑通');

      // 灌 P1 既有形态：1 workspace / 1 user / 1 machine / 1 条 origin=local 任务 + status
      const ws = (await c.query(`insert into workspace(name,slug) values('W','w') returning id`)).rows[0].id;
      const u = (await c.query(`insert into app_user(name) values('U') returning id`)).rows[0].id;
      await c.query(`insert into member(workspace_id,user_id,role) values($1,$2,'owner')`, [ws, u]);
      const mac = (await c.query(
        `insert into machine(workspace_id,machine_uid,owner_user_id,display_name,status)
         values($1,'uid-1',$2,'M','online') returning id`, [ws, u])).rows[0].id;
      const localTask = (await c.query(
        `insert into task(workspace_id,machine_id,origin,title,local_task_key,local_created_at)
         values($1,$2,'local','本地任务','manual:20260101',now()) returning id`, [ws, mac])).rows[0].id;
      await c.query(
        `insert into task_status(task_id,state,rev) values($1,'processing','r1')`, [localTask]);
      console.log('[run] 已灌 1 条 origin=local 任务（含 task_status）');

      // 跑 002
      await c.query(fs.readFileSync(M002, 'utf8'));
      console.log('[run] 002_p2_intent_dispatch.sql 跑通\n');

      console.log('[断言]');
      // 1. origin 列仍在（绝不删列）
      const originCol = await c.query(
        `select data_type from information_schema.columns where table_name='task' and column_name='origin'`);
      assert('origin 列仍在（未删列）', originCol.rowCount === 1, `data_type=${originCol.rows[0]?.data_type}`);

      // 2. 四个新列的类型 / 可空性 / 默认
      const cols = Object.fromEntries((await c.query(
        `select column_name,data_type,is_nullable,column_default
           from information_schema.columns where table_name='task'
            and column_name in ('auto_run','dispatch','dispatched_at','reject_reason')`
      )).rows.map((r) => [r.column_name, r]));
      assert('auto_run boolean not null default false',
        cols.auto_run && cols.auto_run.data_type === 'boolean' && cols.auto_run.is_nullable === 'NO'
          && /false/.test(cols.auto_run.column_default || ''),
        JSON.stringify(cols.auto_run));
      assert('dispatch text 可空（origin=local 需 null）',
        cols.dispatch && cols.dispatch.data_type === 'text' && cols.dispatch.is_nullable === 'YES'
          && !cols.dispatch.column_default, JSON.stringify(cols.dispatch));
      assert('dispatched_at timestamptz 可空',
        cols.dispatched_at && cols.dispatched_at.is_nullable === 'YES'
          && /timestamp/.test(cols.dispatched_at.data_type), JSON.stringify(cols.dispatched_at));
      assert('reject_reason text 可空',
        cols.reject_reason && cols.reject_reason.data_type === 'text'
          && cols.reject_reason.is_nullable === 'YES', JSON.stringify(cols.reject_reason));

      // 3. 既有 origin=local 行未被删、未被改
      const localAfter = await c.query(
        `select origin,dispatch,auto_run from task where id=$1`, [localTask]);
      assert('origin=local 行仍在且 origin 不变', localAfter.rows[0]?.origin === 'local');
      assert('origin=local 行 dispatch 落 null（不经下发）', localAfter.rows[0]?.dispatch === null);
      assert('origin=local 行 auto_run 落 false（默认）', localAfter.rows[0]?.auto_run === false);

      // 4. 可以插入 origin=cloud 意图（dispatch=pending + creator 必填 check 满足）
      const cloudTask = (await c.query(
        `insert into task(workspace_id,machine_id,origin,creator_user_id,title,dispatch)
         values($1,$2,'cloud',$3,'云端意图','pending') returning id`, [ws, mac, u])).rows[0].id;
      assert('可插入 origin=cloud + dispatch=pending 意图', !!cloudTask);

      // 5. 001 的 check(origin=cloud ⇒ creator_user_id not null) 仍生效
      let creatorGuard = false;
      try {
        await c.query(`insert into task(workspace_id,machine_id,origin,title,dispatch)
                       values($1,$2,'cloud','缺发起人','pending')`, [ws, mac]);
      } catch { creatorGuard = true; }
      assert('origin=cloud 且 creator_user_id=null 被 check 挡下', creatorGuard);

      // 6. dispatch 脏值被 check 挡下
      let dispatchGuard = false;
      try {
        await c.query(`insert into task(workspace_id,machine_id,origin,creator_user_id,title,dispatch)
                       values($1,$2,'cloud',$3,'脏 dispatch','shipped')`, [ws, mac, u]);
      } catch { dispatchGuard = true; }
      assert("dispatch 非法值（'shipped'）被 check 挡下", dispatchGuard);

      // 7. 取件偏索引存在且是 partial (dispatch='pending')
      const idx = await c.query(
        `select indexdef from pg_indexes where tablename='task' and indexname='task_pending_intent_idx'`);
      assert('偏索引 task_pending_intent_idx 存在且为 partial(dispatch=pending)',
        idx.rowCount === 1 && /where\s+\(?dispatch = 'pending'/i.test(idx.rows[0].indexdef),
        idx.rows[0]?.indexdef);

      // 8. 取件查询**能**命中偏索引：小表上 planner 默认走 Seq Scan（3 行时更便宜），
      //    关掉 seqscan 逼它暴露「这个查询能用上该 index」即证明索引对查询有效。
      const plan = (await c.query(
        `explain (costs off) select id from task where machine_id=$1 and dispatch='pending'`, [mac],
      ).then(async (r0) => {
        await c.query('set enable_seqscan = off');
        const r = await c.query(
          `explain (costs off) select id from task where machine_id=$1 and dispatch='pending'`, [mac]);
        await c.query('set enable_seqscan = on');
        return r;
      })).rows.map((r) => r['QUERY PLAN']).join(' ');
      assert('取件查询可命中 task_pending_intent_idx（enable_seqscan=off 下）',
        /task_pending_intent_idx/.test(plan), plan.replace(/\s+/g, ' ').slice(0, 120));

      // 9. 取消未下发 = DELETE pending 行，unique(machine_id,local_task_key) 不受干扰
      //    （两条 local_task_key=null 的 pending 意图可并存，因为 unique 允许多个 null）
      const c2 = (await c.query(
        `insert into task(workspace_id,machine_id,origin,creator_user_id,title,dispatch)
         values($1,$2,'cloud',$3,'并存意图2','pending') returning id`, [ws, mac, u])).rows[0].id;
      assert('同机器可并存多条 local_task_key=null 的 pending 意图', !!c2);
      const del = await c.query(
        `delete from task where id=$1 and dispatch='pending' returning id`, [cloudTask]);
      assert('取消未下发意图 = DELETE pending 行成功', del.rowCount === 1);

      // 10. ack 回填 local_task_key 后，unique(machine_id,local_task_key) 仍挡重复
      await c.query(`update task set dispatch='delivered',dispatched_at=now(),local_task_key='cloud:x' where id=$1`, [c2]);
      let uniqGuard = false;
      try {
        await c.query(`insert into task(workspace_id,machine_id,origin,creator_user_id,title,local_task_key,dispatch)
                       values($1,$2,'cloud',$3,'重复key','cloud:x','delivered')`, [ws, mac, u]);
      } catch { uniqGuard = true; }
      assert('unique(machine_id,local_task_key) 挡住重复 taskKey', uniqGuard);
    });
  } finally {
    await withClient(adminUrl(), (c) => c.query(`drop database if exists ${SANDBOX_DB} with (force)`));
    console.log(`\n[run] 一次性库 ${safe(SANDBOX_DB)} 已 DROP`);
  }
  console.log(`\n[run] 断言汇总：PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
} else {
  throw new Error('未知参数：' + arg + '（用 --check | --run）');
}
