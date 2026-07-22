import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getAppVersionInfo, isNewerVersion, parseReleaseVersion, resetAppVersionCache } from '../../../../platform/lib/app-version.js';

assert.deepEqual(parseReleaseVersion('v1.2.3'), [1, 2, 3]);
assert.equal(parseReleaseVersion('v1.2.3-beta.1'), null);
assert.equal(isNewerVersion('0.2.0', '0.1.0'), true);
assert.equal(isNewerVersion('0.1.0', '0.1.0'), false);
assert.equal(isNewerVersion('0.0.9', '0.1.0'), false);

let calls = 0;
const releaseFetch = async () => {
  calls += 1;
  return { ok: true, json: async () => ({ tag_name: 'v9.8.7', html_url: 'https://github.com/zzusp/scrumws-desktop/releases/tag/v9.8.7' }) };
};
resetAppVersionCache();
const update = await getAppVersionInfo({ fetchImpl: releaseFetch, now: 1000 });
assert.equal(update.currentVersion, JSON.parse(fs.readFileSync(new URL('../../../../package.json', import.meta.url))).version);
assert.equal(update.latestVersion, '9.8.7');
assert.equal(update.updateAvailable, true);
assert.match(update.releaseUrl, /\/v9\.8\.7$/);
await getAppVersionInfo({ fetchImpl: releaseFetch, now: 2000 });
assert.equal(calls, 1, '六小时内应复用缓存');

resetAppVersionCache();
const failed = await getAppVersionInfo({ fetchImpl: async () => { throw new Error('offline'); }, now: 3000 });
assert.equal(failed.ok, false);
assert.equal(failed.updateAvailable, false);
assert.ok(failed.currentVersion);

resetAppVersionCache();
const invalid = await getAppVersionInfo({ fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'nightly' }) }), now: 4000 });
assert.equal(invalid.ok, false);
assert.equal(invalid.updateAvailable, false);

const html = fs.readFileSync(new URL('../../../../platform/public/index.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../../../../platform/public/app.js', import.meta.url), 'utf8');
assert.match(html, /id="appVersion"/);
assert.match(html, /id="appVersionText"/);
assert.match(js, /api\('\/api\/app-version'\)/);
assert.match(js, /refreshAppVersion\(\)/);

console.log('PASS app-version：版本比较、更新提示、失败降级、缓存与侧边栏结构');
