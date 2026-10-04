# Team layer: design contract

Build order and settled decisions for turning pi-optchat into a team-shared
OptChat. An agent should be able to implement any PR below from this file
alone. Once all PRs ship, fold "Layout" and "Invariants" into the README and
delete the rest of this file.

Read first: `README.md`, `src/memory.ts`, `src/tools.ts`, `src/transcript.ts`,
`src/cache.ts`, `src/checkpoint.ts`, `src/index.ts`, and the OptChat recipe
(`docs/victor-recipe.md`). Everything not mentioned here stays as upstream.

## Layout

```
~/.optchat/
  profiles/<name>/          personal profiles, unchanged
  teams/<team>/             git clone of the team's PRIVATE repo
    .git/config             intrepidus.handle = <me>   (local, never committed)
    .gitignore              */runs/  */memory.html  */usage.jsonl  */pending-*.json  */imports/
    AGENTS.md               team instructions, appended after the member's own
    package.json            Pi package: { "pi": { "skills": ["./skills"], "prompts": ["./prompts"] } }
    skills/  prompts/       shared Pi skills and prompt templates
    <me>/                   a profile dir exactly as in profiles/: main/ tree/ AGENTS.md config.json ...
    <alice>/                a teammate's profile dir, read-only on this machine
```

Profile name for a team member is `<team>/<me>`. `profilePath` maps it to
`teams/<team>/<me>`; `listProfiles` adds `teams/*/<handle>` for every team
whose `.git/config` names a handle. Handles and team names match the existing
profile regex. One handle per machine (two writers to one log break
position-is-identity and create git conflicts).

A member's live memory is `memoryDirectory(<team>/<who>)` (follows
`active-memory.json` after an import), same as for self.

## Invariants

1. A member directory is written only by its owner's machine. No code path
   writes under `teams/<team>/<other>/`: no `mkdir`, no torn-line repair, no
   tree nodes.
2. Readers never compress. Only the owner's compactor builds the owner's tree.
   A teammate's unbuilt node renders as upstream's placeholder.
3. The four recipe prompt constants in `src/prompts.ts` are unchanged. New
   prompt text lives in new constants.
4. Everything in the system prompt and tool list is byte-identical across turns
   of a session. The team roster is in the user message, never in the prompt.
5. The member's own view stays the first text block of the first user message,
   starting `<chat>\n`, so `cache.ts` splits and marks it exactly as today. The
   team block is a separate text block after it and gets no cache marks.
6. Git never blocks a turn. Sync failures are one notice per session, exit
   normally; the local write already happened.
7. Diffs stay upstream-shaped: extend `memoryTools`, `buildContext`,
   `checkpoint`, `profilePath`; do not fork copies of them.

## PR 1: read teammates (no git yet)

Works on any directory layout: tests use two profile dirs under a temp
`teams/x/`.

### `Memory` read-only mode (`src/memory.ts`)

Add a trailing constructor parameter `readOnly = false`. When true: skip the
`mkdirSync` calls, skip the torn-line `\n` repair in `records()` (pass a flag),
never call `schedule()`, and `append` throws `Memory is read-only.`. Folding
(`fit`), `render`, `zoom`, `date`, `node`, `view` work unchanged. No other
behavior changes for `readOnly = false`.

### `Team` (`src/team.ts`, new)

```ts
export const TEAM_BYTES = 32_000;           // total budget for all teammates' views
export class Team {
  constructor(root: string, me: string, budget = TEAM_BYTES, warn?: (s: string) => void)
  readonly members: Map<string, Memory>;    // handle -> read-only Memory, excluding me, only dirs with >= 1 message
  reload(): void;                           // rebuild members from disk (cheap: fold is milliseconds)
  render(): string;                         // '' when no members, else blocks joined by '\n'
  memory(who: string): Memory;              // throws `No teammate ${who}.`
  grep(regex: string, who?: string): string;
}
```

- Member discovery: every subdirectory of `root` except `me` whose
  `memoryDirectory()` has a `main/` with at least one record. Sorted by handle.
- Each member's `Memory` is constructed read-only with budget
  `max(4_000, floor(budget / members))`.
- `render()` emits, per member in order:
  ```
  <chat who="alice">
  0+512|...
  ...
  </chat>
  ```
  Same line format as `Memory.render()`; the only difference is the opening
  tag. Unbuilt parts render upstream's placeholder.
- `grep(regex, who?)`: JS `RegExp(regex, 'i')`; invalid regex throws its
  message. `who` omitted searches all members and self (self is passed in or
  looked up by the caller; see tools). Hits, newest first, tree lines before
  raw messages:
  ```
  @alice 4816+16|<node text, newlines flattened, cut to 200 chars>
  @alice 4824+0|talk: <first 200 chars of the message> (2310 bytes)
  ```
  Only lines of nodes currently in that member's view are searched at the tree
  level (not every stored node), then every raw message. Output is cut at
  `GREP_BYTES = 4_000` on a line boundary and ends with
  `N more hits; narrow the regex.` when cut. No hits: `No match.`

### Tools (`src/tools.ts`)

`memoryTools(memory: () => Memory, team?: () => Team)`:

- `zoom(id, n, who?)` and `date(id, who?)`: `who` is `Type.Optional(Type.String())`.
  Omitted = self (`memory()`); given = `team().memory(who)`. Descriptions,
  constant:
  - zoom: `Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole. who = a teammate's handle to open their chat; omit for your own.`
  - date: `The date and time of message id. who = a teammate's handle; omit for your own.`
- `grep(regex, who?)`, only when `team` is given:
  `Search the one-line summaries and the full messages of every chat for a regex (case-insensitive). who = one teammate's handle; omit to search everyone including yourself. Hits show id+n lines you can zoom.`

Both `src/index.ts` and `src/agents.ts` call `memoryTools` today; pass the team
accessor in both so subagents get the same tools.

### Context (`src/transcript.ts`, `src/index.ts`)

`buildContext(canonical, run, view, prompt, team = '')`: when `team` is
non-empty, the first user message's content becomes
`[{text: view}, {text: team}, ...original]`. In `index.ts`, where `view` is
captured after `settle()`, also capture `teamView = active.team.render()`
(after `team.reload()`), and pass it. Both are captured once per turn.

### Prompt (`src/prompts.ts`, new constant `TEAM_DOC`)

Appended to the system prompt after `VIEW_DOC` for the main agent and for
subagents, only when the profile is a team member (constant for the session):

```
Your teammates' chats follow your view, each inside <chat who="handle"> tags,
in the same one-line format but with a smaller budget, so their lines are
coarser. Each teammate has their own OptChat; you only read theirs. zoom(id, n,
who) and date(id, who) open a teammate's lines exactly as yours; grep(regex,
who) searches summaries and messages across everyone. Before deciding,
designing, reworking or asking about anything a teammate may already have
settled, look there first. A teammate's line may show "(not summarized yet)":
zoom to its messages instead.
```

### Tests (`test/team.test.ts`, node:test like upstream)

Fixtures: `tmp/teams/x/{me,alice,bob}` built by writing `main/*.jsonl` and
`tree/*.jsonl` records directly (helper), no model calls.

1. `Team.render()` lists alice and bob in order, each block starts
   `<chat who="alice">\n` and ends `\n</chat>`; me is absent; a member dir with
   no messages is absent.
2. Budget: with `TEAM_BYTES = 2_000` and two members, each view is ≤ 1_000
   bytes or over only because no parent is built (same rule as `fit`).
3. Read-only: constructing a member `Memory` over a dir containing a `main`
   file without trailing `\n` leaves the file byte-identical; no `tree/` dir is
   created in a member dir that lacks one; `append` throws.
4. `zoom(id, n, 'alice')` returns alice's two child lines; `zoom(id, 1,
   'alice')` returns her message whole; unknown `who` → `No teammate carol.`
5. `grep` finds a word only in alice's tree line and a word only in bob's raw
   message, prefixes `@alice` / `@bob`, cuts raw text at 200 chars with the
   byte count, caps output at 4_000 bytes with the trailing count line.
6. `buildContext` with a team string yields content `[view, team, text]`;
   with `''` it is unchanged from upstream (`[view, text]`).
7. `cachePayload` on a payload whose first user message is `[view, team,
   text]` splits only the view block, leaves the team block unmarked, and the
   total number of `cache_control` marks is unchanged from a `[view, text]`
   payload.

## PR 2: join and sync (git)

### `profiles.ts`

- `profilePath(name)`: `a/b` → `teams/a/b`; `a` → `profiles/a`. Validate each
  segment with the existing regex.
- `listProfiles()`: existing list plus, for each `teams/*` with a handle in
  `git config --get intrepidus.handle`, `<team>/<handle>`.
- `teamOf(dir)`: `{ root, me }` when `dir` is directly under `teams/<team>/`
  and `root/.git` exists, else `undefined`.

### `/optchat team join <url> [handle]` (`src/index.ts`)

1. `handle` defaults to `$USER` lowercased; validate.
2. Team name = repo basename without `.git`. Refuse if `teams/<team>` exists.
3. `git clone -q <url> teams/<team>`; `git -C … config intrepidus.handle <handle>`.
4. If the clone has no `package.json`: write the template files from Layout
   (`.gitignore`, `AGENTS.md` with a one-line header, `package.json`,
   `skills/.gitkeep`, `prompts/.gitkeep`), commit `Initialize team`, push.
5. If `<handle>/` exists in the clone: error `Handle taken: <handle>` and leave
   the clone in place with no handle configured.
6. `createProfile`-equivalent inside `teams/<team>/<handle>`, then `sync()`.
7. If `gh` is on PATH, `gh repo view <url> --json isPrivate`; when it answers
   `false`, abort before step 3 with `Team repo must be private.` When `gh` is
   absent or fails, print a one-line warning and continue.
8. Print: `Joined <team> as <handle>. Install the team's skills with: pi install <path>`.
   Then `/optchat profile` can select `<team>/<handle>`.

### `sync()` (`src/checkpoint.ts`)

`checkpoint(dir)` gains a branch: if `teamOf(dir)` is defined, run

```
git -C root add -A -- <me>
git -C root diff --cached --quiet || git -C root commit -q -m "<me>: memory"   (same -c user.* flags as upstream)
git -C root pull --rebase -q
git -C root push -q
```

with a 20 s timeout on the two network steps. Any failure: one
`ctx.ui.notify('Intrepidus: offline, will sync later', 'info')` per session
(flag in `index.ts`), return normally. Also run `git pull --rebase -q` once at
`openProfile` and call `team.reload()` after every successful pull. The
existing local-only behavior is untouched for `profiles/*`.

Why no pull before every turn: it would put the network on the critical path of
each message. Pulling at open and after every own turn makes teammates' pushes
visible by the next turn, which is enough.

### Team instructions

In both prompt assemblies (`index.ts`, `agents.ts`), when `teamOf(dir)` is
defined and `root/AGENTS.md` exists, append its text after the member's own
`instructions(dir)`. Constant within a session.

### Tests (`test/sync.test.ts`)

`bare = tmp/remote.git` (`git init --bare`), `OPTCHAT_HOME=tmp/a` and
`tmp/b` as two machines.

1. a joins as `alice`, b joins as `bob` (same url) → both clones hold
   `alice/` and `bob/` after b's join and a's next sync; template files exist
   once; `package.json` parses.
2. Both append one message without pulling, both `checkpoint` → second one
   rebases and pushes; both logs intact; `git -C … log --oneline` on the bare
   repo has 2 memory commits plus the init commits.
3. Remote unreachable (point `origin` at a nonexistent path) → `checkpoint`
   returns without throwing; the local commit exists; a later `checkpoint` with
   the remote restored pushes it.
4. b's `Team.render()` after pull shows `<chat who="alice">` with alice's
   lines; `alice/` under b has no `tree/` writes from b.
5. Join with an existing handle on the remote → error `Handle taken: alice`,
   no `.git/config` handle set.
6. `profilePath('x/alice')` → `teams/x/alice`; `profilePath('x/al ice')`
   throws; `listProfiles()` includes `x/alice` only when the handle is
   configured.

## PR 3: research team package (content, not harness)

Skills and prompt templates for research work (paper search, PDF reading,
citation handling, experiment logs), plus a documented `mcp.json` the team
installs with `pi mcp add`. Scope it after PR 2 lands and a real team has used
it for a week.

## Deferred

- A cache breakpoint on the team block: Anthropic allows four and upstream
  uses all (three view marks plus the request end). Measure the team block's
  per-turn cost first; if it matters, drop the 80k view mark for a team mark.
- Pull before every turn, or a background `git fetch` loop.
- Redaction of secrets in tool results before they reach the team repo. The
  repo is private and only team code should be in it; revisit if a team mixes
  personal and team work in one profile.
- Multiple machines per handle.
- Semantic search over tree lines.
