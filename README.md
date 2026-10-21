# md-select-to-claude

**Highlight text in a rendered markdown file in Chrome, right-click, and send
it to Claude Code as an exact line reference.**

If your team writes specs in markdown and reviews them rendered in the
browser, you've probably hit this: you want to tell the agent "change *this*
paragraph", with the certainty of Cursor's line selection, but without
squinting at raw markdown to find the lines. This gives you that. Select in
the pretty view, pick which Claude Code session should get it, and that
session's prompt shows

```
❯ [⧉ 4 lines selected] @spec.md#L12-15
```

Type what you want changed and press enter.

- Works with any Chrome extension that renders local `.md` files (Markdown
  Reader, Markdown Viewer, MD Viewer, ...).
- Any number of Claude Code sessions at once. Each one is a named **agent**
  (A, B, design, backend, ...) and the right-click menu lets you send a
  selection to one of them or to all of them.
- Any number of markdown files. Every selection carries its file's path.
- No accounts, no cloud, no dependencies. One Node script and one unpacked
  Chrome extension, all on `127.0.0.1`.

```
Chrome (rendered .md)             bridge (node)                 Claude Code
┌──────────────────────┐  HTTP   ┌──────────────────┐  ws   ┌──────────────┐
│ highlight → right-   │ ──────▶ │ mdclaude         │ ────▶ │ session "A"  │
│ click → Send to      │  lines  │  slot A :41418 ──┼───────┤ @a.md#L12-15 │
│ Claude Code → A / B  │ + agent │  slot B :41419 ──┼──┐    └──────────────┘
└──────────────────────┘         └──────────────────┘  │    ┌──────────────┐
                                                       └──▶ │ session "B"  │
                                                            └──────────────┘
```

## Requirements

- macOS or Linux (Windows untested)
- [Node.js](https://nodejs.org) 20 or newer
- [Claude Code](https://claude.com/claude-code) CLI (`claude` on your PATH)
- Google Chrome (or another Chromium browser) with a markdown-rendering
  extension that has **Allow access to file URLs** turned on

## Install (once, about two minutes)

**1. Get the code**

```bash
git clone https://github.com/acetennis01/md-select-to-claude.git
cd md-select-to-claude
```

**2. Put the `mdclaude` command on your PATH**

```bash
npm install -g ./bridge
```

(No packages are downloaded; this only links the script. `npm link` from
inside `bridge/` does the same.)

**3. Load the Chrome extension**

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension/` folder from this repo.
4. On the new card, click **Details** and turn on **Allow access to file
   URLs**. This is how the extension reads the raw `.md` to compute line
   numbers. (Your markdown viewer needs the same switch to render local files.)

That's it. Check it worked:

```bash
mdclaude --help
```

## Use

Go to the folder your specs live in, the one you'd run Claude Code from,
and start a session as agent A:

```bash
cd ~/code/my-project
mdclaude run A
```

This starts the bridge in the background for that folder (first time only),
creates an agent named "A", and launches Claude Code already connected as it.
A bridge starts with no agents; each one exists because you named it. Open
as many as you need, each in its own terminal:

```bash
mdclaude run B          # a second session
mdclaude run design     # names are free-form
mdclaude run            # no name: reuses an idle agent, or makes the next lettered one
```

Already have a Claude Code open? Attach it instead of starting a new one:

```bash
mdclaude start          # bridge only, nothing opens (skip if one is already up)
mdclaude add review     # name a slot for it
```

then type `/ide` in that session and pick **Markdown Viewer (review)**. Its
conversation is untouched.

Now open a spec in Chrome by dragging the `.md` file onto a tab (or
`file:///path/to/spec.md`). Highlight a passage, right-click, and choose
**Send to Claude Code → Agent A**. A toast in the page confirms what was
sent and to whom. Switch to that session, type your change, press enter.

Other things you can do:

| Action | How |
|---|---|
| Send to every connected session | right-click → **All connected agents** |
| Re-send to the agent you used last | **Alt+K** (change at `chrome://extensions/shortcuts`) |
| See which agents are connected | `mdclaude status`, or the extension's options page |
| Stop the bridge | `mdclaude stop` (refuses while sessions are connected; `--force` overrides) |
| Run the bridge in the foreground to watch its log | `mdclaude` (then `mdclaude run A` in other terminals) |
| Start the bridge in the background without opening a session | `mdclaude start` |
| Pass flags to claude | `mdclaude run A -- --resume` |
| Connect a Claude Code you already have open | `mdclaude start` if needed, then type `/ide` in that session and pick **Markdown Viewer (A)** |
| Make a slot for an open session under a new name | `mdclaude add review`, then `/ide` → **Markdown Viewer (review)** |
| Create several agents up front | `mdclaude start --agents design,backend,qa` or `--agents 4` |

Mentions stack: send two ranges, even from two different files, and both
appear in the prompt before you type.

### Working with several agents on the same files

The bridge only routes. It does not merge. Two sessions editing the same
file at the same moment can overwrite each other, so point them at different
sections, or let one finish before the other starts. Sending the same range
to **All connected agents** is great for "everyone read this", less so for
"everyone edit this".

### Agents and folders

A bridge serves one workspace folder (where you first ran `mdclaude run`),
and Claude Code only lists the bridge in `/ide` when its own cwd is inside
that folder. `mdclaude run` reuses whatever bridge is already up and warns if
it belongs to a different folder; `mdclaude stop` then `mdclaude run` in the
right folder fixes that. Keep the `.md` files you select from under the
workspace so Claude Code can read them.

## Troubleshooting

The toast in the page says what went wrong:

| Toast | Fix |
|---|---|
| Bridge not running | `mdclaude run A` (or `mdclaude`) from your project folder |
| Agent A is not connected | in that Claude Code, `/ide` → **Markdown Viewer (A)**, or launch it with `mdclaude run A` |
| Could not read the file | turn on **Allow access to file URLs** for this extension in `chrome://extensions` |
| Could not find the selected text | the page may be stale; reload it. Selections in a table of contents sidebar are ignored on purpose |
| Nothing selected | the viewer renders in a frame the extension can't see; open an issue with the viewer's name |
| (approximate match) | the range is a best guess, usually off by a wrapped line; check it before sending big edits |

No **Send to Claude Code** item in the right-click menu? It only appears on
`file://` pages when text is selected. The menu refreshes itself every 30
seconds; reloading the extension forces it.

`/ide` doesn't list the bridge? Claude Code's cwd must be inside the
bridge's workspace folder, and the bridge must be running (`mdclaude
status`). Stale lock files from a crashed bridge live in `~/.claude/ide/`
and are safe to delete.

## How it works

**Claude Code side.** Claude Code's editor integrations (VS Code, JetBrains,
Neovim) talk over a local WebSocket using JSON-RPC and an MCP handshake. The
editor advertises itself with a lock file in `~/.claude/ide/` that holds the
port, workspace folders, a display name, and a random auth token. `mdclaude`
does exactly this, once per agent, so each agent is a separate "IDE" called
`Markdown Viewer (<name>)`. Sending a selection is the `at_mentioned`
notification; mirroring the live selection is `selection_changed`. Line
numbers are 0-based on the wire and shown 1-based.

**Chrome side.** A rendered page has no record of which source line each
word came from, so the extension reads the raw `.md` itself and maps the
selection back. Both the file and the selection are reduced to lowercase
words, which strips every markdown token (`#`, `*`, backticks, link URLs,
list markers, table pipes). The first and last few words of the selection
are then located in the normalized file, and each normalized character
remembers its source line. If a phrase occurs more than once, the occurrence
whose span best fits the selection's length wins. See
[`extension/matcher.js`](extension/matcher.js) and its tests for the cases
covered: headings, soft-wrapped paragraphs, nested lists, links,
blockquotes, tables, code blocks.

**In between.** The bridge's HTTP API on `127.0.0.1:41417` is what the
extension calls: `GET /status`, `POST /mention`, `POST /selection`,
`POST /agents`. Agent slots take the ports after it.

## Development

```bash
node --test test/
```

The matcher tests run against a fixture spec. The bridge tests stand up a
real bridge and connect to it with a hand-rolled WebSocket client that does
what Claude Code does, including auth, the MCP handshake, and routing across
agents added at runtime. Verified end to end against Claude Code 2.1.306 on
macOS.

Layout:

```
bridge/bridge.js        the mdclaude command: bridge, run, stop, status
extension/manifest.json Chrome extension (MV3)
extension/background.js context menu, file reading, bridge calls
extension/content.js    selection + toasts on file:// pages
extension/matcher.js    rendered text → source lines (pure, tested)
test/                   node --test suites and a fixture spec
```

## Caveats

- The IDE protocol is reverse-engineered, not an official API. See the
  [claudecode.nvim write-up](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md).
  A Claude Code release could change it; the test suite will tell you.
- Local `file://` pages only. Markdown served over http(s) has no local path
  to mention.
- Everything binds to `127.0.0.1`. Each agent slot has its own per-run auth
  token, like the official integrations. The HTTP API has no auth, so another
  process on your machine could push a mention into your prompt, but nothing
  can read or edit files through it.
- Claude Code only, by design. Cursor has no equivalent attach protocol.

## License

MIT. See [LICENSE](LICENSE).
