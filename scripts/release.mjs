#!/usr/bin/env node
// 本地一键发版：finalize CHANGELOG → bump package.json → commit → tag → push。
// push tag 会触发 .github/workflows/release.yml 打包 Windows + macOS 并发布 GitHub Release。
//
// 用法:
//   npm run release 0.1.1            # 正式发版
//   npm run release 0.1.1 --dry-run  # 零副作用自检：只打印将做的改动，不写文件、不 commit/tag/push
//
// 前置：把本次变更写进 CHANGELOG.md 的 [Unreleased] 段落（脚本会把它 finalize 成 [0.1.1] - 日期）。

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || args.includes('--check');
const version = args.find((a) => !a.startsWith('-'));

function die(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}
function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8' }).trim();
}

// ── 1. 参数校验 ──
if (!version) die('用法: npm run release <版本号>  (如 0.1.1)，可加 --dry-run 自检');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) die(`版本号 "${version}" 不合法，应形如 0.1.1`);

const pkgPath = join(root, 'package.json');
const pkgRaw = readFileSync(pkgPath, 'utf8');
const curVersion = JSON.parse(pkgRaw).version;
if (version === curVersion) die(`版本号 ${version} 与 package.json 当前版本相同，先递增`);

// ── 2. 工作区必须干净（tracked 文件无改动；untracked 忽略）──
const dirty = git('status --porcelain')
  .split('\n')
  .filter((l) => l && !l.startsWith('??'));
if (dirty.length) {
  const msg = `工作区有未提交的改动，先提交或撤销：\n${dirty.join('\n')}`;
  if (dryRun) console.warn(`\x1b[33m⚠ ${msg}\x1b[0m`);
  else die(msg);
}

const branch = git('rev-parse --abbrev-ref HEAD');
const repoUrl = git('remote get-url origin')
  .replace(/\.git$/, '')
  .replace(/^git@github\.com:/, 'https://github.com/');

// ── 3. finalize CHANGELOG：[Unreleased] → [version] - date，顶部补空 [Unreleased] ──
const clPath = join(root, 'CHANGELOG.md');
const cl = readFileSync(clPath, 'utf8');
const lines = cl.split('\n');
const unrelIdx = lines.findIndex((l) => /^##\s+\[Unreleased\]/i.test(l));
if (unrelIdx === -1) die('CHANGELOG.md 找不到 "## [Unreleased]" 段落');

// 取 Unreleased 正文（到下一个 `## [` 前）
let endIdx = lines.length;
for (let i = unrelIdx + 1; i < lines.length; i++) {
  if (/^##\s+\[/.test(lines[i]) || /^\[[^\]]+\]:\s+https?:\/\//.test(lines[i])) { endIdx = i; break; }
}
const bodyLines = lines.slice(unrelIdx + 1, endIdx);
const hasContent = bodyLines.some((l) => /^\s*[-*]\s+\S/.test(l));
if (!hasContent) die('CHANGELOG.md 的 [Unreleased] 段落没有任何条目，先记录本次变更再发版');

const today = new Date().toISOString().slice(0, 10);
const body = bodyLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
const finalizedSection = [
  '## [Unreleased]',
  '',
  `## [${version}] - ${today}`,
  '',
  body,
  '',
].join('\n');

// 重建正文 + 更新底部链接引用
let newLines = [...lines.slice(0, unrelIdx), ...finalizedSection.split('\n'), ...lines.slice(endIdx)];
newLines = newLines.map((l) =>
  /^\[Unreleased\]:/i.test(l) ? `[Unreleased]: ${repoUrl}/compare/v${version}...HEAD` : l,
);
const unrelLinkIdx = newLines.findIndex((l) => /^\[Unreleased\]:/i.test(l));
if (unrelLinkIdx !== -1) {
  newLines.splice(unrelLinkIdx + 1, 0, `[${version}]: ${repoUrl}/releases/tag/v${version}`);
}
const newCl = newLines.join('\n');

// ── 4. bump package.json（正则替换首个 version，保留原格式）──
const newPkg = pkgRaw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
if (newPkg === pkgRaw) die('package.json 里没找到 version 字段');

// ── 5. 执行 / 干跑 ──
const tag = `v${version}`;
console.log(`\n\x1b[36m发版 ${curVersion} → ${version}\x1b[0m  (分支 ${branch}, tag ${tag})\n`);
console.log('─ 本次 Release 正文（来自 CHANGELOG [Unreleased]）─');
console.log(body);
console.log('─────────────────────────────────────────────\n');

if (dryRun) {
  console.log('\x1b[33m[dry-run] 未写任何文件、未 commit/tag/push。将执行：\x1b[0m');
  console.log(`  写 CHANGELOG.md（finalize [${version}] - ${today}）`);
  console.log(`  写 package.json（version → ${version}）`);
  console.log(`  git add CHANGELOG.md package.json`);
  console.log(`  git commit -m "release: ${tag}"`);
  console.log(`  git tag ${tag}`);
  console.log(`  git push origin ${branch}`);
  console.log(`  git push origin ${tag}   ← 这一步触发 GitHub Actions 打包发布`);
  process.exit(0);
}

writeFileSync(clPath, newCl);
writeFileSync(pkgPath, newPkg);
git('add CHANGELOG.md package.json');
execSync(`git commit -m "release: ${tag}"`, { cwd: root, stdio: 'inherit' });
git(`tag ${tag}`);
console.log(`\n推送分支 ${branch} 与 tag ${tag} …`);
execSync(`git push origin ${branch}`, { cwd: root, stdio: 'inherit' });
execSync(`git push origin ${tag}`, { cwd: root, stdio: 'inherit' });

console.log(`\n\x1b[32m✓ ${tag} 已推送。GitHub Actions 正在打包发布：\x1b[0m`);
console.log(`  ${repoUrl}/actions`);
console.log(`  ${repoUrl}/releases/tag/${tag}`);
