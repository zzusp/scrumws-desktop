#!/usr/bin/env node
// P2 本地下行「纯逻辑」单测：cwd-allow / gate / links 的边界（integration 不便覆盖的角）。零副作用、秒回。
//   node verify-gate-logic.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const imp = (p) => import(pathToFileURL(path.join(REPO, p)).href);
const { isCwdAllowed } = await imp('platform/lib/cloud/cwd-allow.js');
const { computeAutoExec, acceptAutoRunMode } = await imp('platform/lib/cloud/gate.js');

const results = [];
const t = (name, cond, ev) => { results.push({ ok: !!cond, name }); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${ev ? `  (${ev})` : ''}`); };

// ---- cwd-allow ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2cwd-'));
const allowed = path.join(tmp, 'proj');
const sibling = path.join(tmp, 'projEVIL');     // 与白名单前缀相邻（裸 startsWith 会误放行）
const child = path.join(allowed, 'sub', 'deep');
fs.mkdirSync(child, { recursive: true });
fs.mkdirSync(sibling, { recursive: true });

t('cwd 空白名单 → 拒绝一切', isCwdAllowed(allowed, []) === false);
t('cwd 白名单为 undefined → 拒绝', isCwdAllowed(allowed, undefined) === false);
t('cwd 精确命中白名单条目 → 放行', isCwdAllowed(allowed, [allowed]) === true);
t('cwd 是白名单目录的子目录 → 放行', isCwdAllowed(child, [allowed]) === true);
t('cwd 前缀相邻的兄弟目录 → 拒绝（projEVIL 不被 proj 放行）', isCwdAllowed(sibling, [allowed]) === false);
t('cwd 相对路径 → 拒绝（不拿进程 CWD 兜底）', isCwdAllowed('proj', [allowed]) === false);
t('cwd 不存在的绝对路径 → 拒绝（realpath 解不开）', isCwdAllowed(path.join(tmp, 'ghost'), [allowed]) === false);
t('cwd 空串 → 拒绝', isCwdAllowed('', [allowed]) === false);
// .. 穿越归一后落回白名单内 → 放行；落到白名单外 → 拒绝
t('cwd 含 .. 归一后仍在白名单内 → 放行', isCwdAllowed(path.join(allowed, 'sub', '..', 'sub'), [allowed]) === true);
t('cwd 含 .. 归一后逃出白名单 → 拒绝', isCwdAllowed(path.join(allowed, '..', 'projEVIL'), [allowed]) === false);
fs.rmSync(tmp, { recursive: true, force: true });

// ---- gate: acceptAutoRunMode 默认/脏值 ----
t('acceptAutoRunMode 缺省 → owner-only', acceptAutoRunMode({}) === 'owner-only');
t('acceptAutoRunMode 脏值 → owner-only（打错字不放宽）', acceptAutoRunMode({ acceptAutoRun: 'ON!!' }) === 'owner-only');
t('acceptAutoRunMode 合法值原样', acceptAutoRunMode({ acceptAutoRun: 'off' }) === 'off');

// ---- gate: computeAutoExec 全组合 ----
const OWNER = 'u-owner';
const mk = (autoRun, createdBy) => ({ autoRun, createdBy: { userId: createdBy } });
const idOwner = { ownerUserId: OWNER };
const idNoOwner = { ownerUserId: null };    // 老 identity.json（P1 升级）

t('autoRun=false → 恒 false（任何档）', computeAutoExec({ intent: mk(false, OWNER), cfg: { acceptAutoRun: 'on' }, identity: idOwner }) === false);
t('off 档 + autoRun → false', computeAutoExec({ intent: mk(true, OWNER), cfg: { acceptAutoRun: 'off' }, identity: idOwner }) === false);
t('on 档 + autoRun + 别人派 → true', computeAutoExec({ intent: mk(true, 'u-other'), cfg: { acceptAutoRun: 'on' }, identity: idOwner }) === true);
t('owner-only + autoRun + 自己派 → true', computeAutoExec({ intent: mk(true, OWNER), cfg: { acceptAutoRun: 'owner-only' }, identity: idOwner }) === true);
t('owner-only + autoRun + 别人派 → false', computeAutoExec({ intent: mk(true, 'u-other'), cfg: { acceptAutoRun: 'owner-only' }, identity: idOwner }) === false);
t('owner-only + autoRun + identity 无 ownerUserId → false（fail-closed，P1 升级路径）', computeAutoExec({ intent: mk(true, OWNER), cfg: { acceptAutoRun: 'owner-only' }, identity: idNoOwner }) === false);
t('owner-only + createdBy 缺失 → false（fail-closed）', computeAutoExec({ intent: { autoRun: true }, cfg: { acceptAutoRun: 'owner-only' }, identity: idOwner }) === false);
t('缺省档（脏 cfg）+ 自己派 → 走 owner-only 语义 = true', computeAutoExec({ intent: mk(true, OWNER), cfg: {}, identity: idOwner }) === true);

// ---- links: 占位态不算「已建成」----
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p2links-'));
process.env.SCRUMWS_DATA_ROOT = dataRoot;   // paths.js 读它（须在 import links.js 前设）
const { readLinks, writeLinks, linkedTaskKeys } = await imp('platform/lib/cloud/links.js');
t('links 不存在 → {}', Object.keys(readLinks()).length === 0);
writeLinks({ 'i-1': { taskKey: null, reservedAt: 'now' }, 'i-2': { taskKey: 'cloud:abc-123', reservedAt: 'now', createdAt: 'now', ackedAt: null } });
const lk = linkedTaskKeys();
t('linkedTaskKeys 只收 taskKey 非 null 的（占位 i-1 不算）', lk.size === 1 && lk.has('cloud:abc-123') && !lk.has(null));
t('readLinks 回读一致', readLinks()['i-2']?.taskKey === 'cloud:abc-123');
fs.rmSync(dataRoot, { recursive: true, force: true });

const bad = results.filter((r) => !r.ok);
console.log(`\n== ${results.length - bad.length}/${results.length} PASS ==`);
process.exit(bad.length ? 1 : 0);
