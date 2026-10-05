import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { RunHistory } from '../src/runs.ts';
import { emptyUsage, UsageLedger } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';

// Children load installed extensions from Pi's agent dir; keep tests away from the user's real one.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));

async function until(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}

test('real SDK children stream, deliver independently, acknowledge steering, stop, and retain profile-local history/usage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-agents-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const usage = new UsageLedger(dir), reports: string[] = [], warnings: string[] = [];
  const releases = new Map<string, () => void>();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const initial = textContent(context.messages.find(m => m.role === 'user')?.content);
      const task = initial.split('Your task:\n').at(-1) ?? '';
      const guided = context.messages.some(m => m.role === 'user' && textContent(m.content) === 'Please include tests.');
      const report = context.messages.findLast(m => m.role === 'user' && textContent(m.content).startsWith('['));
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: report ? `${task} incorporated: ${textContent(report.content)}` : guided ? 'Guidance received.' : `Working on ${task}` }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop',
        usage: { ...emptyUsage(), input: 100, output: 10, cacheRead: 50, totalTokens: 160, cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 } } };
      void (async () => {
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: textContent(message.content), partial: message });
        if (!guided && !report) await new Promise<void>(resolve => {
          const release = () => { options?.signal?.removeEventListener('abort', release); resolve(); };
          releases.set(task, release); options?.signal?.addEventListener('abort', release, { once: true });
          if (options?.signal?.aborted) release();
        });
        if (options?.signal?.aborted) { message.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: message }); }
        else stream.push({ type: 'done', reason: 'stop', message });
        stream.end();
      })();
      return stream;
    },
  });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async text => { reports.push(text); }, text => warnings.push(text), dir,
    { usage, parentSession: 'parent-session', createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  try {
    const [slow, fast, stopped] = await children.spawn([{ task: 'slow' }, { task: 'fast' }, { task: 'stop-me' }], dir);
    await until(() => releases.size === 3);
    await until(() => !!children.live(slow)?.streaming);
    assert.ok(JSON.stringify(children.messages(slow)).includes('Working on slow'));
    await children.tell(slow, 'Please include tests.');
    assert.equal(children.history.records.get(slow)?.guidance[0].state, 'queued');
    releases.get('fast')!();
    await until(() => reports.length === 1);
    assert.match(reports[0], new RegExp(`^\\[${fast}\\]`));
    assert.equal(children.history.records.get(slow)?.state, 'running', 'fast must report before slow finishes');
    await children.tell(stopped, 'This should remain undelivered.');
    await children.stop(stopped);
    await until(() => children.history.records.get(stopped)?.state === 'stopped');
    assert.equal(children.history.records.get(stopped)?.guidance[0].state, 'undelivered');
    releases.get('slow')!();
    await until(() => !children.active);
    assert.equal(reports.length, 3);
    assert.equal(children.history.records.get(slow)?.guidance[0].state, 'delivered');
    assert.match(children.history.records.get(slow)?.report ?? '', /Guidance received/);
    assert.ok(usage.select('This session', 'parent-session').length >= 3);
    const before = usage.entries.length;
    const restored = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '', async () => {}, text => warnings.push(text), dir, { usage, parentSession: 'new-parent' });
    assert.equal(usage.entries.length, before, 'reloading saved children must not double count usage');
    assert.ok(restored.messages(slow).some(m => m.role === 'user' && textContent(m.content) === 'Please include tests.'));
    assert.equal(restored.history.records.get(fast)?.state, 'completed');
    assert.equal(new RunHistory(join(dir, 'other-profile')).list().length, 0);
    await restored.close();

    const [root] = await children.spawn([{ task: 'tree-root' }], dir);
    await until(() => releases.has('tree-root'));
    const [grandchild] = await children.spawn([{ task: 'grandchild' }], dir, undefined, root);
    const [great] = await children.spawn([{ task: 'great-grandchild' }], dir, undefined, grandchild);
    await until(() => releases.has('great-grandchild'));
    assert.equal(children.history.records.get(great)?.depth, 3);
    assert.ok(children.live(root)?.session.getActiveToolNames().includes('spawn'));
    assert.ok(!children.live(great)?.session.getActiveToolNames().includes('spawn'));
    await assert.rejects(children.spawn([{ task: 'too-deep' }], dir, undefined, great), /depth limit/);
    await assert.rejects(children.spawn(Array.from({ length: 6 }, () => ({ task: 'too-many' })), dir), /8 active agents/);
    releases.get('tree-root')!(); releases.get('grandchild')!();
    await until(() => children.history.records.get(root)?.state === 'waiting' && children.history.records.get(grandchild)?.state === 'waiting');
    await children.tell(root, 'Please include tests.', 'user');
    await until(() => children.history.records.get(root)?.guidance[0].state === 'delivered');
    assert.equal(children.history.records.get(great)?.state, 'running', 'guidance must wake an idle parent before its descendant completes');
    assert.ok(memory.root.some(entry => entry.kind === 'user' && entry.text.includes(`Direct guidance to subagent [${root}]`)));
    releases.get('great-grandchild')!();
    await until(() => !children.active);
    assert.equal(reports.length, 4, 'descendants report only to their immediate parent, not directly to the manager');
    assert.match(reports[3], /tree-root incorporated: .*grandchild incorporated: .*great-grandchild/);
    const tree = children.history.list().map(r => r.id), rootIndex = tree.indexOf(root);
    assert.deepEqual(tree.slice(rootIndex, rootIndex + 3), [root, grandchild, great]);

    const [stopRoot] = await children.spawn([{ task: 'stop-root' }], dir);
    const [stopChild] = await children.spawn([{ task: 'stop-child' }], dir, undefined, stopRoot);
    const [stopLeaf] = await children.spawn([{ task: 'stop-leaf' }], dir, undefined, stopChild);
    await until(() => releases.has('stop-leaf'));
    await children.stop(stopRoot);
    await until(() => !children.active);
    for (const id of [stopRoot, stopChild, stopLeaf]) assert.equal(children.history.records.get(id)?.state, 'stopped');
    assert.deepEqual(warnings, []);
  } finally { for (const release of releases.values()) release(); await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('children load installed extensions but never another copy of OptChat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-extensions-'));
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? '';
  const tool = (name: string) => `export default (pi) => pi.registerTool({ name: '${name}', label: '${name}', description: '${name}', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: {} }) });\n`;
  mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  writeFileSync(join(agentDir, 'extensions', 'web.js'), tool('installed_web'));
  const copy = join(dir, 'optchat-copy');
  mkdirSync(join(copy, 'src'), { recursive: true });
  writeFileSync(join(copy, 'package.json'), JSON.stringify({ name: 'pi-optchat', type: 'module', pi: { extensions: ['./src/index.js'] } }));
  writeFileSync(join(copy, 'src', 'index.js'), tool('optchat_copy'));
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [copy] }));
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple: () => createAssistantMessageEventStream(),
  });
  const children = new Children(new Memory(dir, async input => input.source.slice(0, 100), () => {}), new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async () => {}, () => {}, dir, { createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  try {
    const [id] = await children.spawn([{ task: 'inspect tools' }], dir);
    const names = children.live(id)?.session.getAllTools().map(t => t.name) ?? [];
    assert.ok(names.includes('installed_web'), 'installed extensions reach the child');
    assert.ok(!names.includes('optchat_copy'), 'OptChat must not load inside its own children');
    await children.stop(id);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(join(agentDir, 'settings.json'), { force: true }); rmSync(join(agentDir, 'extensions'), { recursive: true, force: true }); }
});
