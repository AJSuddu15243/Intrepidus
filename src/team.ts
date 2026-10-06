import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Memory, bytes, flat, start } from './memory.ts';
import { memoryDirectory } from './import/job.ts';

export const TEAM_BYTES = 32_000;
export const GREP_BYTES = 4_000;

/** Teammates' memories, read-only: this machine never writes under another member's directory. */
export class Team {
  readonly members = new Map<string, Memory>();
  constructor(readonly root: string, readonly me: string, readonly budget = TEAM_BYTES,
    private readonly warn: (s: string) => void = console.error) { this.reload(); }
  reload() {
    this.members.clear();
    const candidates: { name: string; dir: string }[] = [];
    const names = readdirSync(this.root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== this.me && !entry.name.startsWith('.'))
      .map(entry => entry.name).sort();
    for (const name of names) {
      try {
        const dir = memoryDirectory(join(this.root, name));
        if (existsSync(join(dir, 'main'))) candidates.push({ name, dir });
      } catch (error) { this.warn(`Teammate ${name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (!candidates.length) return;
    const perMember = Math.max(4_000, Math.floor(this.budget / candidates.length));
    for (const { name, dir } of candidates) {
      let memory: Memory;
      try { memory = new Memory(dir, async () => { throw new Error('read-only'); }, this.warn, perMember, 8, 10_000, true); }
      catch (error) { this.warn(`Teammate ${name}: ${error instanceof Error ? error.message : String(error)}`); continue; }
      if (memory.root.length === 0) continue;
      this.members.set(name, memory);
    }
  }
  render() {
    return [...this.members].map(([who, memory]) => memory.render().replace('<chat>', `<chat who="${who}">`)).join('\n');
  }
  memory(who: string) {
    const memory = this.members.get(who);
    if (!memory) throw new Error(`No teammate ${who}.`);
    return memory;
  }
  grep(regex: string, who?: string, self?: Memory) {
    if (who !== undefined) return grepChats(regex, [[who, this.memory(who)]]);
    return grepChats(regex, [...(self ? [['you', self] as [string, Memory]] : []), ...this.members]);
  }
}

/** Newest first: view lines of built nodes, then raw messages. Tree hits are id+n zoom lines like the view. */
export function grepChats(regex: string, chats: Iterable<[string, Memory]>) {
  const re = new RegExp(regex, 'i');
  const hits: string[] = [];
  for (const [who, memory] of chats) {
    for (let i = memory.view.length - 1; i >= 0; i--) {
      const part = memory.view[i], node = memory.node(part);
      if (node && re.test(node.text)) hits.push(`@${who} ${start(part)}+${2 ** part.l}|${flat(node.text).slice(0, 200)}`);
    }
    for (let i = memory.root.length - 1; i >= 0; i--) {
      const entry = memory.root[i];
      if (re.test(entry.text)) hits.push(`@${who} ${entry.i}+0|${entry.kind}: ${flat(entry.text).slice(0, 200)} (${entry.size} bytes)`);
    }
  }
  if (!hits.length) return 'No match.';
  let output = '', kept = 0;
  for (; kept < hits.length; kept++) {
    const next = output ? `${output}\n${hits[kept]}` : hits[kept];
    if (bytes(next) > GREP_BYTES) break;
    output = next;
  }
  if (kept < hits.length) output += `\n${hits.length - kept} more hits; narrow the regex.`;
  return output;
}
