import { getMarkdownTheme, UserMessageComponent, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Markdown } from '@earendil-works/pi-tui';
import { connectWindow, type WindowEvent } from './window-bridge.ts';
import { profilePath } from './profiles.ts';
import { statusState, windowTitle, type WindowState } from './title.ts';

type Details = { from?: WindowEvent['from'] };

/** The conversation itself renders like a normal chat; everything else keeps Pi's boxed custom-message look. */
export function registerConnectedRenderer(pi: ExtensionAPI) {
  pi.registerMessageRenderer<Details>('optchat-connected', (message, { outputPad }) => {
    const text = typeof message.content === 'string' ? message.content : '';
    if (message.details?.from === 'user') return new UserMessageComponent(text, getMarkdownTheme(), outputPad);
    return message.details?.from === 'agent' ? new Markdown(text.trim(), outputPad, 0, getMarkdownTheme()) : undefined;
  });
}

export async function openConnectedWindow(pi: ExtensionAPI, ctx: ExtensionContext, profile: string, setTitle: (title: string) => void = title => ctx.ui.setTitle(title)) {
  let started = false, ended = false;
  const title = (state: WindowState) => setTitle(windowTitle(profile, state));
  const display = (text: string, from?: WindowEvent['from']) => pi.sendMessage<Details>({ customType: 'optchat-connected', content: text, display: true, details: { from } }, { triggerTurn: false });
  const connection = await connectWindow(profilePath(profile), event => {
    if (event.name === 'started') {
      started = true; title('working');
      ctx.ui.setStatus('optchat', `OptChat: ${profile} · connected agent ${event.text} · /complete`);
    } else if (event.name === 'status') {
      ctx.ui.setWidget('optchat-connected', event.text.split('\n').slice(-8));
      if (!ended) title(statusState(event.text));
    } else {
      display(event.text, event.from);
      if (event.name === 'finished') {
        ended = true; ctx.ui.setWidget('optchat-connected', undefined); title('done');
        ctx.ui.setStatus('optchat', `OptChat: ${profile} · conversation ended · /complete to exit`);
      }
    }
  }, () => {
    if (ended) return;
    ended = true; ctx.ui.setWidget('optchat-connected', undefined);
    ctx.ui.setStatus('optchat', `OptChat: ${profile} · disconnected`); title('disconnected');
    ctx.ui.notify('Connection closed. The owner saves the interrupted conversation and handoff; no local agent will run here.', 'info');
  });
  ctx.ui.setStatus('optchat', `OptChat: ${profile} · connected window · send a task to start`); title('waiting');
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
