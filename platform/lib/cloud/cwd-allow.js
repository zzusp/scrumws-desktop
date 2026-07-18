import fs from 'node:fs';
import path from 'node:path';

// §7.2 / 决策 10：云端任务的 cwd 白名单判定。**这是唯一不依赖云端诚实的防线**——判据在本地
// （runner-config.cloudAllowedCwds），云端只提供 cwd 这个输入，不提供结论。
// 默认空 = 拒绝一切云端任务：机器主人不显式加目录，云端就没有落脚点。

// 归一化到「可比较」形态：解析 .. / 符号链接 / junction / Windows 8.3 短名，再按平台定大小写。
// 解不开（目录不存在）→ null → 一律拒绝：白名单比对必须在**真实路径**上做，否则 D:\a\..\b、
// D:\PROGRA~1 这类写法能绕过任何字符串前缀比较。
function canon(p) {
  const s = String(p || '').trim();
  if (!s) return null;
  if (!path.isAbsolute(s)) return null;   // 相对路径不收：path.resolve 会拿进程 CWD 兜底 → 不可预期
  let r;
  try { r = fs.realpathSync.native(path.resolve(s)); } catch { return null; }
  return process.platform === 'win32' ? r.toLowerCase() : r;   // Windows 路径大小写不敏感
}

/**
 * cwd 是否落在白名单某条目之下（含条目自身）。
 * @param {string} cwd 云端下发的工作目录
 * @param {string[]} allowList runner-config.cloudAllowedCwds
 * @returns {boolean} 空 / 缺省 / 脏值 → false（§7.2 默认拒绝一切）
 */
export function isCwdAllowed(cwd, allowList) {
  const c = canon(cwd);
  if (!c) return false;
  if (!Array.isArray(allowList) || allowList.length === 0) return false;
  for (const entry of allowList) {
    const a = canon(entry);
    if (!a) continue;
    if (c === a) return true;
    // ⚠ 必须补分隔符再比前缀：裸 startsWith 会让白名单 D:\proj 放行 D:\projEVIL
    const prefix = a.endsWith(path.sep) ? a : a + path.sep;
    if (c.startsWith(prefix)) return true;
  }
  return false;
}
