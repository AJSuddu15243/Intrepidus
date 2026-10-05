# pi-optchat

A Pi extension that implements [Victor Taelin's OptChat recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449): one endless chat per profile, remembered through a summary tree instead of compaction.

- **Memory**: every message is logged and summarized into a binary tree. Each turn starts from a fresh context holding a bounded memory view; the agent uses `zoom` and `date` to read originals.
- **Profiles**: separate memories and instructions, such as `work` and `personal`.
- **Subagents**: delegate tasks to background agents, inspect them live, and send them guidance.
- **Import**: bring in history from Claude Code, Codex, or ChatGPT.
- **Connected windows**: a second Pi window on the same profile becomes a subagent you talk to directly.

It runs inside ordinary Pi, with no fork or separate launcher.

## Install

```sh
pi install npm:pi-optchat
pi install npm:pi-web-access   # optional, for web search and page fetching
```

Or from GitHub: `pi install git:github.com/jonaslsaa/pi-optchat`.

Requirements: Pi 1.0.2 or compatible, Node.js 22.19+, and Git. Tested on macOS; the offline tests also run on Linux.

Web access is not bundled. Subagents load the Pi extensions you have installed (except pi-optchat itself), so installing `pi-web-access` gives web tools to the main agent and every subagent.

To uninstall, run `pi remove git:github.com/jonaslsaa/pi-optchat`. Profile data is kept.

## Quick start

1. Restart Pi.
2. Choose **+ Create profile** and name it, for example `work`.
3. Chat normally.

The footer shows the active profile. Memory follows the profile across directories and Pi sessions. New sessions show the profile picker with the last-used profile first; resumed sessions restore their profile.

For headless use, pass `--optchat-profile work`.

## Commands

| Command | Action |
| --- | --- |
| `/optchat` | Status and actions menu. |
| `/optchat profile` | Select or create a profile. Switching starts a fresh Pi session. |
| `/optchat model` | Compactor model and effort for this profile. |
| `/optchat agents` | Live agent tree and saved run history. |
| `/optchat agents model` | Subagent model and effort for this profile. |
| `/optchat usage` | Token usage and cost estimates. |
| `/optchat instructions` | Edit this profile's `AGENTS.md`. |
| `/optchat browse` | Open an HTML snapshot of memory: current view, every tree level, original messages. Run again to refresh. |
| `/optchat import` | Import history, or resume/discard a paused import. |
| `/complete` | In a connected window: end the conversation and hand off to the main agent. |
| `/tell-main <message>` | In a connected window: message the main agent. |

## Models

| Role | Default | Change with |
| --- | --- | --- |
| Main agent | Whatever is selected in Pi | `/model` |
| Subagents | Anthropic Opus 5.5, high | `/optchat agents model` |
| Compactor (summaries, imports, handoffs) | Anthropic Sonnet 5.5, medium | `/optchat model` |

Subagent and compactor settings are saved per profile and do not follow the main model. If you use other providers, change them before chatting. Authentication uses Pi's existing provider login.

Compression and subagents make extra model requests with your provider credentials.

## Subagents

Ask in plain words, for example: "Spawn an agent to investigate this repository and report back."

- Children get the profile's memory view (frozen at launch), its instructions, read-only `zoom`/`date`, and normal coding tools plus your installed extensions.
- Each child reports back on its own when it finishes. The parent stays alive to receive reports; it never polls.
- The parent can send a running child guidance with `tell`.
- Delegation goes up to three levels below the main agent (child, grandchild, great-grandchild).
- At most 8 agents can be active per profile, including parents waiting on descendants. Going over a limit returns an error; there is no queue.
- Stopping an agent stops its whole subtree. A failed parent stops its descendants.
- Agents run inside the Pi process. Closing Pi stops them; there is no detached mode.

## Agents and usage inspector

An **Agents | Usage** bar sits below the input.

| Key | Action |
| --- | --- |
| **Down** (empty input) | Focus the bar |
| **Left/Right**, **Enter** | Pick and open a section |
| **Escape**, **Up**, or typing | Back to the editor |
| **F6** | Open Agents directly, keeping your draft |
| **Tab** | Switch between Agents and Usage |

Set a different shortcut with `OPTCHAT_INSPECT_KEY=ctrl+shift+a pi`. If another extension supplies a custom editor, OptChat leaves its Down key alone; use the shortcut or commands instead.

**Agents** lists runs as a tree with state, elapsed time, current tool, and last activity. Navigate with **Up/Down**, **Page Up/Down**, **Home/End**, open with **Enter**, and press **M** to pick the subagent model. Inside a transcript:

| Key | Action |
| --- | --- |
| **T** | Expand tool arguments and results |
| **F** | Follow live output (scrolling pauses it) |
| **S** | Send guidance |
| **X** | Stop this agent and its subtree |
| **Escape** | Back |

Guidance shows as queued until delivered, or undelivered if the child stops first. Guidance you send is also saved in main memory. Reasoning is not shown. Transcripts stay browsable after restart, and browsing them makes no model calls.

**Usage** shows this session, last hour, today, last 7 days, or all time (**Left/Right**). It breaks down main agent, subagents, compactor, and imports by model: uncached input, output, cache reads/writes, and estimated cost.

- Costs are API-rate estimates, not your subscription bill. Unknown rates show zero.
- Record counts are not request counts; retries and tool overhead can add records.
- Main-agent tracking starts with v0.3.0 (resumed sessions are backfilled). Older records without a parent session are left out of **This session**.
- All views are limited to the active profile.

## Import history

Pick the destination profile, then run `/optchat import`.

1. **Source**: Claude Code (`~/.claude/projects`), Codex (`~/.codex/sessions`, `~/.codex/archived_sessions`), or a ChatGPT export (ZIP, folder, or `conversations.json`; ZIP needs `unzip`). Scanning is local and makes no model calls.
2. **Select**: for Claude Code and Codex, pick projects (busiest first), optionally filter by start date, then take all conversations or pick some. **Space** toggles, **Enter** continues, type to filter, **Ctrl+A**/**Ctrl+D** select/clear matches, **Esc** cancels. Nothing is classified as work or personal for you.
3. **Mode** (only if the profile already has history):
   - **Append**: keep existing summaries and add the import. Faster and cheaper.
   - **Rebuild by conversation start date**: regenerate the whole tree, ordered by conversation start.
4. **Preview**: destination, new and duplicate counts, text size, rough token estimate, and compactor. This is not a price quote.

**What gets imported**: user messages and final assistant replies, with original dates and source labels, as in Victor's recipe. Tool calls and results, intermediate commentary, reasoning, subagent transcripts, replayed context, and image/audio/file bytes are left out. ChatGPT alternate branches are labelled as alternatives. Imported records are marked as historical so old requests are not treated as new instructions.

**Duplicates**: re-importing skips messages already present, even if titles or paths changed. Changed source messages can appear as a separate historical version.

**Pausing**: **Pause import** (or Escape) saves progress, and so does restarting Pi. `/optchat import` then offers **Resume** or **Discard staged import**. While an import is pending, chat in that profile is blocked; other profiles still work. Imports need the main agent and its subagents to be idle.

**Safety**: imports build a new memory generation and switch to it only when the whole tree is ready. The previous generation stays on disk. Source files are never modified.

Damaged or unsupported records are listed before you start, so you can cancel or continue without them. Conversations that disappear during the scan are skipped with a warning.

See OpenAI's guides on [exporting ChatGPT data](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data) and the [conversation file format](https://help.openai.com/en/articles/9106926-transfer-exported-conversations-between-chatgpt-accounts).

## Connected windows

Each profile is locked to one Pi process. If you open the same profile in a second terminal, Pi offers to connect it to the original window as a subagent.

- Your first message starts a subagent in the second window's working directory. Later messages continue the same conversation.
- The subagent runs inside the original process, which stays the only writer of memory. It appears in the original window's inspector and uses one of the 8 agent slots. While it is open, the original window can't switch profile or import.
- The main agent is told when the conversation starts. Use `/tell-main <message>` to message it yourself; the subagent has a `tell_main` tool, and the main agent replies with `tell`. Routine turns don't wake the main agent.
- Run `/complete` when done. The window closes, remaining work stops, and the compactor writes a handoff for the main agent: decisions, changes, evidence, failures, unfinished work, and links to the transcripts.
- Closing or force-quitting the window also produces a handoff, marked **interrupted**.
- If the original window is closed cleanly, handoffs are delivered on next start. If it is killed, reopening the profile recovers unfinished handoffs (work is not restarted).
- Text only. For images, give the agent a file path.
- The connection is a local socket restricted to your OS user. No daemon or server.

Handoff limits: the whole transcript is summarized in one call if it fits in about 128,000 input tokens (estimated at 4 bytes per token; less on smaller models), otherwise in chunks. Output is up to 16,000 tokens, with a 5-minute timeout per call. If summarizing fails, a labelled fallback still reports the task, last result, and transcript locations.

## Storage

Profile data lives in `~/.optchat/profiles/<name>/` (override the root with `OPTCHAT_HOME`):

| Path | Contents |
| --- | --- |
| `main/` | The conversation log (dated JSONL, no reasoning) |
| `tree/` | Summary nodes |
| `active-memory.json`, `memories/<id>/` | After an import: pointer to the active `main/` and `tree/`. Older generations are kept. |
| `imports/pending.json` | Resumable import state |
| `AGENTS.md` | Profile instructions |
| `config.json` | Compactor and subagent models |
| `pending-inputs.json`, `pending-reports.json` | Recovery journals |
| `runs/` | Subagent sessions and run metadata |
| `usage.jsonl` | Usage ledger |
| `memory.html` | Snapshot from `/optchat browse` |

Each profile folder is a local Git repository, committed after each turn and on clean shutdown (memory and config; not runs, HTML, or usage). It has no remote, so it is not a backup. To back up, copy the folder while Pi is closed.

To delete a profile, delete its folder. Your original Pi sessions are kept in Pi's normal session directory.

## Good to know

- **Profiles separate memory and instructions only.** Agents keep full filesystem access and share provider credentials.
- **Use worktrees** when parallel agents edit the same repository; they share the filesystem.
- **Instructions**: only the profile's `AGENTS.md` is injected. Repository and global Pi `AGENTS.md` files are not; ask the agent to read them when needed. Skills and prompt templates still work in the main session.
- **Images** are available during the current run but stored in memory as text placeholders.
- **Pi's auto-compaction is off.** A single very long run can still hit the model's context limit; stop it and continue in a new turn.
- **Restarts**: unsent inputs are recovered into memory, and pending subagent reports are delivered. Interrupted subagents are not restarted.
- **Skill and template inputs** can occasionally be recovered as an unanswered input after a crash, because Pi expands them after the input journal records them. Plain text chat is unaffected.

## How it differs from the recipe

The recipe's four prompts are kept verbatim in `src/prompts.ts`, along with its numbers: 512-byte summary nodes, a 128,000-byte memory view, binary merges, 8 compression workers, fixed retry delays, 5 shortening attempts, and a 30,000-character tool output cap. Anthropic requests get stable cache breakpoints on the view. See `docs/victor-recipe.md` for notes.

Each run's context is the memory view, the previous exchange, and your new message. Deliberate additions:

1. **Previous exchange kept verbatim.** Your last request (with any steering) and the final answer are included in full, so "why is that?" refers to what you actually read. Tool calls and reasoning are not carried over. It comes on top of the 128,000-byte view and is not truncated. A new Pi session starts with the memory view only.
2. **Subagents** are built in with Pi's SDK rather than a separate package. Children report individually instead of per batch, and can delegate two extra levels.
3. **Profiles**, the **inspector**, the **usage ledger**, **import**, and **connected windows** are additions. Import adds historical-record guidance to the prompts.
4. **Not done**: computer use and hosting on an always-on machine.

## Development

```sh
git clone https://github.com/jonaslsaa/pi-optchat.git
cd pi-optchat
npm ci --ignore-scripts
pi install .
```

Restart Pi after source changes. Use `OPTCHAT_HOME` to test against a throwaway data directory.

```sh
npm run check      # type check
npm test           # offline tests, no paid model calls
npm run test:live  # paid Anthropic calls on synthetic data in a disposable profile
```

### Publishing to npm

Pi's [package directory](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) lists npm packages with the `pi-package` keyword, which the manifest already has. GitHub alone is not enough.

```sh
npm ci --ignore-scripts
npm run check && npm test
npm pack --dry-run
npm publish --access public
```

## Credits and license

Based on [Victor Taelin's OptChat recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) and [OptMem](https://github.com/VictorTaelin/OptMem). This is an independent Pi implementation, not Victor's official OptChat.

MIT licensed. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
