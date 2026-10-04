# Intrepidus

Team-shared OptChat for [Pi](https://github.com/earendil-works/pi).

[OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)
(Victor Taelin) is an endless chat where the AI remembers everything: every
message is kept verbatim in an append-only log, a cheap model compresses the
log into a binary tree of one-line summaries, and every turn starts fresh from
a constant-size view of that tree. Intrepidus extends it to a team: each
member keeps their own OptChat, and every member's agent can read, zoom into
and search their teammates' chats as well.

Status: fork of [pi-optchat](https://github.com/jonaslsaa/pi-optchat) with the
team layer in progress. Everything pi-optchat does (profiles, `zoom`/`date`,
background agents, memory browser, Claude Code / Codex / ChatGPT import) works
as documented in its README.

## Design

- One private git repo per team. Each member has a directory in it:
  `<handle>/main/` (the log) and `<handle>/tree/` (the summaries), in
  OptChat's exact format. The repo root holds team instructions, skills and
  prompt templates as a Pi package.
- One writer per directory. Your machine writes only `<you>/`; it pushes after
  every turn and pulls before every turn. Git never sees a content conflict.
- Readers never compress. Only the owner's compactor builds their tree;
  teammates fold the stored tree into a small view and zoom into it.
- Teammates appear after your own view, in the same format:
  `<chat who="alice">` lines of `id+n|text`. `zoom(id, n, who)`,
  `date(id, who)` and `grep(regex, who)` open and search them.

## Install

```sh
pi install git:github.com/AJSuddu15243/Intrepidus
```

Requires Pi 1.0.2+, Node.js 22.19+ and Git.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
```

## Credits and license

Built on [pi-optchat](https://github.com/jonaslsaa/pi-optchat) by Jonas Silva
(MIT) and on Victor Taelin's OptChat recipe and
[OptMem](https://github.com/VictorTaelin/OptMem). See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
