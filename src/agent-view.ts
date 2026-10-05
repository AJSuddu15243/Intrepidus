import {
  AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, getMarkdownTheme, getSelectListTheme,
  createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Editor, Spacer, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI } from '@earendil-works/pi-tui';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Children } from './agents.ts';
import type { RunInfo } from './runs.ts';
import { textContent } from './transcript.ts';
import { record } from './cache.ts';
import { elapsed, fit, oneLine } from './inspector.ts';

export type ViewTone = 'accent' | 'muted' | 'dim' | 'error' | 'warning' | 'success' | 'borderMuted';
type ToolResult = Parameters<ToolExecutionComponent['updateResult']>[0];
type Renderers = ConstructorParameters<typeof ToolExecutionComponent>[4];

/** Pi's own renderers for its built-in tools, so saved runs draw like the main chat. */
const builtIns: Record<string, (cwd: string) => Renderers> = {
  bash: createBashToolDefinition, read: createReadToolDefinition, edit: createEditToolDefinition, write: createWriteToolDefinition,
  grep: createGrepToolDefinition, find: createFindToolDefinition, ls: createLsToolDefinition,
};

function toolResult(value: unknown, isError = false): ToolResult | undefined {
  if (!record(value) || !Array.isArray(value.content)) return undefined;
  const content = value.content.flatMap((part: unknown) => record(part) && typeof part.type === 'string'
    ? [{ type: part.type, ...(typeof part.text === 'string' ? { text: part.text } : {}), ...(typeof part.data === 'string' ? { data: part.data } : {}), ...(typeof part.mimeType === 'string' ? { mimeType: part.mimeType } : {}) }] : []);
  return { content, details: value.details, isError };
}

/**
 * Builds the child's conversation from Pi's chat components and keeps them between frames,
 * so streaming text and running tools update in place like in the main chat.
 */
export class TranscriptView {
  private readonly messages = new WeakMap<AgentMessage, Component>();
  private readonly tools = new Map<string, ToolExecutionComponent>();
  private readonly settled = new Set<string>();
  private readonly partials = new Map<string, unknown>();
  private streaming?: AssistantMessageComponent;
  private expanded = false;
  constructor(private readonly tui: TUI, private readonly cwd: string, private readonly definition: (name: string) => Renderers = () => undefined) {}
  toggleTools() { this.expanded = !this.expanded; for (const tool of this.tools.values()) tool.setExpanded(this.expanded); }
  private tool(id: string, name: string, args: unknown) {
    let tool = this.tools.get(id);
    if (!tool) {
      tool = new ToolExecutionComponent(name, id, args, { showImages: false }, builtIns[name]?.(this.cwd) ?? this.definition(name), this.tui, this.cwd);
      tool.setExpanded(this.expanded); this.tools.set(id, tool);
    }
    return tool;
  }
  /** `task` replaces the first prompt, which also carries the memory view the child got as context. */
  build(task: string, messages: AgentMessage[], streaming?: AgentMessage, running?: Map<string, { output?: unknown }>): Component[] {
    const parts: Component[] = [];
    let first = true;
    for (const message of messages) {
      if (message.role === 'user') {
        const text = first ? task : textContent(message.content).trim(); first = false;
        if (!text) continue;
        let component = this.messages.get(message);
        if (!component) { component = new UserMessageComponent(text, getMarkdownTheme()); this.messages.set(message, component); }
        if (parts.length) parts.push(new Spacer(1));
        parts.push(component);
      } else if (message.role === 'assistant') {
        const live = message === streaming;
        let component: Component | undefined;
        if (live) { this.streaming ??= new AssistantMessageComponent(undefined, true, getMarkdownTheme()); this.streaming.updateContent(message, true); component = this.streaming; }
        else {
          component = this.messages.get(message);
          if (!component) { component = new AssistantMessageComponent(message, true, getMarkdownTheme()); this.messages.set(message, component); }
        }
        parts.push(component);
        for (const part of message.content) {
          if (part.type !== 'toolCall') continue;
          const tool = this.tool(part.id, part.name, part.arguments);
          if (live) { if (this.partials.get(`args:${part.id}`) !== part.arguments) { tool.updateArgs(part.arguments); this.partials.set(`args:${part.id}`, part.arguments); } }
          else if (!this.settled.has(`args:${part.id}`)) {
            tool.updateArgs(part.arguments); tool.setArgsComplete(); this.settled.add(`args:${part.id}`);
            if ((message.stopReason === 'aborted' || message.stopReason === 'error') && !this.settled.has(part.id)) {
              tool.updateResult({ content: [{ type: 'text', text: message.errorMessage || (message.stopReason === 'aborted' ? 'Operation aborted' : 'Error') }], isError: true });
              this.settled.add(part.id);
            }
          }
          parts.push(tool);
        }
      } else if (message.role === 'toolResult' && !this.settled.has(message.toolCallId)) {
        const result = toolResult(message, message.isError);
        const tool = this.tools.get(message.toolCallId);
        if (result && tool) { tool.updateResult(result); this.settled.add(message.toolCallId); }
      }
    }
    if (!streaming) this.streaming = undefined;
    // Each call below redraws, so only pass on what changed since the last frame.
    for (const [id, run] of running ?? []) {
      const tool = this.tools.get(id);
      if (!tool || this.settled.has(id)) continue;
      if (!this.settled.has(`started:${id}`)) { tool.markExecutionStarted(); this.settled.add(`started:${id}`); }
      const partial = run.output !== this.partials.get(id) ? toolResult(run.output) : undefined;
      if (partial) { tool.updateResult(partial, true); this.partials.set(id, run.output); }
    }
    return parts;
  }
}

export interface AgentViewOptions {
  id: string; children: Children; tui: TUI;
  rows: () => number; redraw: () => void; done: () => void;
  color: (tone: ViewTone, text: string) => string;
  /** Pi's tool-output toggle (Ctrl+O by default), so tool calls expand the same way as in the main chat. */
  isExpandKey?: (data: string) => boolean;
  signal?: AbortSignal;
}

const statusOf = (run: RunInfo, children: Children) => {
  const live = children.live(run.id);
  if (!live) return run.state;
  if (run.state === 'stopping') return 'stopping';
  if (run.state === 'waiting') return 'waiting for its agents';
  const tools = [...live.tools.values()].map(t => t.name);
  return tools.length ? `running ${tools.join(', ')}` : live.streaming ? 'writing' : 'working';
};

/**
 * The subagent's conversation in place of the main one: same message components, one header line,
 * an input that guides the agent, and Esc back to the main chat. A UI projection only.
 */
export class AgentView implements Component, Focusable {
  private readonly editor: Editor;
  private readonly transcript: TranscriptView;
  private back = 0; // Lines scrolled up from the newest; 0 follows live output.
  private bodyHeight = 1;
  private overflow = 0;
  private saved?: AgentMessage[];
  private wasLive = false;
  private confirmStop = false;
  private notice = '';
  private ended = false;
  private hasFocus = true;
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly options: AgentViewOptions) {
    const { children, id, tui, color } = options;
    const run = children.history.records.get(id);
    this.transcript = new TranscriptView(tui, run?.cwd ?? process.cwd(), name => children.live(id)?.session.getToolDefinition(name));
    this.editor = new Editor(tui, { borderColor: text => color('borderMuted', text), selectList: getSelectListTheme() });
    this.editor.onSubmit = text => this.send(text);
    this.editor.focused = true;
    this.unsubscribe = children.subscribe(() => options.redraw());
    this.timer = setInterval(() => options.redraw(), 1000); this.timer.unref();
    options.signal?.addEventListener('abort', this.close, { once: true });
    if (options.signal?.aborted) queueMicrotask(this.close);
  }
  get focused() { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.editor.focused = value; }
  private readonly close = () => { if (!this.ended) { this.dispose(); this.options.done(); } };
  dispose() { this.ended = true; clearInterval(this.timer); this.unsubscribe(); this.options.signal?.removeEventListener('abort', this.close); }
  invalidate() { this.editor.invalidate(); }
  private get canMessage() { return ['running', 'waiting'].includes(this.options.children.live(this.options.id)?.info.state ?? ''); }
  private send(text: string) {
    const message = text.trim(), { children, id } = this.options;
    if (!message) return;
    children.tell(id, message, 'user').then(() => { this.notice = ''; }, (error: unknown) => {
      this.editor.setText(text); this.notice = `Not sent: ${error instanceof Error ? error.message : String(error)}`;
    }).finally(() => { if (!this.ended) this.options.redraw(); });
  }
  handleInput(data: string) {
    if (this.ended) return;
    const { children, id } = this.options;
    const stopping = this.confirmStop; this.confirmStop = false; this.notice = '';
    if (matchesKey(data, 'escape') && !this.editor.isShowingAutocomplete()) return this.close();
    if (matchesKey(data, 'ctrl+x')) {
      if (!children.live(id)) this.notice = 'This agent has already finished.';
      else if (stopping) children.stop(id).catch((error: unknown) => { this.notice = `Could not stop: ${String(error)}`; this.options.redraw(); });
      else this.confirmStop = true;
    } else if (matchesKey(data, 'pageUp')) this.back = Math.min(this.overflow, this.back + Math.max(1, this.bodyHeight - 2));
    else if (matchesKey(data, 'pageDown')) this.back = Math.max(0, this.back - Math.max(1, this.bodyHeight - 2));
    else if (this.options.isExpandKey?.(data)) this.transcript.toggleTools();
    else if (this.canMessage) this.editor.handleInput(data);
    this.options.redraw();
  }
  private messages(run: RunInfo) {
    const { children } = this.options, live = children.live(run.id);
    // Saved transcripts are read once; live ones come from memory each frame, plus one final read when the run ends.
    if (live || this.wasLive || !this.saved) {
      try { this.saved = children.messages(run.id); }
      catch (error) { this.notice = `Transcript unavailable: ${String(error)}`; this.saved = []; }
    }
    this.wasLive = !!live;
    return this.saved;
  }
  private header(run: RunInfo | undefined, width: number) {
    const { color, children, id } = this.options;
    if (!run) return color('error', ` ${id} · run not found`);
    const live = children.live(run.id);
    const dot = live ? color('accent', '●') : run.state === 'completed' ? color('success', '✓') : run.state === 'failed' ? color('error', '✗') : color('muted', '■');
    const right = `${statusOf(run, children)} · ${elapsed((run.ended ?? Date.now()) - run.started)} · ${run.model.slice(run.model.indexOf('/') + 1)}`;
    const left = ` ${dot} ${color('accent', run.id)}  `;
    const room = width - visibleWidth(left) - visibleWidth(right) - 3;
    if (room < 8) return truncateToWidth(`${left}${color('dim', right)}`, width);
    const task = fit(oneLine(run.task), room);
    return `${left}${task}${' '.repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(task) - visibleWidth(right) - 1))}${color('dim', right)} `;
  }
  render(width: number): string[] {
    const { color, children, id, rows } = this.options;
    const run = children.history.records.get(id), live = children.live(id);
    const height = Math.max(6, rows());
    const top = [this.header(run, width), color('borderMuted', '─'.repeat(width))];
    let input: string[];
    if (this.canMessage) input = this.editor.render(width);
    else if (live) input = [color('dim', ' Stopping…')];
    else input = run ? [color('borderMuted', '─'.repeat(width)), color('dim', ` ${run.state === 'completed' ? 'Finished' : `Ended (${run.state})`}. ${run.parentId ? 'Its report went to the agent that started it.' : 'Its report went to the main agent.'}`)] : [];
    const queued = (run?.guidance ?? []).filter(g => g.state !== 'delivered')
      .map(g => color(g.state === 'queued' ? 'muted' : 'warning', ` ${g.state === 'queued' ? 'Queued' : 'Not delivered'}: ${oneLine(g.text)}`));
    this.bodyHeight = Math.max(1, height - top.length - input.length - 1 - queued.length); // One footer line.
    const parts = run ? this.transcript.build(run.task, this.messages(run), live?.streaming, live?.tools) : [];
    const lines = parts.flatMap(part => part.render(width));
    this.overflow = Math.max(0, lines.length - this.bodyHeight);
    this.back = Math.min(this.back, this.overflow);
    const end = lines.length - this.back;
    const body = lines.slice(Math.max(0, end - this.bodyHeight), end);
    while (body.length < this.bodyHeight) body.push('');
    const hint = this.confirmStop ? color('warning', ' Press Ctrl+X again to stop this agent and the agents it started')
      : this.notice ? color('error', ` ${this.notice}`)
      : color('dim', ` Esc back to main${live ? ' · Ctrl+X stop' : ''}${this.overflow ? this.back ? ' · PgDn newer' : ' · PgUp older' : ''}`);
    const scrolled = this.back ? color('warning', `↑ ${this.back} lines up `) : '';
    const footer = [visibleWidth(hint) + visibleWidth(scrolled) < width ? `${hint}${' '.repeat(width - visibleWidth(hint) - visibleWidth(scrolled))}${scrolled}` : hint];
    return [...top, ...body, ...queued, ...input, ...footer].slice(0, height).map(line => truncateToWidth(line, width));
  }
}

/** Swaps the whole screen to the subagent's conversation; Pi restores the main chat on close. */
export function showAgentView(ctx: ExtensionContext, options: { id: string; children: Children; signal?: AbortSignal }) {
  return ctx.ui.custom<void>((tui, theme, keybindings, done) => new AgentView({ ...options, tui,
    rows: () => tui.terminal.rows, redraw: () => tui.requestRender(), done: () => done(undefined),
    color: (tone, text) => theme.fg(tone, text), isExpandKey: data => keybindings.matches(data, 'app.tools.expand'),
  }), { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', row: 0, col: 0 } });
}
