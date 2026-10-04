import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Memory, localDay, type Compressor } from '../src/memory.ts';
import { scanLocal, scanChatGPT, readConversation, type Conversation, type ImportedEntry } from '../src/import/sources.ts';
import { prepareImport, runImport, memoryDirectory, pendingImport, discardImport, deduplicate, chronological } from '../src/import/job.ts';
import { chooseImport, showProgress } from '../src/import/ui.ts';

const date = '2026-01-02T12:00:00.000Z';
const short: Compressor = async () => 'Historical decision summarized';
const temp = () => mkdtempSync(join(tmpdir(), 'optchat-import-test-'));
const lines = (path: string, items: unknown[]) => writeFileSync(path, items.map(i => JSON.stringify(i)).join('\n') + '\n');
const conversation = (source: Conversation['source'], file: string): Conversation => ({ source, file, id: 'conversation-1', title: 'Fixture', project: '/synthetic', date, size: 100 });
const entry = (id: string, at = date, text = `Imported ${id}`): ImportedEntry => ({ kind: 'user', text, date: at,
  receipt: `import:${id}`, origin: { source: 'claude', conversation: id, message: id, title: id } });

test('Claude imports full messages and tool activity, excludes thinking, caps tool output, and deduplicates repeated records', async () => {
  const dir = temp(), file = join(dir, 'claude.jsonl');
  const user = { type: 'user', uuid: 'u', timestamp: date, message: { role: 'user', content: 'exact user question' } };
  lines(file, [user, user,
    { type: 'assistant', uuid: 'a', timestamp: date, message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'SECRET REASONING' }, { type: 'text', text: 'visible answer' },
      { type: 'tool_use', name: 'Bash', id: 'call-1', input: { command: 'ls' } },
    ] } },
    { type: 'user', uuid: 't', timestamp: date, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'result'.repeat(10_000) }] } },
  ]);
  try {
    const parsed = await readConversation(conversation('claude', file));
    assert.deepEqual(parsed.entries.map(e => e.kind), ['user', 'talk', 'tool', 'echo']);
    assert.ok(!JSON.stringify(parsed.entries).includes('SECRET REASONING'));
    assert.match(parsed.entries[3].text, /characters omitted/);
    assert.ok(parsed.entries[3].text.length < 30_300);
    assert.equal(parsed.entries[0].date, date);
    const renamed = await readConversation({ ...conversation('claude', file), title: 'Renamed', project: '/moved' });
    assert.deepEqual(renamed.entries.map(e => e.receipt), parsed.entries.map(e => e.receipt));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex uses response items once, preserves custom/function calls, skips reasoning and reports unsupported records', async () => {
  const dir = temp(), file = join(dir, 'codex.jsonl');
  const row = (payload: unknown) => ({ type: 'response_item', timestamp: date, payload });
  lines(file, [
    row({ type: 'message', id: 'u', role: 'user', content: [{ type: 'input_text', text: 'QUESTION' }] }),
    { type: 'event_msg', payload: { type: 'user_message', message: 'QUESTION' } },
    row({ type: 'reasoning', summary: [{ text: 'SECRET' }] }),
    row({ type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'SECRET' }] }),
    row({ type: 'function_call', call_id: 'call1', name: 'exec', arguments: '{"cmd":"ls"}' }),
    row({ type: 'function_call_output', call_id: 'call1', output: 'files' }),
    row({ type: 'custom_tool_call', call_id: 'call2', name: 'patch', input: '+new text' }),
    row({ type: 'custom_tool_call_output', call_id: 'call2', output: [{ type: 'input_text', text: 'done' }] }),
    row({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ANSWER' }] }),
    row({ type: 'future_type' }),
  ]);
  try {
    const parsed = await readConversation(conversation('codex', file));
    assert.deepEqual(parsed.entries.map(e => e.kind), ['user', 'tool', 'echo', 'tool', 'echo', 'talk']);
    assert.ok(!JSON.stringify(parsed.entries).includes('SECRET'));
    assert.equal(parsed.warnings.length, 1);
    assert.equal(new Set(parsed.entries.map(e => e.receipt)).size, 6);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ChatGPT preserves tool-directed analysis and every branch, orders parents first, and keeps receipts stable when selected branch changes', async () => {
  const dir = temp(), file = join(dir, 'conversations-1.json');
  const exported = { id: 'chat-1', title: 'Branches', create_time: 100, update_time: 300, current_node: 'result', mapping: {
    result: { parent: 'call', message: { id: 'r', author: { role: 'tool', name: 'python' }, create_time: null, content: { parts: ['42'] } } },
    alternate: { parent: 'u', message: { id: 'alt', author: { role: 'assistant' }, create_time: 220, content: { parts: ['alternate answer'] } } },
    call: { parent: 'u', message: { id: 'c', author: { role: 'assistant' }, channel: 'analysis', recipient: 'python', create_time: 210, content: { content_type: 'code', text: 'print(42)' } } },
    reasoning: { parent: 'u', message: { id: 'secret', author: { role: 'assistant' }, channel: 'analysis', recipient: 'all', content: { parts: ['SECRET'] } } },
    u: { parent: null, message: { id: 'u', author: { role: 'user' }, create_time: 200, content: { parts: ['question'] } } },
  } };
  writeFileSync(file, JSON.stringify([exported]));
  try {
    const scan = await scanChatGPT(dir); assert.equal(scan.conversations.length, 1);
    const parsed = await readConversation(scan.conversations[0]);
    const msgs = parsed.entries.filter(e => e.origin?.message !== 'export:selected-branch');
    assert.deepEqual(msgs.map(e => e.origin?.message), ['u', 'c', 'r', 'alt']);
    assert.equal(msgs[1].kind, 'tool'); assert.equal(msgs[2].date, msgs[1].date);
    assert.match(msgs[3].text, /alternate branch/);
    assert.ok(!JSON.stringify(parsed.entries).includes('SECRET'));
    const changed = await readConversation({ ...scan.conversations[0], exported: { ...exported, current_node: 'alternate' } });
    assert.deepEqual(changed.entries.slice(0, -1).map(e => e.receipt), msgs.map(e => e.receipt));
    assert.notEqual(changed.entries.at(-1)?.receipt, parsed.entries.at(-1)?.receipt);
    const backToOriginal = await readConversation({ ...scan.conversations[0], exported: { ...exported, update_time: 400 } });
    assert.notEqual(backToOriginal.entries.at(-1)?.receipt, parsed.entries.at(-1)?.receipt);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('local discovery distinguishes Claude child conversations sharing a session ID and can be cancelled', async () => {
  const dir = temp(), sub = join(dir, 'session', 'subagents'); mkdirSync(sub, { recursive: true });
  for (const name of ['a', 'b']) lines(join(sub, `agent-${name}.jsonl`), [{ type: 'user', sessionId: 'shared', cwd: '/project', timestamp: date, message: { role: 'user', content: name } }]);
  const workflow = join(sub, 'workflows', 'wf-fixture'); mkdirSync(workflow, { recursive: true });
  lines(join(workflow, 'journal.jsonl'), [{ type: 'started', agentId: 'a' }, { type: 'result', result: 'workflow metadata' }]);
  try {
    const scan = await scanLocal('claude', [dir]);
    assert.deepEqual(scan.conversations.map(c => c.id).sort(), ['shared/agent-a', 'shared/agent-b']);
    assert.ok(scan.conversations.every(c => c.project === '/project' && c.date === date));
    await assert.rejects(scanLocal('claude', [dir], AbortSignal.abort()));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ChatGPT ZIP reads numbered conversation files without extracting other archive data', async () => {
  const dir = temp(), file = join(dir, 'conversations_1.json'), zip = join(dir, 'export.zip');
  writeFileSync(file, JSON.stringify([{ id: 'zip-chat', title: 'ZIP fixture', create_time: 100, mapping: {
    u: { parent: null, message: { id: 'u', author: { role: 'user' }, create_time: 100, content: { parts: ['zip fixture message'] } } },
  } }]));
  try {
    execFileSync('zip', ['-q', zip, 'conversations_1.json'], { cwd: dir }); rmSync(file);
    const scan = await scanChatGPT(zip); assert.equal(scan.conversations.length, 1);
    const parsed = await readConversation(scan.conversations[0]); assert.equal(parsed.entries.length, 1);
    assert.match(parsed.entries[0].text, /zip fixture message/); assert.equal(existsSync(file), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('append activates only after complete indexing, retains original summaries, and repeated imports add nothing', async () => {
  const dir = temp(); const old = new Memory(dir, short);
  let activated: Memory | undefined;
  try {
    old.append('user', 'original exact message', '2026-06-01T00:00:00.000Z');
    await old.settle(undefined, true); await old.close();
    const original = old.node({ l: 0, i: 0 });
    const job = prepareImport(dir, old, [entry('one'), entry('one')], 'append'); assert.ok(job);
    assert.equal(job.added, 1); assert.equal(job.skipped, 1); assert.equal(memoryDirectory(dir), dir);
    await runImport(dir, short, AbortSignal.timeout(5000));
    assert.equal(pendingImport(dir), undefined); assert.notEqual(memoryDirectory(dir), dir);
    activated = new Memory(memoryDirectory(dir), short);
    assert.deepEqual(activated.node({ l: 0, i: 0 }), original);
    assert.equal(activated.root[0].text, 'original exact message');
    assert.equal(activated.root[1].receipt, 'import:one');
    assert.match(activated.zoom(1, 1), /Imported one/);
    assert.deepEqual(deduplicate(activated.root, [entry('one')]), { added: [], skipped: 1 });
    assert.ok(existsSync(join(dir, 'main')));
  } finally { await old.close(); await activated?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('paused imports retain completed summaries, resume from disk, and preserve prior generation through rebuild', async () => {
  const dir = temp(); const old = new Memory(dir, short);
  let current: Memory | undefined;
  try {
    old.append('user', 'native later', '2026-06-01T00:00:00.000Z'); await old.settle(undefined, true); await old.close();
    prepareImport(dir, old, [entry('a'), entry('b', date, 'large '.repeat(200))], 'rebuild');
    await assert.rejects(runImport(dir, async (_input, signal) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return '';
    }, AbortSignal.timeout(50)));
    assert.equal(memoryDirectory(dir), dir); assert.ok(pendingImport(dir));
    const staged = new Memory(join(dir, pendingImport(dir)!.target), short); const saved = staged.tree.size; await staged.close();
    assert.ok(saved >= 1);
    await runImport(dir, short, AbortSignal.timeout(5000));
    current = new Memory(memoryDirectory(dir), short);
    assert.equal(current.root[0].receipt, 'import:a'); assert.equal(current.root.at(-1)?.text, 'native later');
    assert.ok(current.tree.size >= saved);
    assert.ok(readFileSync(join(dir, 'main', localDay() + '.jsonl'), 'utf8').includes('native later'));
  } finally { await old.close(); await current?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('discard leaves original memory active and a completed pointer swap can finish recovery idempotently', async () => {
  const dir = temp(), old = new Memory(dir, short);
  try {
    old.append('user', 'original'); await old.settle(undefined, true); await old.close();
    const discarded = prepareImport(dir, old, [entry('discard')], 'append'); assert.ok(discarded);
    discardImport(dir); assert.equal(memoryDirectory(dir), dir); assert.equal(pendingImport(dir), undefined);
    const job = prepareImport(dir, old, [entry('keep')], 'append'); assert.ok(job);
    await runImport(dir, short, AbortSignal.timeout(5000));
    // Simulate the durable pointer write succeeding immediately before journal removal crashed.
    writeFileSync(join(dir, 'imports', 'pending.json'), JSON.stringify(job));
    await runImport(dir, short, AbortSignal.timeout(5000));
    assert.equal(pendingImport(dir), undefined);
    assert.equal(memoryDirectory(dir), join(dir, job.target));
    assert.ok(existsSync(join(dir, 'imports', `${job.id}.json`)));
  } finally { await old.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('chronological rebuild keeps imported conversations and native turns together', () => {
  const first = entry('conversation', date), later = { ...entry('conversation', '2026-12-01T00:00:00.000Z'), receipt: 'import:second' };
  const native: ImportedEntry = { kind: 'user', text: 'native', date: '2026-06-01T00:00:00.000Z' };
  assert.deepEqual(chronological([native, first, later]).map(e => e.text), [first.text, later.text, native.text]);
});

test('a failed progress dialog cancels and joins its worker before returning', async () => {
  const dir = temp(), old = new Memory(dir, short); await old.close();
  try {
    const job = prepareImport(dir, old, [entry('large', date, 'long '.repeat(200))], 'append'); assert.ok(job);
    let stopped = false;
    const ui = { select: async () => { throw new Error('UI closed'); }, input: async () => undefined,
      confirm: async () => false, notify: () => {}, setWidget: () => {} };
    await assert.rejects(showProgress({ ui }, job, async signal => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { stopped = true; resolve(); }, { once: true }));
    }, new AbortController().signal), /UI closed/);
    assert.equal(stopped, true);
    assert.equal(memoryDirectory(dir), dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('preparation source dialog receives shutdown cancellation before staging any data', async () => {
  const dir = temp(), memory = new Memory(dir, short), controller = new AbortController();
  try {
    const ui = { select: async (_title: string, _options: string[], opts?: { signal?: AbortSignal }) => {
      assert.equal(opts?.signal, controller.signal);
      return new Promise<undefined>(resolve => opts?.signal?.addEventListener('abort', () => resolve(undefined), { once: true }));
    }, input: async () => undefined, confirm: async () => false, notify: () => {}, setWidget: () => {}, custom: async () => { throw new Error('unexpected picker'); } };
    const task = chooseImport({ ui }, 'test', memory, 'fixture', controller.signal); controller.abort();
    assert.equal(await task, undefined); assert.equal(pendingImport(dir), undefined);
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});
