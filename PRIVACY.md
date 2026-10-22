# Privacy policy: Send Markdown Selection to Claude Code

Last updated: 2026-10-22

This extension runs entirely on your computer. It has no server, no
analytics, and no accounts.

**What it reads.** When you select text on a local `file://` markdown page,
or use the extension's context menu or shortcut, it reads the selected text
and the contents of that local file. It reads the file only to work out
which source lines your selection corresponds to.

**Where data goes.** The file path, the line range, and the selected text are
sent over plain HTTP to a bridge program (`mdclaude`) listening on
`127.0.0.1` on your own machine, which forwards them to Claude Code sessions
running on the same machine. Nothing is sent to any remote host by this
extension. What Claude Code then does with that context is governed by
Anthropic's terms, not by this extension.

**What it stores.** The bridge URL you set on the options page (synced with
your Chrome profile) and the name of the agent you last sent to (local to
this browser). No page content is stored.

**Permissions.** `file:///*` host access and "Allow access to file URLs" let
it work on local markdown files; `127.0.0.1` / `localhost` host access lets
it reach the bridge; `contextMenus`, `storage`, `alarms` and `scripting`
provide the right-click menu, settings, the periodic menu refresh, and
re-injecting its own content script after an extension update.

**Contact.** Open an issue at
https://github.com/acetennis01/md-select-to-claude.
