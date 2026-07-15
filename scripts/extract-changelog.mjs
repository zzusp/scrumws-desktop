#!/usr/bin/env node
// 从 CHANGELOG.md 抽取指定版本的段落，打到 stdout —— 供发版 CI 填 GitHub Release 正文。
//
// 用法: node scripts/extract-changelog.mjs 0.1.1
// 找不到该版本段落时非零退出（CI 会 fail），逼着发版前先写 changelog、断开「发了版没记录」的路径。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const version = process.argv[2];
if (!version) {
  console.error('用法: node scripts/extract-changelog.mjs <version>  (如 0.1.1)');
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const md = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const lines = md.split(/\r?\n/);

// 段落起点: `## [0.1.1]`（后面可跟 ` - 日期`），终点: 下一个 `## [` 或文末的链接引用块。
const startIdx = lines.findIndex((l) => new RegExp(`^##\\s+\\[${version.replace(/\./g, '\\.')}\\]`).test(l));
if (startIdx === -1) {
  console.error(`error: CHANGELOG.md 里找不到版本段落 "## [${version}]" —— 发版前请先在 CHANGELOG.md 记录本次变更`);
  process.exit(1);
}

const body = [];
for (let i = startIdx + 1; i < lines.length; i++) {
  const l = lines[i];
  if (/^##\s+\[/.test(l)) break; // 下一个版本段落
  if (/^\[[^\]]+\]:\s+https?:\/\//.test(l)) break; // 文末链接引用定义块
  body.push(l);
}

const out = body.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
process.stdout.write(out + '\n');
