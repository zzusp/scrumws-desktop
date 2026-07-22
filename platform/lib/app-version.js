import fs from 'node:fs';
import path from 'node:path';

const RELEASE_API = 'https://api.github.com/repos/zzusp/scrumws-desktop/releases/latest';
const CACHE_MS = 6 * 60 * 60 * 1000;
const CURRENT_VERSION = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
).version;

let cached = null;

export function parseReleaseVersion(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag || '').trim());
  return match ? match.slice(1).map(Number) : null;
}

export function isNewerVersion(candidate, current = CURRENT_VERSION) {
  const next = parseReleaseVersion(candidate);
  const now = parseReleaseVersion(current);
  if (!next || !now) return false;
  for (let i = 0; i < 3; i += 1) {
    if (next[i] !== now[i]) return next[i] > now[i];
  }
  return false;
}

export async function getAppVersionInfo({ fetchImpl = globalThis.fetch, now = Date.now(), force = false } = {}) {
  if (!force && cached && now - cached.checkedAtMs < CACHE_MS) return cached.value;

  const checkedAt = new Date(now).toISOString();
  const base = { ok: true, currentVersion: CURRENT_VERSION, latestVersion: null, updateAvailable: false, releaseUrl: null, checkedAt };
  try {
    const response = await fetchImpl(RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'scrumws-desktop' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`GitHub Releases API ${response.status}`);
    const release = await response.json();
    const parsed = parseReleaseVersion(release?.tag_name);
    if (!parsed) throw new Error('最新 Release tag 不是正式语义化版本');
    const latestVersion = parsed.join('.');
    const value = {
      ...base,
      latestVersion,
      updateAvailable: isNewerVersion(latestVersion),
      releaseUrl: typeof release?.html_url === 'string' ? release.html_url : null,
    };
    cached = { checkedAtMs: now, value };
    return value;
  } catch (error) {
    const value = { ...base, ok: false, error: error.message };
    cached = { checkedAtMs: now, value };
    return value;
  }
}

export function resetAppVersionCache() {
  cached = null;
}
