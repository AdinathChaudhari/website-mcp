# webpage-mcp (mcpland/webpage-mcp)

Studied 2026-11-11. TypeScript, MIT, ~27 stars, last push 2026-10-14.

## What it is
A Chrome extension ("Webpage MCP Connector") plus a local MCP server. The extension exposes the
user's real, logged-in Chrome to any MCP client: navigate, read, click, type, screenshot, run JS,
capture network, history, bookmarks. Bridge: MCP stdio → authenticated local IPC → Chrome Native
Messaging → extension. Optional Streamable HTTP gateway. Also ships saved workflows, a sidepanel
agent, semantic tab search and a visual web editor.

## Why we did not use it
- Generic browser remote control with no notion of a saved, tested, model-free tool.
- Requests very broad permissions (`<all_urls>`, `debugger`, `history`, `cookies`, `userScripts`)
  over the whole browser profile, from a small project with little outside scrutiny.
- Every action is model-driven, so nothing is deterministic or free to replay.

## Ideas worth keeping
- Native Messaging + local IPC as the bridge between an MCP server and an extension.
- Reusing the real browser session is the strongest answer to sign-in and bot detection.
