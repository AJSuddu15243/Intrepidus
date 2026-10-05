import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import type { Children } from './agents.ts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { record } from './cache.ts';
import { profileSocket } from './profiles.ts';
import { textContent } from './transcript.ts';

type Action = 'start' | 'say' | 'tell-main' | 'complete';
interface Request { kind: 'request'; id: number; action: Action; text?: string; cwd?: string }
interface Reply { kind: 'reply'; id: number; error?: string }
/** `from` marks the conversation itself (your messages and the agent's replies); other messages have no `from`. */
export interface WindowEvent { kind: 'event'; name: 'started' | 'message' | 'status' | 'finished'; text: string; from?: 'user' | 'agent' }
type Frame = Request | Reply | WindowEvent;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function parse(value: unknown): Frame {
  if (!record(value)) throw new Error('Invalid window message');
  const name = value.name, action = value.action, from = value.from;
  if (value.kind === 'event' && (name === 'started' || name === 'message' || name === 'status' || name === 'finished') && typeof value.text === 'string')
    return { kind: 'event', name, text: value.text, from: from === 'user' || from === 'agent' ? from : undefined };
  if (typeof value.id !== 'number' || !Number.isSafeInteger(value.id)) throw new Error('Invalid request ID');
  if (value.kind === 'reply' && (value.error === undefined || typeof value.error === 'string')) return { kind: 'reply', id: value.id, error: value.error };
  if (value.kind === 'request' && (action === 'start' || action === 'say' || action === 'tell-main' || action === 'complete')
    && (value.text === undefined || typeof value.text === 'string') && (value.cwd === undefined || typeof value.cwd === 'string'))
    return { kind: 'request', id: value.id, action, text: value.text, cwd: value.cwd };
  throw new Error('Invalid window message');
}
/** Local JSONL protocol, bounded before parsing; the socket is accessible only by its OS user. */
function wire(socket: Socket, receive: (frame: Frame) => void) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('data', (text: string) => {
    buffer += text;
    if (buffer.length > 4_000_000) { socket.destroy(); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { receive(parse(JSON.parse(line))); } catch { socket.destroy(); return; }
    }
  });
  return (frame: Frame) => {
    if (socket.destroyed) return;
    if (socket.writableLength > 4_000_000) { socket.destroy(); return; }
    socket.write(JSON.stringify(frame) + '\n');
  };
}

/** Call only while holding the profile lock. The owner hosts every child session. */
export async function serveWindows(directory: string, children: Children, available: () => boolean,
  report: (text: string) => Promise<void>) {
  const path = profileSocket(directory, 'windows');
  if (existsSync(path)) unlinkSync(path); // A previous owner can no longer hold the profile lock.
  const connections = new Set<Socket>();
  const work = new Set<Promise<void>>();
  let closing = false;
  const server = createServer(socket => {
    if (closing) { socket.destroy(); return; }
    connections.add(socket);
    let child: string | undefined, cursor = 0, firstUser = true, lastStatus = '', ending = false;
    const said = new Set<string>(); // Main-agent guidance and child reports reach the session as user messages too.
    const controller = new AbortController();
    let queue = Promise.resolve();
    const track = (promise: Promise<void>) => { work.add(promise); void promise.finally(() => work.delete(promise)).catch(() => {}); };
    const send = wire(socket, frame => {
      if (frame.kind !== 'request') { socket.destroy(); return; }
      queue = queue.then(async () => {
        try {
          if (socket.destroyed || ending) throw new Error('Conversation is closing');
          if (frame.action === 'start') {
            if (child) throw new Error('This window already has a conversation');
            if (!available()) throw new Error('Profile is importing or shutting down; try again when it is ready');
            if (!frame.text?.trim() || !frame.cwd) throw new Error('A request and working directory are required');
            [child] = await children.spawn([{ task: frame.text, cwd: frame.cwd }], frame.cwd, controller.signal, undefined, true);
            if (socket.destroyed) { await children.finish(child, closing ? 'owner-stopped' : 'disconnected'); return; }
            send({ kind: 'event', name: 'started', text: child });
          } else {
            if (!child) throw new Error('Send your first request to start a conversation');
            if (frame.action === 'complete') {
              const live = children.live(child);
              if (live) drainMessages(live.session.messages, live.info.task);
              ending = true;
              track(children.finish(child, 'complete').then(() => {}));
              send({ kind: 'event', name: 'finished', text: 'Conversation ended by you. The original window is stopping remaining work and preparing the handoff.' });
            } else {
              if (!frame.text?.trim()) throw new Error('Message is empty');
              if (frame.action === 'say') { said.add(frame.text.trim()); await children.tell(child, frame.text, 'user'); }
              else await report(`[${child}] User message from connected window: ${frame.text}`);
            }
          }
          send({ kind: 'reply', id: frame.id });
        } catch (error) { send({ kind: 'reply', id: frame.id, error: errorText(error) }); }
      });
      track(queue);
    });
    const drainMessages = (messages: AgentMessage[], task: string) => {
      const displayable = messages.filter(message => message.role === 'user' || message.role === 'assistant');
      while (cursor < displayable.length) {
        const message = displayable[cursor++];
        let text = textContent(message.content);
        if (message.role === 'user' && firstUser) { text = task; firstUser = false; said.add(task.trim()); }
        const from = message.role === 'assistant' ? 'agent' : said.has(text) ? 'user' : undefined;
        if (text) send({ kind: 'event', name: 'message', from, text: `${text.slice(0, 200_000)}${text.length > 200_000 ? '\n[Display shortened; full text is saved in the transcript.]' : ''}` });
      }
    };
    const timer = setInterval(() => {
      if (!child || socket.destroyed || ending) return;
      const live = children.live(child), info = children.history.records.get(child);
      if (!info) return;
      if (live) drainMessages(live.session.messages, info.task);
      const preview = live?.streaming && 'content' in live.streaming ? textContent(live.streaming.content).slice(-2000) : '';
      const status = `${info.state === 'waiting' ? 'Awaiting user or child reports' : info.state} · ${info.model}\n${live ? [...live.tools.values()].map(t => t.name).join(', ') : ''}\n${preview}`;
      if (status !== lastStatus) { lastStatus = status; send({ kind: 'event', name: 'status', text: status }); }
      if (!live && info.handoff?.delivered) {
        try { drainMessages(children.messages(child), info.task); }
        catch (error) { send({ kind: 'event', name: 'message', text: `Could not read the final transcript: ${errorText(error)}` }); }
        ending = true;
        send({ kind: 'event', name: 'finished', text: info.handoff.text ?? 'Conversation ended.' });
      }
    }, 150);
    socket.on('close', () => {
      clearInterval(timer); controller.abort(); connections.delete(socket);
      const cleanup = queue.then(async () => { if (child) await children.finish(child, closing ? 'owner-stopped' : 'disconnected'); });
      track(cleanup);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve(); }); });
  chmodSync(path, 0o600);
  return async () => {
    closing = true;
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    for (const socket of connections) socket.destroy();
    await closed;
    await Promise.allSettled([...work]);
  };
}

export async function connectWindow(directory: string, event: (event: WindowEvent) => void, disconnected: () => void) {
  const socket = createConnection(profileSocket(directory, 'windows'));
  let next = 0;
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const send = wire(socket, frame => {
    if (frame.kind === 'event') { event(frame); return; }
    if (frame.kind !== 'reply') { socket.destroy(); return; }
    const request = pending.get(frame.id); if (!request) return;
    clearTimeout(request.timer); pending.delete(frame.id);
    if (frame.error) request.reject(new Error(frame.error)); else request.resolve();
  });
  socket.on('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Connection to the original Pi window was lost')); }
    pending.clear(); disconnected();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve); socket.once('error', reject);
    socket.setTimeout(5000, () => socket.destroy(new Error('Profile owner did not respond')));
  });
  socket.setTimeout(0);
  return {
    async request(action: Action, text?: string, cwd?: string) {
      if (socket.destroyed) throw new Error('The original Pi window is disconnected');
      if (text && text.length > 256_000) throw new Error('Connected-window messages are limited to 256,000 characters');
      const id = next++;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Owner response timed out; closing this connection')); socket.destroy(); }, 120_000);
        pending.set(id, { resolve, reject, timer }); send({ kind: 'request', id, action, text, cwd });
      });
    },
    close() { socket.destroy(); },
  };
}
