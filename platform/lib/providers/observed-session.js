import { readAttachedSessions } from '../collect-cli.js';
import { readCodexAttachedSession, readCodexCliSessionHistory } from '../collect-codex-cli.js';
import { readCcSessionForAdopt } from '../logs.js';
import { normalizeProvider } from './registry.js';

// 外部 CLI 会话的只读接入点。新增 provider 时只需在这里补充占用检测与 JSONL 历史读取，
// 任务物化、状态机和后续 resume 都复用同一套 task-runner 流程。
const ACCESSORS = Object.freeze({
  claude: Object.freeze({
    active(sessionId) { return readAttachedSessions().get(sessionId) || null; },
    history(sessionId) { return readCcSessionForAdopt(sessionId); },
  }),
  codex: Object.freeze({
    active(sessionId) { return readCodexAttachedSession(sessionId); },
    history(sessionId, jsonlPath) { return readCodexCliSessionHistory(sessionId, jsonlPath); },
  }),
});

export function observedSessionAccess(provider) {
  return ACCESSORS[normalizeProvider(provider)] || null;
}

export function readObservedSession(provider, sessionId, jsonlPath = null) {
  const providerId = normalizeProvider(provider);
  const accessor = observedSessionAccess(providerId);
  if (!accessor) return { ok: false, error: `${providerId} 暂不支持外部 CLI session 读取` };
  const active = accessor.active(sessionId);
  // 进程探测刚启动时仍允许读取 JSONL 历史；只有发消息的 task-actions 会把 checking 当作写入锁。
  if (active && active.status !== 'checking') {
    const where = active.status === 'desktop' ? 'Codex Desktop' : `其他客户端（pid=${active.pid || '未知'}）`;
    return { ok: false, code: 'session-active', active, error: `session 正由${where}持有，请在原窗口回复` };
  }
  const history = accessor.history(sessionId, jsonlPath);
  return history?.ok ? { ...history, provider: providerId } : history;
}
