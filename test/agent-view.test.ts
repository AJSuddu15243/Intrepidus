import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry, ModelRuntime, SessionManager, initTheme } from '@earendil-works/pi-coding-agent';
import { TuiMainScreen, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { AgentView } from '../src/agent-view.ts';
import { emptyUsage } from '../src/usage.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));
initTheme('dark', false);

class OffscreenTerminal implements Terminal {
  start() {} stop() {} async drainInput() {} write() {}
  get columns() { return 100; } get rows() { return 30; } get kittyProtocolActive() { return false; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
const plain = (lines: string[]) => lines.join('\n').replace(/\x1b\[[0-9;:]*[A-Za-z]|\x1b[\]_][^\x07\x1b]*(\x07|\x1b\\)/g, '');

test('agent view shows the child conversation like the main chat, fills the screen, and Esc returns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-agent-view-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
  const session = SessionManager.create(dir, join(dir, 'runs'));
  const assistant = { api: 'anthropic-messages', provider: 'test', model: 'test', usage: emptyUsage() } as const;
  session.appendMessage({ role: 'user', content: 'MEMORY VIEW MUST NOT APPEAR\n\nYour task:\nCount the files', timestamp: 1 });
  session.appendMessage({ role: 'assistant', ...assistant, stopReason: 'toolUse', timestamp: 2,
    content: [{ type: 'thinking', thinking: 'hidden reasoning' }, { type: 'text', text: 'Listing them now.' }, { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls | wc -l' } }] });
  session.appendMessage({ role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: 'TOOL_OUTPUT_42' }], isError: false, timestamp: 3 });
  session.appendMessage({ role: 'assistant', ...assistant, stopReason: 'stop', timestamp: 4, content: [{ type: 'text', text: 'There are **42** files.' }] });
  children.history.records.set('child-1', { id: 'child-1', task: 'Count the files', cwd: dir, model: 'anthropic/claude-test', thinking: 'high',
    parentSession: 'parent', depth: 1, sessionFile: session.getSessionFile(), started: 1000, ended: 61_000, state: 'completed', guidance: [] });
  const tui = new TuiMainScreen(new OffscreenTerminal());
  let rows = 30, closed = 0;
  const view = new AgentView({ id: 'child-1', children, tui, rows: () => rows, redraw: () => {}, done: () => { closed++; }, color: (_tone, text) => text });
  try {
    const lines = view.render(100), text = plain(lines);
    assert.equal(lines.length, 30, 'fills the screen so the main chat is hidden');
    assert.ok(lines.every(line => visibleWidth(line) <= 100));
    assert.match(lines[0], /child-1 {2}Count the files .*completed · 1m 0s · claude-test/);
    assert.match(text, /\$ ls \| wc -l/, "bash calls use Pi's own renderer");
    assert.match(text, /TOOL_OUTPUT_42/);
    assert.match(text, /There are 42 files\./);
    assert.match(text, /Esc back to main/);
    assert.doesNotMatch(text, /MEMORY VIEW MUST NOT APPEAR|hidden reasoning|Ctrl\+X/);
    assert.ok(text.indexOf('Count the files', text.indexOf('\n')) < text.indexOf('Listing them now.'), 'the task opens the conversation');
    rows = 12;
    assert.equal(view.render(40).length, 12);
    view.handleInput('\x1b[5~');
    assert.match(plain(view.render(40)), /PgDn newer/);
    view.handleInput('x'); // Finished agents take no input.
    view.handleInput('\x1b');
    assert.equal(closed, 1);
  } finally { view.dispose(); await children.close(); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});
