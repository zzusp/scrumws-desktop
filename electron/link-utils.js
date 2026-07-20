import { fileURLToPath } from 'node:url';

/**
 * 将 Chromium 交给主进程的链接识别为可由系统打开的本地路径。
 * 支持标准 file:// URL，也兼容 markdown 中常见的 Windows 盘符和 UNC 写法。
 */
export function localPathFromLink(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  const raw = url.trim();

  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'file:') return fileURLToPath(parsed);
  } catch {
    // 非 URL 的 Windows 路径继续按下方规则识别。
  }

  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* 保留原始路径 */ }
  if (/^[a-z]:[\\/]/i.test(decoded)) return decoded;
  if (/^\\\\[^\\/]+[\\/][^\\/]+/.test(decoded)) return decoded;
  return null;
}

/**
 * 将 markdown 里的绝对本地路径转为 file URL，避免被浏览器当成站内相对链接导航。
 */
export function localFileUrlFromMarkdownHref(href) {
  if (typeof href !== 'string' || !href.trim()) return null;
  const raw = href.trim();
  if (/^file:/i.test(raw)) return raw;

  if (/^[a-z]:[\\/]/i.test(raw)) {
    const path = raw.replace(/\\/g, '/');
    return `file:///${path.split('/').map(encodeURIComponent).join('/')}`;
  }
  if (/^\\\\[^\\/]+[\\/]/.test(raw)) {
    const path = raw.replace(/\\/g, '/').slice(2);
    return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
  }
  if (raw.startsWith('/')) return `file://${raw.split('/').map(encodeURIComponent).join('/')}`;
  return null;
}
