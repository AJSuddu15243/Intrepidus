import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { connectWindow } from './window-bridge.ts';
import { profilePath } from './profiles.ts';

export async function openConnectedWindow(pi: ExtensionAPI, ctx: ExtensionContext, profile: string) {
  let started = false, ended = false;
  const display = (text: string) => pi.sendMessage({ customType: 'optchat-connected', content: text, display: true }, { triggerTurn: false });
  const connection = await connectWindow(profilePath(profile), event => {
    if (event.name === 'started') {
      started = true;
      ctx.ui.setStatus('optchat', `OptChat: ${profile} · connected agent ${event.text} · /complete`);
    } else if (event.name === 'status') {
      ctx.ui.setWidget('optchat-connected', event.text.split('\n').slice(-8));
    } else {
      display(event.text);
      if (event.name === 'finished') {
        ended = true; ctx.ui.setWidget('optchat-connected', undefined);
        ctx.ui.setStatus('optchat', `OptChat: ${profile} · conversation ended · /complete to exit`);
      }
    }
  }, () => {
    if (ended) return;
    ended = true; ctx.ui.setWidget('optchat-connected', undefined);
    ctx.ui.setStatus('optchat', `OptChat: ${profile} · disconnected`);
    ctx.ui.notify('Connection closed. The owner saves the interrupted conversation and handoff; no local agent will run here.', 'info');
  });
  ctx.ui.setStatus('optchat', `OptChat: ${profile} · connected window · send a task to start`);
  display(`Connected to ${profile}'s original window. Messages here go to one subagent using the profile's subagent model. /tell-main sends a message to the main agent; /complete ends this conversation and sends a handoff. Closing this window interrupts it.`);
  return {
    async submit(text: string) {
      if (ended) throw new Error('Conversation ended. Open a new Pi window to start another.');
      await connection.request(started ? 'say' : 'start', text, ctx.cwd);
    },
    async tell(text: string) { await connection.request('tell-main', text); },
    async complete() {
      ctx.ui.setWorkingMessage('Ending conversation and preparing handoff…');
      try {
        if (started && !ended) await connection.request('complete');
        ended = true; connection.close(); ctx.shutdown();
      } finally { ctx.ui.setWorkingMessage(); }
    },
    close() { ended = true; connection.close(); },
  };
}
