import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type UserMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile } from '../src/profiles.ts';
import { buildContext, previousExchange, textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';

const user = (content: UserMessage['content']): UserMessage => ({ role: 'user', content, timestamp: 1 });
const answer = (text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({
  role: 'assistant', content: [{ type: 'text', text }], timestamp: 2, stopReason,
  api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: emptyUsage(),
});

test('retain the exact last answer and its requests, excluding prior working context', () => {
  const first = user('Compare the options.');
  const steering = user([{ type: 'text', text: 'Focus on option two.' }, { type: 'image', data: 'image-bytes', mimeType: 'image/png' }]);
  const finalText = 'Second option: preserve original wording.\n' + 'Detailed explanation. '.repeat(70);
  const final = answer(finalText);
  final.content.unshift({ type: 'thinking', thinking: 'OLD PRIVATE REASONING' });
  const toolResult: AgentMessage = { role: 'toolResult', toolCallId: 'read', toolName: 'read',
    content: [{ type: 'text', text: 'OLD TOOL OUTPUT' }], isError: false, timestamp: 1 };
  const history = [user('Older question'), answer('Older answer'), first, answer('Checking.', 'toolUse'), toolResult, steering, final];
  const previous = previousExchange(history);
  assert.deepEqual(previous.map(m => textContent(m.content)), [
    first.content, 'Focus on option two.\n[image attachment: available in Pi session; text memory does not preserve image bytes]', finalText,
  ]);
  const current = user('Why is that?');
  const thinking = answer('Working on the follow-up.');
  thinking.content.unshift({ type: 'thinking', thinking: 'CURRENT REASONING' });
  const context = buildContext([...history, current, thinking], [current, thinking], '<chat>\nsummary\n</chat>', 'instructions', previous);
  assert.deepEqual(context.map(m => m.role), ['system', 'user', 'user', 'assistant', 'user', 'assistant']);
  assert.ok(context[3].role === 'assistant');
  assert.equal(textContent(context[3].content), finalText);
  assert.equal(context.at(-1), thinking);
  assert.ok(context[1].role === 'user');
  assert.match(textContent(context[1].content), /^<chat>\nsummary\n<\/chat>/);
  assert.doesNotMatch(JSON.stringify(context), /OLD PRIVATE REASONING|OLD TOOL OUTPUT|Older question|Older answer|image-bytes/);
  assert.throws(() => buildContext(history, [], 'view', 'prompt', previous), /no current user message/);
  assert.equal(final.content[0].type, 'thinking', 'the saved transcript must not be mutated');
});

test('unfinished exchanges do not masquerade as completed answers', () => {
  const completed = [user('Earlier'), answer('Earlier answer')];
  for (const reason of ['error', 'aborted', 'length', 'toolUse'] as const) {
    assert.deepEqual(previousExchange([...completed, user('New task'), answer('Partial', reason)]), []);
  }
  assert.deepEqual(previousExchange([...completed, user('Unanswered')]), []);
  assert.deepEqual(previousExchange([answer('Unpaired answer')]), []);
  assert.deepEqual(previousExchange([]), []);
});

test('real Pi lifecycle retains one exchange across tool calls and resume, without replaying it into memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-context-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const captured: Context[] = [];
  const errors: string[] = [];
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
      modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const snapshot = structuredClone(context);
        snapshot.messages = snapshot.messages.filter(m => m.role !== 'system');
        captured.push(snapshot);
        const latest = context.messages.at(-1);
        const text = textContent(latest?.content);
        const reply = answer(latest?.role === 'toolResult' ? 'Because Append preserves existing summaries.' : `Answer to: ${text.split('</chat>').at(-1)?.trim()}`);
        reply.api = model.api; reply.provider = model.provider; reply.model = model.id;
        if (text === 'Why is that?') {
          reply.stopReason = 'toolUse';
          reply.content = [{ type: 'toolCall', id: 'zoom-1', name: 'zoom', arguments: { id: 0, n: 1 } }];
        }
        const stream = createAssistantMessageEventStream();
        stream.push({ type: 'done', reason: reply.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: reply }); stream.end();
        return stream;
      },
    });
    const open = async (manager: SessionManager) => {
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
        noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
      await loader.reload();
      const created = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
        resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date'] });
      session = created.session;
      await session.bindExtensions({ onError: error => errors.push(error.error) });
      return session;
    };
    const close = async () => {
      if (!session) return;
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose(); session = undefined;
    };
    const manager = SessionManager.create(dir, join(dir, 'sessions'));
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    let active = await open(manager);
    await active.prompt('Should I append?');
    assert.equal(captured[0].messages.length, 1);
    const firstAnswer = active.getLastAssistantText();
    await active.prompt('Why is that?');
    const followUp = captured[1].messages;
    assert.deepEqual(followUp.map(m => m.role), ['user', 'assistant', 'user']);
    assert.equal(textContent(followUp[1].content), firstAnswer);
    assert.deepEqual(captured[2].messages.slice(0, 3), followUp, 'previous exchange must stay frozen during tools');
    assert.ok(captured[2].messages.some(m => m.role === 'toolResult'));
    await active.prompt('Okay.');
    assert.deepEqual(captured[3].messages.map(m => m.role), ['user', 'assistant', 'user']);
    assert.equal(textContent(captured[3].messages[1].content), 'Because Append preserves existing summaries.');
    assert.ok(!captured[3].messages.some(m => m.role === 'toolResult'));
    const saved = manager.getSessionFile(); assert.ok(saved);
    await close();
    active = await open(SessionManager.open(saved));
    await active.prompt('Explain that answer.');
    assert.equal(textContent(captured[4].messages[1].content), 'Answer to: Okay.');
    await close();
    const fresh = SessionManager.inMemory(dir);
    fresh.appendCustomEntry('optchat.profile', { name: 'fixture' });
    active = await open(fresh);
    await active.prompt('Fresh session.');
    assert.equal(captured[5].messages.length, 1, 'a new session must not replay another session\'s exchange');
    const main = join(dir, 'profiles', 'fixture', 'main');
    const log = readdirSync(main).flatMap(file => readFileSync(join(main, file), 'utf8').trim().split('\n'));
    assert.equal(log.length, 12, 'only five new exchanges plus one tool call/result should be logged');
    assert.deepEqual(errors, []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
