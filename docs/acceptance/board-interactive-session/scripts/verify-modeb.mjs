#!/usr/bin/env node
// verify-modeb.mjs — Mode B（看板持有交互式 claude）前置验证 · 跨平台（macOS/Windows）
//
// 验证目标（对应 goal.md 的 S11）：
//   A. 本机 claude 支持 Mode B 所需的全部 flag（--include-partial-messages / --input-format /
//      --output-format / --resume / --verbose）。
//   B. `--permission-prompt-tool stdio` 生效：工具权限被委派到 stdin 对端（吐 can_use_tool
//      control_request，且工具在收到 control_response 前不执行）。
//   C. dws 鉴权与 claude 的关系（旁证）：dws 是 claude 调用的工具，非 claude 鉴权器。
//
// 用法：
//   node verify-modeb.mjs --check     零副作用：只查版本 + flag，不 spawn claude、不花 quota
//   node verify-modeb.mjs             完整：跑 stream-json + 权限委派冒烟（花极少 haiku quota）
//   node verify-modeb.mjs --model <m> 指定模型（默认 claude-haiku-4-5-20251001，最省）
//
// 退出码：0 全 PASS；1 有 FAIL；2 用法/环境错误。

import { spawn, execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const MODEL = (() => {
  const i = argv.indexOf('--model');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : 'claude-haiku-4-5-20251001';
})();
// 让 Windows 按 PATHEXT 同时解析 claude.exe/.cmd；不要硬编码某一种包装格式。
const CLAUDE = 'claude';

const results = []; // {name, ok, detail}
const rec = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`); };

function run(file, args, { timeout = 30000, input = null } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    const p = execFile(file, args, { timeout, windowsHide: true, shell: process.platform === 'win32', maxBuffer: 8 * 1024 * 1024 }, (e, so, se) => {
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, out: so || out, err: se || err });
    });
    if (input != null) { p.stdin.write(input); p.stdin.end(); }
  });
}

async function checkFlags() {
  console.log('\n== A. claude 版本 + flag ==');
  const ver = await run(CLAUDE, ['--version']).catch(() => null);
  if (!ver || ver.code !== 0) { rec('claude 可执行', false, '找不到 claude，PATH 里没有？'); return false; }
  console.log(`  claude 版本：${(ver.out || '').trim().split('\n')[0]}`);
  const help = await run(CLAUDE, ['--help']);
  const H = (help.out || '') + (help.err || '');
  const need = ['--include-partial-messages', '--input-format', '--output-format', '--resume', '--verbose'];
  let allFlags = true;
  for (const f of need) { const ok = H.includes(f); if (!ok) allFlags = false; rec(`flag ${f}`, ok); }
  // --permission-prompt-tool 在部分版本是 hidden（不在 help 里也可能生效）——只提示不判 FAIL
  console.log(`  note: --permission-prompt-tool ${H.includes('--permission-prompt-tool') ? '在 help 中可见' : '不在 help（hidden，实测阶段验证是否生效）'}`);
  return allFlags;
}

async function checkDws() {
  console.log('\n== C. dws 鉴权（旁证，与 claude 模型鉴权相互独立）==');
  const r = await run('dws', ['auth', 'status', '--format', 'json'], { timeout: 15000 }).catch(() => null);
  if (!r || (r.code !== 0 && !(r.out || '').trim())) { console.log('  dws 不在 PATH 或不可用（本机无分身工具，跳过；不影响 Mode B 跑 claude）'); return; }
  let s = null; try { s = JSON.parse((r.out || '').trim()); } catch {}
  if (s) console.log(`  dws auth: authenticated=${s.authenticated} token_valid=${s.token_valid} refresh_valid=${s.refresh_token_valid}`);
  else console.log(`  dws auth status（原始）：${(r.out || r.err || '').trim().slice(0, 200)}`);
  console.log('  结论：dws 是 claude 当工具调的分身 API；claude 跑模型不依赖 dws。');
}

// 核心：stream-json + --permission-prompt-tool stdio → 期望吐 can_use_tool 且工具不执行
function smokePermission() {
  return new Promise((resolve) => {
    console.log('\n== B. --permission-prompt-tool stdio 权限委派冒烟 ==');
    const target = path.join(os.tmpdir(), `modeb-verify-${process.pid}.txt`);
    try { fs.rmSync(target, { force: true }); } catch {}
    const msg = JSON.stringify({ type: 'user', message: { role: 'user', content: `Use the Write tool to create the file ${target} with the exact content: hi` } });
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompt-tool', 'stdio', '--model', MODEL];
    const child = spawn(CLAUDE, args, { windowsHide: true, shell: process.platform === 'win32' });
    let buf = '', sawCanUseTool = false, sawToolUse = null, flagRejected = false, doneCalled = false;
    const finish = (verdict, detail) => {
      if (doneCalled) return; doneCalled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      const created = fs.existsSync(target);
      try { fs.rmSync(target, { force: true }); } catch {}
      rec('B1 flag stdio 被接受（未报 unknown option）', !flagRejected);
      rec('B2 吐 can_use_tool control_request', sawCanUseTool, sawToolUse ? `tool_use=${sawToolUse}` : '');
      rec('B3 工具在授权前未执行（目标文件未创建）', sawCanUseTool && !created, created ? '文件被创建=没委派' : '');
      resolve();
    };
    const timer = setTimeout(() => finish('timeout'), 30000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl; while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        const t = line.trim(); if (!t.startsWith('{')) continue;
        let o; try { o = JSON.parse(t); } catch { continue; }
        if (o.type === 'assistant') for (const c of o.message?.content || []) if (c.type === 'tool_use') sawToolUse = c.name;
        if (o.type === 'control_request' && JSON.stringify(o).includes('can_use_tool')) { sawCanUseTool = true; finish('ok'); }
      }
    });
    child.stderr.on('data', (d) => { if (/unknown option|invalid.*permission-prompt/i.test(d.toString())) { flagRejected = true; finish('rejected'); } });
    child.on('error', (e) => { rec('claude spawn', false, e.message); finish('spawn-error'); });
    // 喂一条 user 消息，然后保持 stdin 打开（不 end），让 claude 有机会回 control_request 并等待
    child.stdin.write(msg + '\n');
    // stdin 故意不 end；finish() 里 kill 时一并关闭
  });
}

(async () => {
  console.log(`Mode B 前置验证 · platform=${process.platform} model=${MODEL} mode=${CHECK_ONLY ? '--check(零副作用)' : '完整冒烟'}`);
  const flagsOk = await checkFlags();
  await checkDws();
  if (!CHECK_ONLY) {
    if (!flagsOk) console.log('\n(flag 不全，仍尝试冒烟以拿到真实报错)');
    await smokePermission();
  } else {
    console.log('\n== B. 跳过（--check 零副作用模式，不 spawn claude）==');
  }
  const fails = results.filter((r) => !r.ok);
  console.log(`\n=== 汇总：${results.length - fails.length}/${results.length} PASS ===`);
  if (fails.length) { console.log('FAIL：' + fails.map((f) => f.name).join('; ')); process.exit(1); }
  process.exit(0);
})();
