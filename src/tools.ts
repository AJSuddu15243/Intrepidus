import { Type } from 'typebox';
import type { Memory } from './memory.ts';
export const result = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });
export function memoryTools(memory: () => Memory) {
  return [
    { name: 'zoom', label: 'Zoom memory', description: 'Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.',
      parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), n: Type.Integer({ minimum: 1 }) }),
      async execute(_id: string, args: { id: number; n: number }) { return result(memory().zoom(args.id, args.n)); } },
    { name: 'date', label: 'Memory date', description: 'The date and time of message id.',
      parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
      async execute(_id: string, args: { id: number }) { return result(memory().date(args.id)); } },
  ];
}
