import assert from 'node:assert/strict';
import {
  createProviderAdapter,
  getProviderDefinition,
  listProviderDefinitions,
  normalizeProvider,
  resolveProviderSelection,
  validateProviderSelection,
} from '../../../../platform/lib/providers/registry.js';
import { ClaudeAdapter } from '../../../../platform/lib/providers/claude.js';
import { CodexAdapter } from '../../../../platform/lib/providers/codex.js';

assert.equal(normalizeProvider(), 'claude');
assert.equal(normalizeProvider(' CODEX '), 'codex');
assert.equal(listProviderDefinitions().length, 2);
assert.equal(getProviderDefinition('claude').capabilities.backgroundTasks, false);
assert.equal(getProviderDefinition('codex').capabilities.backgroundTasks, false);
assert.equal(getProviderDefinition('claude').capabilities.jsonl, true);
assert.equal(getProviderDefinition('codex').capabilities.sessionResume, true);
assert.deepEqual(getProviderDefinition('codex').models, ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.3-codex-spark']);
assert.deepEqual(getProviderDefinition('codex').efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
assert.equal(getProviderDefinition('codex').defaultModel, 'gpt-5.6-sol');
assert.equal(getProviderDefinition('codex').defaultEffort, 'low');

const defaults = {
  defaultProvider: 'codex',
  defaultModel: 'claude-sonnet-5',
  providerDefaults: {
    claude: { model: 'claude-opus-4-8', effort: 'xhigh' },
    codex: { model: '', effort: 'high' },
  },
};
assert.deepEqual(
  (({ provider, model, effort }) => ({ provider, model, effort }))(resolveProviderSelection({}, defaults)),
  { provider: 'codex', model: '', effort: 'high' },
);
assert.equal(resolveProviderSelection({ provider: 'claude' }, { defaultModel: 'claude-sonnet-5' }).model, 'claude-sonnet-5');
assert.equal(validateProviderSelection({ provider: 'claude', model: 'custom-model' }).ok, false);
assert.equal(validateProviderSelection({ provider: 'codex', model: 'gpt-5.6-codex', effort: 'ultra' }).ok, true);
assert.equal(validateProviderSelection({ provider: 'codex', model: 'gpt & calc' }).ok, false);
assert.equal(validateProviderSelection({ provider: 'codex', effort: 'extreme' }).ok, false);
assert.equal(validateProviderSelection({ provider: 'codex', dynamicWorkflow: true }).ok, false);
assert.equal(validateProviderSelection({ provider: 'unknown' }).ok, false);
assert.equal(createProviderAdapter('claude') instanceof ClaudeAdapter, true);
assert.equal(createProviderAdapter('codex') instanceof CodexAdapter, true);
assert.throws(() => createProviderAdapter('unknown'), /未知 provider/);

console.log(JSON.stringify({
  ok: true,
  providers: listProviderDefinitions().map(({ id, defaultModel, defaultEffort, capabilities }) => ({ id, defaultModel, defaultEffort, capabilities })),
  codexCustomModelValidated: true,
  shellMetacharacterRejected: true,
}));
