import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { record } from './cache.ts';
import { atomicWrite } from './profiles.ts';
import type { Memory } from './memory.ts';

interface Arrival { id: string; text: string; date: string }
/** Durable arrivals bridge the period before a new turn's old-history snapshot is ready. */
export class Inbox {
  private readonly file: string;
  private items: Arrival[];
  private readonly claimed = new Set<string>();
  constructor(directory: string) {
    this.file = join(directory, 'pending-inputs.json');
    const saved: unknown = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : [];
    if (!Array.isArray(saved) || !saved.every(v => record(v) && typeof v.id === 'string' && typeof v.text === 'string' && typeof v.date === 'string'))
      throw new Error('Invalid pending input journal.');
    this.items = saved;
  }
  private save() { atomicWrite(this.file, JSON.stringify(this.items)); }
  record(text: string) {
    const item = { id: randomUUID(), text, date: new Date().toISOString() };
    this.items.push(item); this.save(); return item.id;
  }
  claim(text: string) {
    const item = this.items.find(i => !this.claimed.has(i.id) && i.text === text);
    if (!item) return undefined;
    this.claimed.add(item.id); return item.id;
  }
  acknowledge(id: string) {
    this.items = this.items.filter(i => i.id !== id); this.claimed.delete(id); this.save();
  }
  recover(memory: Memory) {
    let count = 0;
    const receipts = new Set(memory.root.map(e => e.receipt));
    for (const item of this.items) {
      if (!receipts.has(item.id)) { memory.append('user', item.text, item.date, item.id); count++; }
    }
    this.items = []; this.claimed.clear(); this.save(); return count;
  }
}
