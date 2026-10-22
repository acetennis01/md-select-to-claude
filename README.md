# md-select-to-claude

Highlight text in a **rendered** markdown file in Chrome and it becomes
context in your Claude Code session, as an exact line reference. Right-click
to pin it to a specific session:

```
❯ [⧉ 4 lines selected] @spec.md#L12-15
```

Then type what you want changed. No raw markdown, no copying line numbers.

- Works with any Chrome extension that renders local `.md` files (Markdown
  Reader, Markdown Viewer, ...).
- Any number of Claude Code sessions, each a named **agent**. Pick which one
  gets a selection, or send to all.
- Any number of files. Each selection carries its file's path.
- Highlighting alone shows up as live selection context in every session,
  like Cursor; right-click pins an explicit mention to one agent.
- Local only. One Node script, one unpacked Chrome extension, no dependencies.

```
Chrome: highlight → right-click → agent      mdclaude bridge       Claude Code sessions
          │                                  (one process,    ┌──▶ "Markdown Viewer (enrich)"
          └── file path + line range ───────▶ one port per ───┤
                                              agent)          └──▶ "Markdown Viewer (outreach)"
```

## Requirements

- macOS or Linux, Node.js 20+
- [Claude Code](https://claude.com/claude-code) CLI on your PATH
- Chrome with a markdown-rendering extension that has **Allow access to file
  URLs** turned on

## Install (once)

```bash
git clone https://github.com/acetennis01/md-select-to-claude.git
cd md-select-to-claude
npm install -g ./bridge        # puts `mdclaude` on your PATH; downloads nothing
```

In Chrome: `chrome://extensions` → **Developer mode** on → **Load unpacked** →
choose the `extension/` folder → **Details** → **Allow access to file URLs** on.
(A Chrome Web Store listing is in progress; once live, installing from there
replaces the Load-unpacked step, but **Allow access to file URLs** still has
to be switched on by hand.)

## Use

**1. Start the bridge for the folder your Claude Code sessions run from.**
A parent folder works for everything beneath it; the repo root is usually right.

```bash
mdclaude start ~/code/my-project
```

It starts with no agents.

**2. Give each session an agent name.**

Session you already have open:

```bash
mdclaude add enrich
```

then type `/ide` in that session and pick **Markdown Viewer (enrich)**. Its
conversation is untouched.

New session:

```bash
mdclaude run outreach
```

opens Claude Code already connected as `outreach`. (If no bridge is up, `run`
starts one for the current folder.)

**3. Send selections.** Open a `.md` in Chrome (drag the file onto a tab).
Highlight, right-click → **Send to Claude Code** → the agent. A toast confirms
`Sent spec.md#L12-15 to agent enrich`; switch to that session, type the change,
press enter.

**Highlighting alone is also context, like in Cursor.** Whatever you have
selected shows up in every connected session as `⧉ N lines selected` and is
used as context for the next message, so for a quick edit you can just
highlight, switch to a session, and type. Right-click → agent is the explicit
version: it pins `@spec.md#L12-15` into one agent's prompt, survives further
highlighting, and stacks with other mentions.

Two agents on two docs in the same folder is the normal case: open both docs
in tabs and pick the agent per right-click. Avoid two agents editing the same
file at the same moment; the bridge routes, it doesn't merge.

## Commands

| | |
|---|---|
| `mdclaude start [folder]` | bridge in the background, no agents yet |
| `mdclaude add <name>` | create an agent; then `/ide` in an open session |
| `mdclaude run [name] [-- claude args]` | new Claude Code connected as that agent; creates it if needed; no name = idle agent or next letter |
| `mdclaude status` | agents and who's connected |
| `mdclaude stop <name>` | remove just that agent (disconnects its session); others keep running |
| `mdclaude stop [--force]` | stop the whole bridge; refuses while sessions are connected unless forced |
| `mdclaude start --agents a,b` | create several agents up front (`--agents 3` for lettered ones) |
| `mdclaude [folder]` | same as `start` but in the foreground, to watch the log |
| `--port N` on any command | use another API port (default 41417; agents take the ports after it); set the matching URL in the extension's options page |
| right-click → **All connected agents** | same range to every session |
| **Alt+K** | re-send to the agent you used last (change at `chrome://extensions/shortcuts`) |

Agent names: letters, digits, `-`, `_`; case-insensitive; `all` is reserved.
Mentions stack: send several ranges, even from different files, before typing.
The right-click menu refreshes from the bridge every 30 seconds.

## Troubleshooting

| Toast / symptom | Fix |
|---|---|
| Nothing happens, no toast | the extension was reloaded while the tab was open; the extension re-injects itself on the next right-click, or reload the tab. Check `chrome://extensions` → the card's **Errors** button |
| Bridge not running | `mdclaude start <folder>` |
| Agent X is not connected | `/ide` in that session → **Markdown Viewer (X)** |
| Could not read the file | **Allow access to file URLs** for this extension in `chrome://extensions` |
| Could not find the selected text | reload the page; selections in a table-of-contents sidebar are ignored |
| (approximate match) | best-guess range, usually off by a wrapped line; check it |
| `/ide` doesn't list the bridge | the session's cwd must be inside the bridge's folder (`mdclaude status` shows it); `mdclaude stop` then `start` the right folder |
| Session lost its connection | `/ide` again in that session; nothing else to redo |

Stale lock files from a crashed bridge live in `~/.claude/ide/` and are safe
to delete. Bridge log: `~/.mdclaude/bridge.log`.

## How it works

Claude Code's editor integrations connect over a local WebSocket using
JSON-RPC and an MCP handshake, discovering editors through lock files in
`~/.claude/ide/` (port, folder, name, auth token). `mdclaude` writes one
such lock file per agent, so each agent is a separate "IDE" to Claude Code.
A selection becomes an `at_mentioned` notification; the live selection is
mirrored with `selection_changed`.

The rendered page has no source map, so the extension reads the raw `.md`
itself and maps the selection back: both are reduced to lowercase words
(dropping all markdown syntax), the selection's first and last words are
located, and each normalized character remembers its source line. Repeated
phrases resolve to the occurrence whose span best fits the selection. See
`extension/matcher.js` and `test/matcher.test.js`.

The bridge's HTTP API (`127.0.0.1:41417`: `/status`, `/mention`, `/selection`,
`/agents`) is what the extension calls; agent ports follow it.

## Development

```bash
node --test test/
```

Matcher tests run against a fixture spec; bridge tests connect a hand-rolled
WebSocket client that behaves like Claude Code (auth, MCP handshake, routing,
runtime-added agents). Verified against Claude Code 2.1.306 on macOS.

Store release: `tools/package-extension.sh` builds the upload zip,
`tools/store-listing.md` has the listing text and permission justifications,
`tools/make-icons.mjs` regenerates the icons, [PRIVACY.md](PRIVACY.md) is the
policy the store links to.

## Caveats

- The IDE protocol is reverse-engineered ([write-up](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md)),
  not an official API. A Claude Code release could change it.
- `file://` pages only. Claude Code only: Cursor and Codex have no attach
  protocol; Gemini CLI has a similar one and could be added.
- Everything binds to `127.0.0.1`. Agent slots have per-run auth tokens; the
  HTTP API has none, so a local process could push a mention into a prompt,
  but nothing can read or edit files through it.

MIT, see [LICENSE](LICENSE).
