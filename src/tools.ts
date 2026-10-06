import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Memory } from './memory.ts';
import { grepChats, type Team } from './team.ts';
export const result = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });
export function memoryTools(memory: () => Memory, team: () => Team | undefined = () => undefined): ToolDefinition[] {
  const pick = (who: string) => { const t = team(); if (!t) throw new Error(`No teammate ${who}.`); return t.memory(who); };
  return [
    { name: 'zoom', label: 'Zoom memory', description: 'Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole. who = a teammate\'s handle to open their chat; omit for your own.',
      parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), n: Type.Integer({ minimum: 1 }), who: Type.Optional(Type.String()) }),
      async execute(_id: string, args: { id: number; n: number; who?: string }) { return result((args.who ? pick(args.who) : memory()).zoom(args.id, args.n)); } },
    { name: 'date', label: 'Memory date', description: 'The date and time of message id. who = a teammate\'s handle; omit for your own.',
      parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), who: Type.Optional(Type.String()) }),
      async execute(_id: string, args: { id: number; who?: string }) { return result((args.who ? pick(args.who) : memory()).date(args.id)); } },
    { name: 'grep', label: 'Search memory', description: 'Search the one-line summaries and the full messages of every chat for a regex (case-insensitive). who = one teammate\'s handle; omit to search everyone including yourself. Hits show id+n lines you can zoom.',
      parameters: Type.Object({ regex: Type.String(), who: Type.Optional(Type.String()) }),
      async execute(_id: string, args: { regex: string; who?: string }) {
        const t = team();
        if (t) return result(t.grep(args.regex, args.who, memory()));
        if (args.who) throw new Error(`No teammate ${args.who}.`);
        return result(grepChats(args.regex, [['you', memory()]]));
      } },
  ];
}
