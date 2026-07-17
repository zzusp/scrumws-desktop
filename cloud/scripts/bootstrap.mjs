#!/usr/bin/env node
// 引导（契约 §6.0）—— 没有它谁也登不进来。
// 无密码、无注册、无 OAuth ⇒ 第一个 user / workspace / 登录密钥只能由服务端脚本创建。
//
//   node cloud/scripts/bootstrap.mjs --name "孙鹏" --workspace "scrumws" --check   # 零副作用自检，先跑这个
//   node cloud/scripts/bootstrap.mjs --name "孙鹏" --workspace "scrumws"
//
// DATABASE_URL 只从 process.env 读（禁止写死；.env 的值绝不可进源码/日志）。
//
// ⚠ bootstrap **不生成注册密钥**：registration_key.created_by 是 not null → 本就需要一个 user 在先。
//   注册密钥只有 POST /api/registration-keys 一条创建路径（§6.14），不给 bootstrap 加第二条，
//   省得两处各生成一半。
import { parseArgs } from 'node:util';
import { pool, withTx } from '../src/db.js';
import { mintCredential } from '../src/auth.js';

const REQUIRED_TABLES = [
  'app_user', 'enrollment_code', 'machine', 'machine_token', 'member', 'registration_key',
  'task', 'task_history', 'task_status', 'user_key', 'user_session', 'workspace',
];

const USAGE = `用法：
  node cloud/scripts/bootstrap.mjs --name <人名> --workspace <workspace 名> [--slug <slug>] [--label <密钥备注>] [--check]

  --name       人名（app_user.name）。同名 + 同 workspace 视为同一个人 → 只补发密钥
  --workspace  workspace 名（workspace.name）
  --slug       workspace.slug；缺省由 --workspace 生成。名字里没有 ASCII 字母数字时（如纯中文）必须显式给
  --label      登录密钥备注（user_key.label），默认 'bootstrap'
  --check      零副作用自检：连库 + 验表齐全 + 打印将要做什么，不写任何行
`;

const slugify = (s) => String(s).trim().toLowerCase().normalize('NFKD')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      workspace: { type: 'string' },
      slug: { type: 'string' },
      label: { type: 'string', default: 'bootstrap' },
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) { console.log(USAGE); return 0; }
  if (!values.name || !values.workspace) {
    console.error('缺少 --name 或 --workspace\n');
    console.error(USAGE);
    return 2;
  }

  const slug = values.slug ? slugify(values.slug) : slugify(values.workspace);
  if (!slug) {
    console.error(`无法从 --workspace "${values.workspace}" 生成 slug（里面没有 ASCII 字母数字）。请显式给 --slug，例如 --slug scrumws`);
    return 2;
  }

  // 1. 连库
  await pool.query('select 1');
  console.log('[1/3] 连库成功');

  // 2. 验表齐全（迁移是否跑过）
  const { rows: tables } = await pool.query(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_name = any($1::text[])`,
    [REQUIRED_TABLES],
  );
  const present = new Set(tables.map((r) => r.table_name));
  const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
  if (missing.length) {
    console.error(`[2/3] 缺表 ${missing.length} 张：${missing.join(', ')}`);
    console.error('      先跑迁移 cloud/migrations/001_p0p1_init.sql（执行方式见 cloud/README.md）');
    return 1;
  }
  console.log(`[2/3] 表齐全（${REQUIRED_TABLES.length} 张）`);

  // 3. 探明将要做什么（--check 到此为止，不写任何行）
  const ws = (await pool.query('select id, name, slug from workspace where slug = $1', [slug])).rows[0];
  const user = ws
    ? (await pool.query(
        `select u.id, u.name from app_user u
           join member m on m.user_id = u.id
          where m.workspace_id = $1 and u.name = $2
          order by u.created_at asc limit 1`,
        [ws.id, values.name],
      )).rows[0]
    : undefined;

  const plan = [
    ws ? `复用已存在的 workspace "${ws.name}"（slug=${ws.slug}）` : `新建 workspace "${values.workspace}"（slug=${slug}）`,
    user ? `复用已存在的用户 "${user.name}"` : `新建用户 "${values.name}" + member(role='owner')`,
    `生成一把登录密钥 swuk_（label=${values.label}），明文只打印一次`,
  ];

  if (values.check) {
    console.log('[3/3] --check：以下动作**未执行**（零副作用）：');
    for (const p of plan) console.log(`      · ${p}`);
    return 0;
  }

  const out = await withTx(async (c) => {
    // 幂等：同 slug 的 workspace 已存在 → 只补发密钥，不重建
    let w = (await c.query('select id, name, slug from workspace where slug = $1', [slug])).rows[0];
    if (!w) {
      w = (await c.query(
        'insert into workspace (name, slug) values ($1, $2) returning id, name, slug',
        [values.workspace, slug],
      )).rows[0];
    }
    let u = (await c.query(
      `select u.id, u.name from app_user u
         join member m on m.user_id = u.id
        where m.workspace_id = $1 and u.name = $2
        order by u.created_at asc limit 1`,
      [w.id, values.name],
    )).rows[0];
    if (!u) {
      u = (await c.query('insert into app_user (name) values ($1) returning id, name', [values.name])).rows[0];
      // bootstrap 是管理员逃生口，它建出来的人一律 owner（§6.0）
      await c.query(
        `insert into member (workspace_id, user_id, role) values ($1, $2, 'owner')
         on conflict (workspace_id, user_id) do nothing`,
        [w.id, u.id],
      );
    }
    // 库里只落 sha256 + prefix
    const key = mintCredential('swuk_');
    await c.query(
      'insert into user_key (user_id, key_hash, key_prefix, label) values ($1, $2, $3, $4)',
      [u.id, key.hash, key.prefix, values.label],
    );
    return { w, u, key };
  });

  console.log('[3/3] 完成：');
  for (const p of plan) console.log(`      · ${p}`);
  console.log('');
  console.log(`  workspace : ${out.w.name}  (id=${out.w.id}, slug=${out.w.slug})`);
  console.log(`  user      : ${out.u.name}  (id=${out.u.id})`);
  console.log('');
  console.log('  ===== 登录密钥（明文只此一次，请立刻存进密码管理器）=====');
  console.log('');
  console.log(`    ${out.key.plaintext}`);
  console.log('');
  console.log('  ========================================================');
  console.log('');
  console.log('  下一步（首次上机器的顺序）：');
  console.log('    1) 用它登录：POST /api/auth/login { "key": "swuk_…" }');
  console.log('    2) 生成注册密钥：POST /api/registration-keys   → swrk_…（明文也只此一次）');
  console.log('    3) 生成配对码：  POST /api/machines/enrollment-codes → 8 位码，10min 有效');
  console.log('    4) 桌面设置页贴：云端 URL + 注册密钥 + 配对码');
  return 0;
}

main()
  .then(async (code) => { await pool.end(); process.exit(code); })
  .catch(async (err) => {
    // 绝不回显 DATABASE_URL
    console.error('bootstrap 失败：', err.message);
    try { await pool.end(); } catch { /* 关池失败不掩盖原始错误 */ }
    process.exit(1);
  });
