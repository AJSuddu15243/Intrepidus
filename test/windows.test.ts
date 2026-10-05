import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { emptyUsage, UsageLedger } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';
import { serveWindows, connectWindow, type WindowEvent } from '../src/window-bridge.ts';
import { profileSocket, lockProfile } from '../src/profiles.ts';
import { createHandoffSummarizer } from '../src/handoff.ts';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-window-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  const control = { failSummary: false };
  const requests: string[] = [], summaries: string[] = [], reports: string[] = [], warnings: string[] = [];
  runtime.registerProvider('window-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const text = textContent(last && 'content' in last ? last.content : '');
      const summary = text.includes('Prior handoff:');
      if (summary) summaries.push(text); else requests.push(text);
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: summary ? 'Handoff: retained the user correction and actual work.' : `Reply: ${text.split('Your task:\n').at(-1)}` }],
        api: model.api, model: model.id, provider: model.provider, stopReason: 'stop', timestamp: Date.now(), usage: emptyUsage() };
      if (summary && control.failSummary) { message.stopReason = 'error'; message.errorMessage = 'Synthetic summarizer unavailable'; }
      if (text === 'ask main') {
        message.content = [{ type: 'toolCall', id: 'tell-main', name: 'tell_main', arguments: { message: 'Need a decision from the main agent.' } }];
        message.stopReason = 'toolUse';
      }
      void (async () => {
        stream.push({ type: 'start', partial: message });
        if (text.includes('hold work') && !summary) await new Promise<void>(resolve => {
          if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        if (message.stopReason === 'error') stream.push({ type: 'error', reason: 'error', error: message });
        else if (options?.signal?.aborted) { message.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: message }); }
        else stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
        stream.end();
      })();
      return stream;
    },
  });
  const registry = new ModelRegistry(runtime), choice = () => ({ provider: 'window-test', model: 'child', thinking: 'off' as const });
  const ledger = new UsageLedger(dir);
  const summarize = createHandoffSummarizer(registry, choice, reply => ledger.compression(reply, 'compactor', 'owner'));
  const options = { parentSession: 'owner', usage: ledger, createSession: (options: Parameters<typeof createAgentSession>[0]) => createAgentSession({ ...options, modelRuntime: runtime }), summarizeHandoff: summarize };
  const children = new Children(memory, registry, choice, () => '', async text => { reports.push(text); }, text => warnings.push(text), dir, options);
  const unlock = await lockProfile(dir, 'test owner');
  return { control, dir, memory, children, requests, summaries, reports, warnings, registry, choice, options, ledger,
    async close() { await children.close(); await memory.close(); await unlock(); rmSync(dir, { recursive: true, force: true }); } };
}

test('connected window keeps one real SDK conversation, communicates both ways, and completes its subtree with one handoff', async () => {
  const f = await fixture();
  const events: WindowEvent[] = [];
  const close = await serveWindows(f.dir, f.children, () => true, async text => { f.reports.push(text); });
  const client = await connectWindow(f.dir, event => events.push(event), () => {});
  try {
    await client.request('start', 'Investigate this repository.', f.dir);
    const id = events.find(e => e.name === 'started')?.text; assert.ok(id);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    assert.equal(f.reports.length, 1); assert.match(f.reports[0], /User started/);
    assert.equal(f.children.active, true, 'the conversation remains open between replies');
    await client.request('say', 'Correction: keep the existing API.');
    await until(() => f.children.messages(id).some(m => m.role === 'assistant' && textContent(m.content) === 'Reply: Correction: keep the existing API.'));
    assert.equal(f.children.history.records.size, 1);
    await client.request('tell-main', 'Please coordinate the release.');
    assert.match(f.reports.at(-1) ?? '', /User message.*coordinate the release/);
    await client.request('say', 'ask main');
    await until(() => f.reports.some(text => text.includes('Need a decision')));
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    await f.children.tell(id, 'Main agent: proceed with tests.');
    await until(() => events.some(e => e.name === 'message' && e.text.includes('Main agent: proceed')));
    assert.ok(!events.some(e => e.name === 'message' && e.text.includes('<chat>')), 'frozen memory must not be rendered as user input');
    await client.request('say', 'hold work');
    await until(() => f.requests.at(-1) === 'hold work');
    const [descendant] = await f.children.spawn([{ task: 'hold work descendant' }], f.dir, undefined, id);
    await client.request('complete');
    await until(() => f.children.history.records.get(id)?.handoff?.delivered === true);
    assert.equal(f.children.history.records.get(descendant)?.state, 'stopped');
    assert.equal(f.children.history.records.get(id)?.state, 'completed');
    assert.equal(f.children.history.records.get(id)?.handoff?.delivered, true);
    assert.match(f.reports.at(-1) ?? '', /completed by user/);
    assert.equal(f.summaries.length, 1);
    assert.match(f.summaries[0], /Correction: keep the existing API/);
    assert.match(f.summaries[0], /Main agent: proceed/);
    assert.doesNotMatch(f.summaries[0], /<chat>/);
    assert.equal(f.ledger.entries.filter(entry => entry.role === 'compactor').length, 1);
    await assert.rejects(client.request('say', 'Too late'), /closing/);
    await f.children.recoverHandoffs();
    assert.equal(f.summaries.length, 1, 'delivered handoffs must not be repeated');
    assert.deepEqual(f.warnings, []);
  } finally { client.close(); await close(); await f.close(); }
});

test('SIGKILL of the client interrupts owner-hosted work and reports it', async () => {
  const f = await fixture();
  const close = await serveWindows(f.dir, f.children, () => true, async text => { f.reports.push(text); });
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {createConnection} from 'node:net';
    const socket = createConnection(process.argv[1]);
    socket.on('connect', () => socket.write(JSON.stringify({kind:'request',id:1,action:'start',text:'hold work',cwd:process.argv[2]})+'\\n'));
    socket.on('data', () => {});
  `, profileSocket(f.dir, 'windows'), f.dir], { stdio: 'ignore' });
  try {
    await until(() => f.requests.some(text => text.includes('hold work')));
    child.kill('SIGKILL');
    await until(() => f.reports.some(text => text.includes('interrupted (disconnected)')));
    assert.equal(f.children.active, false);
    assert.equal(f.children.history.list()[0].handoff?.delivered, true);
  } finally { child.kill('SIGKILL'); await close(); await f.close(); }
});

test('pending handoffs survive failed delivery and restart without another model call', async () => {
  const f = await fixture();
  try {
    const [id] = await f.children.spawn([{ task: 'Remember the user correction.' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    await f.children.finish(id, 'complete');
    const run = f.children.history.records.get(id)!;
    // Simulate the durable state left by an owner crash before producing its handoff.
    run.state = 'waiting'; run.handoff = undefined; f.children.history.save(run);
    const failing = new Children(f.memory, f.registry, f.choice, () => '', async () => { throw new Error('delivery unavailable'); }, () => {}, f.dir, f.options);
    await assert.rejects(failing.recoverHandoffs(), /delivery unavailable/);
    const calls = f.summaries.length;
    const recovered: string[] = [];
    const restored = new Children(f.memory, f.registry, f.choice, () => '', async text => { recovered.push(text); }, () => {}, f.dir, f.options);
    await restored.recoverHandoffs(); await restored.recoverHandoffs();
    assert.equal(recovered.length, 1); assert.match(recovered[0], /owner-stopped/);
    assert.equal(f.summaries.length, calls);
    await failing.close(); await restored.close();
  } finally { await f.close(); }
});

test('disconnect during startup cancels cleanly, and importing owners reject new work', async () => {
  const f = await fixture();
  let available = false;
  const close = await serveWindows(f.dir, f.children, () => available, async text => { f.reports.push(text); });
  const client = await connectWindow(f.dir, () => {}, () => {});
  try {
    await assert.rejects(client.request('start', 'hello', f.dir), /importing/);
    assert.equal(f.children.history.records.size, 0);
    available = true;
    const start = client.request('start', 'hello', f.dir);
    client.close();
    await assert.rejects(start, /lost/);
    await close();
    assert.equal(f.children.active, false);
  } finally { client.close(); await f.close(); }
});


test('long handoffs fold all transcript chunks, and a failed summarizer still reports an honest fallback', async () => {
  const f = await fixture();
  try {
    const [id] = await f.children.spawn([{ task: 'Initial task' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    const info = f.children.history.records.get(id)!;
    const longCorrection = 'Original detail. '.repeat(3500) + ' FINAL USER CORRECTION';
    const text = await f.options.summarizeHandoff(info, [
      { role: 'user', content: '<chat>PRIVATE MEMORY VIEW</chat>\n\nYour task:\nInitial task', timestamp: 1 },
      { role: 'user', content: longCorrection, timestamp: 2 },
    ]);
    assert.ok(f.summaries.length >= 3);
    assert.ok(f.summaries.some(chunk => chunk.includes('FINAL USER CORRECTION')));
    assert.ok(f.summaries.every(chunk => !chunk.includes('PRIVATE MEMORY VIEW')));
    assert.match(text, /Handoff:/);
    f.control.failSummary = true;
    await f.children.finish(id, 'disconnected');
    assert.match(f.reports.at(-1) ?? '', /interrupted \(disconnected\)/);
    assert.match(f.reports.at(-1) ?? '', /Automatic summary unavailable.*Synthetic summarizer unavailable/);
    assert.match(f.reports.at(-1) ?? '', /Full transcript:/);
    assert.equal(info.handoff?.delivered, true);
  } finally { await f.close(); }
});
