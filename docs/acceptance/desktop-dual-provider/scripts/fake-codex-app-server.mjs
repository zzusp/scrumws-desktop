import readline from 'node:readline';

const threadId = 'fake-thread';
let turnNumber = 0;
let currentTurnId = null;

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id, result) { write({ id, result }); }
function notification(method, params) { write({ method, params }); }
function request(id, method, params) { write({ id, method, params }); }

function complete(status = 'completed') {
  notification('turn/completed', {
    threadId,
    turn: { id: currentTurnId, status },
  });
}

function issueApproval(id) {
  const common = { threadId, turnId: currentTurnId, itemId: `approval-${id}` };
  if (id === 701) request(id, 'item/commandExecution/requestApproval', { ...common, command: 'Get-Date', cwd: process.cwd() });
  else if (id === 702) request(id, 'item/fileChange/requestApproval', { ...common, changes: { 'example.txt': 'create' } });
  else if (id === 703) request(id, 'item/permissions/requestApproval', { ...common, permissions: { network: ['example.com'], fileSystem: ['read'] } });
  else if (id === 704) request(id, 'item/tool/requestUserInput', {
    ...common,
    questions: [{ id: 'choice', header: 'Choice', question: 'Continue?', options: [{ label: 'Yes', description: 'Continue' }] }],
  });
  else if (id === 705) request(id, 'mcpServer/elicitation/request', { ...common, serverName: 'fixture', message: 'Confirm' });
}

function startFixtureTurn(text) {
  notification('turn/started', { threadId, turn: { id: currentTurnId, status: 'inProgress' } });
  if (text === 'INTERRUPT') return;
  if (text === 'UNKNOWN') {
    request(900, 'item/unknown/request', { threadId, turnId: currentTurnId });
    return;
  }

  notification('item/agentMessage/delta', { threadId: 'foreign-thread', turnId: currentTurnId, itemId: 'foreign-agent', delta: 'MUST_NOT_LEAK' });
  notification('item/agentMessage/delta', { threadId, turnId: currentTurnId, itemId: 'agent-1', delta: 'hello ' });
  notification('item/reasoning/summaryTextDelta', { threadId, turnId: currentTurnId, itemId: 'reasoning-1', delta: 'inspect ' });
  notification('item/started', {
    threadId,
    turnId: currentTurnId,
    item: { id: 'command-1', type: 'commandExecution', command: 'Get-Date', cwd: process.cwd(), status: 'inProgress' },
  });
  notification('item/completed', {
    threadId,
    turnId: currentTurnId,
    item: { id: 'command-1', type: 'commandExecution', command: 'Get-Date', aggregatedOutput: 'fixture-output', status: 'completed' },
  });
  notification('item/completed', {
    threadId,
    turnId: currentTurnId,
    item: { id: 'reasoning-1', type: 'reasoning', summary: ['inspect fixture'], status: 'completed' },
  });
  notification('item/completed', {
    threadId,
    turnId: currentTurnId,
    item: { id: 'agent-1', type: 'agentMessage', text: 'hello world', status: 'completed' },
  });
  notification('thread/tokenUsage/updated', {
    threadId,
    turnId: currentTurnId,
    tokenUsage: {
      last: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 20, reasoningOutputTokens: 5 },
      modelContextWindow: 200000,
    },
  });
  issueApproval(701);
}

function handleClientResponse(message) {
  if (message.id === 701 && message.result?.decision === 'accept') issueApproval(702);
  else if (message.id === 702 && message.result?.decision === 'accept') issueApproval(703);
  else if (message.id === 703 && message.result?.scope === 'turn' && message.result?.permissions?.network) issueApproval(704);
  else if (message.id === 704 && message.result?.answers?.choice?.answers?.[0] === 'Yes') issueApproval(705);
  else if (message.id === 705 && message.result?.action === 'accept' && message.result?.content?.confirmed === true) complete();
  else if (message.id === 900 && message.error?.code === -32601) complete();
}

function handle(message) {
  if (Object.hasOwn(message, 'id') && !message.method) {
    handleClientResponse(message);
    return;
  }
  if (!message.method) return;
  if (!Object.hasOwn(message, 'id')) return;

  if (message.method === 'initialize') response(message.id, { userAgent: 'fake-codex-app-server' });
  else if (message.method === 'thread/resume') {
    if (message.params?.threadId === 'missing-thread') write({ id: message.id, error: { code: -32001, message: 'thread not found' } });
    else if (message.params?.threadId === 'forbidden-thread') write({ id: message.id, error: { code: -32003, message: 'permission denied' } });
    else response(message.id, { thread: { id: message.params?.threadId || threadId } });
  } else if (message.method === 'thread/start') response(message.id, { thread: { id: threadId } });
  else if (message.method === 'turn/start') {
    turnNumber += 1;
    currentTurnId = `turn-${turnNumber}`;
    response(message.id, { turn: { id: currentTurnId } });
    startFixtureTurn(message.params?.input?.[0]?.text || '');
  } else if (message.method === 'turn/interrupt') {
    response(message.id, {});
    complete('cancelled');
  }
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on('line', (line) => {
    try { handle(JSON.parse(line)); } catch (error) { process.stderr.write(`${error.stack || error.message}\n`); }
  })
  .on('close', () => process.exit(0));
