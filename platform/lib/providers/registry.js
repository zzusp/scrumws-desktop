import { execFile } from 'node:child_process';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';

const CLAUDE_MODELS = Object.freeze([
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
  'claude-fable-5',
]);
const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
// 这些是桌面端提供的 Codex 快捷模型；空 model 仍表示交给本机 Codex CLI/账号选择默认模型。
const CODEX_MODELS = Object.freeze(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']);
const CODEX_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

const DEFINITIONS = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    models: CLAUDE_MODELS,
    allowCustomModel: false,
    efforts: CLAUDE_EFFORTS,
    defaultModel: 'claude-opus-4-8',
    defaultEffort: 'xhigh',
    capabilities: Object.freeze({
      approvals: true,
      interrupt: true,
      backgroundTasks: true,
      terminalObserve: true,
      terminalAdopt: true,
      rewind: true,
      dynamicWorkflow: true,
      accountUsage: true,
    }),
    createAdapter(options) { return new ClaudeAdapter({ ...options, command: options?.command || 'claude' }); },
  }),
  codex: Object.freeze({
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    models: CODEX_MODELS,
    allowCustomModel: true,
    efforts: CODEX_EFFORTS,
    defaultModel: '',
    defaultEffort: 'high',
    capabilities: Object.freeze({
      approvals: true,
      interrupt: true,
      backgroundTasks: false,
      terminalObserve: false,
      terminalAdopt: false,
      rewind: false,
      dynamicWorkflow: false,
      accountUsage: false,
    }),
    createAdapter(options) { return new CodexAdapter({ ...options, command: options?.command || 'codex' }); },
  }),
});

function publicDefinition(definition) {
  if (!definition) return null;
  return {
    id: definition.id,
    label: definition.label,
    command: definition.command,
    models: [...definition.models],
    allowCustomModel: definition.allowCustomModel,
    efforts: [...definition.efforts],
    defaultModel: definition.defaultModel,
    defaultEffort: definition.defaultEffort,
    capabilities: { ...definition.capabilities },
  };
}

export function normalizeProvider(id) {
  const value = String(id ?? '').trim().toLowerCase();
  return value || 'claude';
}

export function getProviderDefinition(id) {
  return DEFINITIONS[normalizeProvider(id)] || null;
}

export function listProviderDefinitions() {
  return Object.values(DEFINITIONS).map(publicDefinition);
}

export function validateProviderSelection({ provider, model, effort, dynamicWorkflow } = {}) {
  const providerId = normalizeProvider(provider);
  const definition = DEFINITIONS[providerId];
  if (!definition) return { ok: false, error: `未知 provider：${providerId}` };

  const selectedModel = String(model ?? '').trim();
  const selectedEffort = String(effort ?? '').trim();
  if (selectedModel && !definition.allowCustomModel && !definition.models.includes(selectedModel)) {
    return { ok: false, error: `model 不在 ${definition.label} 白名单：${definition.models.join(', ')}` };
  }
  if (selectedModel && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(selectedModel)) {
    return { ok: false, error: 'model 只能包含字母、数字、点、下划线、冒号、斜杠和连字符，且长度不超过 200' };
  }
  if (selectedEffort && !definition.efforts.includes(selectedEffort)) {
    return { ok: false, error: `effort 不在 ${definition.label} 白名单：${definition.efforts.join(', ')}` };
  }
  if (dynamicWorkflow === true && !definition.capabilities.dynamicWorkflow) {
    return { ok: false, error: `${definition.label} 不支持 dynamicWorkflow` };
  }
  return { ok: true, provider: providerId, model: selectedModel, effort: selectedEffort, definition };
}

export function resolveProviderSelection(selection = {}, config = {}) {
  const provider = normalizeProvider(selection.provider ?? config.defaultProvider);
  const definition = DEFINITIONS[provider];
  if (!definition) return { ok: false, error: `未知 provider：${provider}` };
  const providerDefaults = config.providerDefaults?.[provider] || {};
  const legacyClaudeModel = provider === 'claude' ? config.defaultModel : undefined;
  const model = selection.model != null
    ? String(selection.model).trim()
    : String(providerDefaults.model ?? legacyClaudeModel ?? definition.defaultModel).trim();
  const effort = selection.effort != null
    ? String(selection.effort).trim()
    : String(providerDefaults.effort ?? definition.defaultEffort).trim();
  return validateProviderSelection({ provider, model, effort, dynamicWorkflow: selection.dynamicWorkflow });
}

export function createProviderAdapter(id, options = {}) {
  const definition = getProviderDefinition(id);
  if (!definition) throw new Error(`未知 provider：${normalizeProvider(id)}`);
  return definition.createAdapter(options);
}

function exec(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: 5000,
      windowsHide: true,
      shell: process.platform === 'win32',
      maxBuffer: 1024 * 1024,
      ...options,
    }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

export async function detectProviders() {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  return Promise.all(Object.values(DEFINITIONS).map(async (definition) => {
    const versionResult = await exec(definition.command, ['--version']);
    if (versionResult.error) {
      return { ...publicDefinition(definition), available: false, version: null, path: null, error: versionResult.error.message };
    }
    const locationResult = await exec(locator, [definition.command], { shell: false });
    return {
      ...publicDefinition(definition),
      available: true,
      version: (versionResult.stdout || versionResult.stderr).trim().split(/\r?\n/)[0] || null,
      path: locationResult.error ? null : locationResult.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null,
      error: null,
    };
  }));
}
