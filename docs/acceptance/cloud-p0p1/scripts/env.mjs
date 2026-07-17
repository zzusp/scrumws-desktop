// 把仓库根 .env 读进 process.env（仅本机验收脚本用）。
// ⚠ 只注入，不打印：DATABASE_URL 的任何片段都不得进日志 / 文档 / 提交（契约 §11）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** 读 .env 的 KEY=VALUE（忽略注释 / 空行），只填补 process.env 里还没有的键。 */
export function loadEnv() {
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
