import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, getAgentDir, type AgentSession, type ModelRegistry } from '@earendil-works/pi-coding-agent';
import { SUBAGENT, VIEW_DOC } from './prompts.ts';
import { memoryTools } from './tools.ts';
import { type Memory } from './memory.ts';
import type { ModelChoice } from './compactor.ts';
import { cachePayload } from './cache.ts';

export const webExtension = join(dirname(fileURLToPath(import.meta.url)), '../node_modules/pi-web-access/dist/index.js');
export class Children {
  private readonly running = new Map<string, AgentSession>();
  private closing = false;
  private readonly completions = new Set<Promise<void>>();
  constructor(private readonly memory: Memory, private readonly registry: ModelRegistry,
    private readonly choice: () => ModelChoice, private readonly instructions: () => string,
    private readonly report: (text: string) => Promise<void>, private readonly warn: (text: string) => void,
    private readonly profileDirectory = memory.directory) {}
  get ids() { return [...this.running.keys()]; }
  get active() { return this.completions.size > 0; }
  async spawn(tasks: { task: string; cwd?: string }[], cwd: string, signal?: AbortSignal) {
    await this.memory.settle(signal);
    const view = this.memory.render();
    const selected = this.choice();
    const model = this.registry.find(selected.provider, selected.model);
    if (!model) throw new Error(`Subagent model unavailable: ${selected.provider}/${selected.model}`);
    const launched: { id: string; session: AgentSession; task: string }[] = [];
    try {
      for (const task of tasks) {
        signal?.throwIfAborted();
        const id = randomUUID().slice(0, 8), directory = task.cwd ?? cwd;
        const prompt = `${SUBAGENT}\n\n${VIEW_DOC}\n\n${this.instructions()}\n\nWorking directory: ${directory}`;
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off' });
        const loader = new DefaultResourceLoader({ cwd: directory, agentDir: getAgentDir(), settingsManager,
          noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true,
          additionalExtensionPaths: [webExtension], systemPrompt: prompt,
          extensionFactories: [pi => {
            pi.on('before_agent_start', () => ({ systemPrompt: prompt }));
            pi.on('before_provider_request', (event, ctx) => ctx.model?.api === 'anthropic-messages' ? cachePayload(event.payload) : event.payload);
          }],
        });
        await loader.reload();
        const { session } = await createAgentSession({ cwd: directory, resourceLoader: loader, settingsManager,
          model, thinkingLevel: selected.thinking, sessionManager: SessionManager.create(directory, join(this.profileDirectory, 'runs')),
          customTools: memoryTools(() => this.memory), excludeTools: ['spawn', 'tell'],
        });
        await session.bindExtensions({});
        this.running.set(id, session); launched.push({ id, session, task: task.task });
      }
    } catch (error) {
      for (const child of launched) { child.session.dispose(); this.running.delete(child.id); }
      throw error;
    }
    // No awaiting the work: IDs return now. One report message per spawn batch.
    const work = Promise.all(launched.map(async ({ id, session, task }) => {
      try {
        await session.prompt(`${view}\n\nYour task:\n${task}`);
        const last = [...session.messages].reverse().find(m => m.role === 'assistant');
        const text = last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted')
          ? `Task ${last.stopReason}: ${last.errorMessage ?? 'No details'}` : session.getLastAssistantText() || 'Finished without a text report.';
        return `[${id}] ${text}`;
      } catch (error) { return `[${id}] Failed: ${error instanceof Error ? error.message : String(error)}`; }
      finally {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose(); this.running.delete(id);
      }
    })).then(async reports => {
      const text = reports.join('\n\n');
      if (this.closing) {
        this.memory.append('user', text); return;
      }
      try { await this.report(text); }
      catch (error) {
        this.memory.append('user', text);
        this.warn(`Subagent report saved but could not wake the parent: ${String(error)}`);
      }
    }).catch(error => this.warn(`Subagent completion failed: ${String(error)}`)).finally(() => { this.completions.delete(work); });
    this.completions.add(work);
    return launched.map(c => c.id);
  }
  async tell(id: string, message: string) {
    const session = this.running.get(id);
    if (!session) throw new Error(`No running subagent ${id}.`);
    await session.steer(message); return 'Message queued for the next tool boundary.';
  }
  async stop(id: string) {
    const session = this.running.get(id);
    if (!session) throw new Error(`No running subagent ${id}.`);
    await session.abort();
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.running.values()].map(s => s.abort()));
    await Promise.allSettled(this.completions);
  }
}
