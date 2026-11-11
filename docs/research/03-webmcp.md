# WebMCP and MCP-B (MiguelsPizza/WebMCP)

Studied 2026-11-11. Local clone at commit 1143b21 (2025-10-07). Licence **AGPL-3.0** — ideas only,
no code may enter website-mcp.

## What it is
**WebMCP** is a protocol where a website exposes its own JavaScript functions as MCP tools. It has
been accepted as a W3C deliverable (work moved to `webmachinelearning/webmcp`); Chrome runs an
origin trial (from Chrome 149, per developer.chrome.com — not verified by running code).
**MCP-B** was the reference Chrome extension; it is now closed source. This repo is a historical
snapshot.

Architecture (`MCP-B Protocol.md`): page server (in the tab) → content-script proxy → extension
hub (aggregates tools per tab/domain, routes calls, `ToolListChanged`) → native messaging host →
external MCP client.

## The userscript workaround
For sites that publish no tools, `apps/native-server/src/mcp/inject-user-mcp.ts` lets an agent
write a userscript on disk; the native host reads it and the extension registers it with Chrome's
User Scripts API (world MAIN, `document_start`). The script then registers WebMCP tools inside the
page — e.g. a Gmail userscript.

## Why not use it as-is
1. Needs the site's cooperation (native WebMCP) or the closed MCP-B extension (userscripts).
2. This repo is unmaintained; building it means the extension + native server + a chat backend
   needing an API key.
3. No mint → test → save loop: userscripts are hand-written with no proof they work.
4. AGPL would force a copyleft licence on anything derived.
5. The name "web-mcp" would be read as an implementation of this standard (naming collision).

## What website-mcp takes from it
The idea of **page tools**: run a saved script inside the user's real, signed-in browser tab via
an extension + native messaging host — no automation fingerprint, no second copy of the session.
website-mcp differs on purpose: inject on demand per call (`chrome.userScripts.execute`), default
`USER_SCRIPT` world, tools defined on disk (stable list), minimal permissions with per-site grants,
per-version approval, no automatic tab creation.
