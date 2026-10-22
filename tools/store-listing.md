# Chrome Web Store listing

Paste these into the developer dashboard. Screenshots must be 1280×800 or
640×400 PNG/JPEG; a short screen recording of highlight → right-click →
prompt makes the best one.

## Name

Send Markdown Selection to Claude Code

## Summary (132 chars max)

Highlight text in a rendered markdown file and send it to Claude Code as an exact line reference, like Cursor's selection.

## Description

Review specs rendered in your browser and still point Claude Code at the
exact lines you mean.

Highlight text in any rendered markdown file (works with Markdown Reader,
Markdown Viewer and similar extensions) and it appears in your Claude Code
sessions as live selection context, like in Cursor. Right-click → Send to
Claude Code → pick a session, and that session's prompt gets an exact
@file#L12-15 mention. Type what you want changed.

• Any number of Claude Code sessions, each a named agent; send to one or all
• Any number of markdown files
• Mentions stack, so you can reference several ranges in one instruction
• Everything stays on your machine: the extension talks only to a small
  bridge on 127.0.0.1

Requires the free companion bridge, "mdclaude", from
https://github.com/acetennis01/md-select-to-claude (Node.js 20+), and the
Claude Code CLI. After installing, enable "Allow access to file URLs" for
this extension so it can read local markdown files.

## Category

Developer Tools

## Single purpose (for the review form)

Send the user's selection in a local rendered markdown file to the user's
own Claude Code sessions on the same machine, as a file and line reference.

## Permission justifications

- file:///* host permission: read the local markdown file being viewed to map
  the rendered selection back to source line numbers.
- http://127.0.0.1/* and http://localhost/*: reach the local bridge that
  relays selections to Claude Code.
- contextMenus: the "Send to Claude Code" right-click menu.
- storage: remember the bridge URL and the last-used agent.
- alarms: refresh the agent list in the menu every 30 seconds.
- scripting: re-inject the content script into tabs opened before an
  extension update, so the menu keeps working without a page reload.

Remote code: none. Data use: no user data collected or transmitted off the
device.

## Privacy policy URL

https://github.com/acetennis01/md-select-to-claude/blob/main/PRIVACY.md
