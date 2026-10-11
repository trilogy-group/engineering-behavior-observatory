import { createInterface } from 'node:readline';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FACTORY_PROTOCOL_VERSION } from '@factory/droid-sdk';
if (process.argv.includes('--version')) { console.log('0.238.0'); process.exit(0); }
const mode = process.argv.find(arg => arg.startsWith('--mode='))?.slice(7) ?? 'success';
const sessionId = 'fixture-factory-session';
const usage = { inputTokens: 4, outputTokens: 2, cacheReadTokens: 1, cacheCreationTokens: 3, thinkingTokens: 0 };
const frame = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', factoryApiVersion: '1.0.0', factoryProtocolVersion: FACTORY_PROTOCOL_VERSION, ...value }) + '\n');
const notify = (notification, id = sessionId) => frame({ type: 'notification', method: 'droid.session_notification', params: { sessionId: id, notification } });
let turnId;
let permissionId;
function finish() {
  notify({ type: 'tool_result', toolUseId: 'fixture-tool', messageId: 'fixture-tool-result', content: 'created result', isError: false });
  notify({ type: 'assistant_text_delta', messageId: 'fixture-answer', blockIndex: 0, textDelta: 'Done' });
  notify({ type: 'create_message', message: { id: 'fixture-answer', role: 'assistant', content: [ { type: 'text', text: 'Done' },
    { type: 'thinking', thinking: 'FACTORY-HIDDEN-SENTINEL', signature: 'FACTORY-SIGNATURE-SENTINEL' } ], createdAt: 1, updatedAt: 2 } });
  // Replayed native copies must not inflate semantic counts.
  notify({ type: 'create_message', message: { id: 'fixture-answer', role: 'assistant', content: [{ type: 'text', text: 'Done' }], createdAt: 1, updatedAt: 2 } });
  notify({ type: 'tool_call', toolUse: { type: 'tool_use', id: 'fixture-tool', name: 'Create', input: { path: 'factory-result.txt' } } });
  notify({ type: 'tool_result', toolUseId: 'fixture-tool', messageId: 'fixture-tool-result', content: 'created result', isError: false });
  notify({ type: 'session_token_usage_changed', sessionId, tokenUsage: usage });
  notify({ type: 'session_compacted', summaryId: 'fixture-summary', removedCount: 2, visibleBoundaryMessageId: null });
  notify({ type: 'child_session_available', childSessionId: 'fixture-child', toolUseId: 'fixture-tool', timestamp: 1 });
  notify({ type: 'llm_retry', attempt: 1, reason: 'overloaded' });
  notify({ type: 'hook_execution_started', hookId: 'fixture-hook', hookEventName: 'PreToolUse', hookCommands: [{ type: 'command', command: 'echo fixture' }] });
  notify({ type: 'future_fixture_event', data: 'unknown-but-retained' });
  notify({ type: 'thinking_text_delta', messageId: 'fixture-answer', blockIndex: 1, textDelta: 'FACTORY-HIDDEN-SENTINEL' });
  notify({ type: 'agent_turn_completed', turnId: 'foreign-turn', reason: 'completed', tokenUsage: usage });
  notify({ type: 'agent_turn_completed', turnId, reason: 'completed', tokenUsage: usage }, 'foreign-session');
  const terminal = { type: 'agent_turn_completed', ...(mode === 'missing-turn' ? {} : { turnId }), reason: mode === 'provider-error' ? 'model_provider_unavailable' : 'completed', tokenUsage: usage, cumulativeTokenUsage: usage, childTokenUsage: usage, durationMs: 5 };
  notify(terminal);
  if (mode === 'duplicate-terminal') notify(terminal);
}
const input = createInterface({ input: process.stdin });
input.on('line', raw => {
  const request = JSON.parse(raw);
  if (request.type === 'response') {
    if (request.id === permissionId) {
      writeFileSync('permission.json', JSON.stringify(request.result));
      if (request.result.selectedOption === 'cancel') notify({ type: 'agent_turn_completed', turnId, reason: 'permission_rejected', tokenUsage: usage });
      else finish();
    }
    return;
  }
  let result = { success: true };
  if (request.method === 'droid.initialize_session') {
    const settings = { modelId: request.params.modelId, reasoningEffort: request.params.reasoningEffort,
      autonomyLevel: request.params.autonomyLevel, interactionMode: request.params.interactionMode };
    if (mode === 'settings-mismatch') settings.modelId = 'wrong-model';
    result = { sessionId, session: { messages: [] }, settings };
    writeFileSync('isolation.json', JSON.stringify({ hasUnrelatedSecret: process.env.EBO_FACTORY_UNRELATED !== undefined,
      hasFactoryCredential: Boolean(process.env.FACTORY_API_KEY), hasByokCredential: Boolean(process.env.EBO_FACTORY_BYOK_API_KEY),
      hasSourceCredential: Boolean(process.env.EBO_FAKE_FACTORY_KEY), home: process.env.HOME, updater: process.env.FACTORY_DROID_AUTO_UPDATE_ENABLED,
      settings: JSON.parse(readFileSync(join(process.env.HOME, '.factory/settings.json'), 'utf8')),
      hasUserHooks: existsSync(join(process.env.HOME, '.factory/hooks.json')) }));
    if (mode === 'init-hang') return;
  }
  frame({ type: 'response', id: request.id, result });
  if (request.method === 'droid.close_session') {
    input.close();
    setTimeout(() => {
      if (mode === 'slow-close') writeFileSync('factory-drained.txt', 'workspace write during native close\n');
      process.exit(0);
    }, mode === 'slow-close' ? 150 : 5);
  }
  if (request.method === 'droid.interrupt_session') {
    const terminal = () => notify({ type: 'agent_turn_completed', turnId, reason: 'cancelled', tokenUsage: usage });
    if (mode === 'delayed-interrupt' || mode === 'slow-interrupt') setTimeout(terminal, mode === 'slow-interrupt' ? 150 : 40);
    else terminal();
  }
  if (request.method !== 'droid.add_user_message') return;
  turnId = request.params.messageId;
  writeFileSync('factory-result.txt', 'native fixture workspace change\n');
  notify({ type: 'tool_call', toolUse: { type: 'tool_use', id: 'fixture-tool', name: 'Create', input: { path: 'factory-result.txt' } } });
  if (mode === 'crash') { process.stderr.write('fixture process crash\n'); process.exit(2); }
  if (mode === 'malformed') { process.stdout.write('{bad json\n'); return; }
  if (mode === 'oversized') { process.stdout.write('x'.repeat(10000) + '\n'); return; }
  if (mode === 'hang' || mode === 'delayed-interrupt' || mode === 'slow-interrupt' || mode === 'slow-close') return;
  if (mode === 'permission') {
    permissionId = 'permission-fixture';
    frame({ type: 'request', id: permissionId, method: 'droid.request_permission', params: {
      toolUses: [], options: [{ value: 'proceed_once', label: 'Allow once' }, { value: 'cancel', label: 'Cancel' }] } });
    return;
  }
  setTimeout(finish, 5);
});
