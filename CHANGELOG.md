# Changelog

## 0.1.0

Phase 8 — release preparation: MIT licence, README, `docs/model-seam.md`, `docs/prior-art.md`, safety page on writes and site terms, `src/mint/minter.ts` (interfaces only), npm `files` allowlist.

### Phase 7 — Writes, both kinds
Write tools with `mint_effect`, automatic `dryRun`, `wm.commit` marks for browser tools, `wm.fill` and `wm.handOff` for page tools (the user presses Save), `committed` / `possibleCommit` results, no retries.

### Phase 6 — Hard-target signed-in read
`hardTarget` and `minIntervalSec`, visible-tab requirement, challenge detection that stops a run, live-run budget.

### Phase 5 — Mint page tools
`page_tabs`, `page_snapshot`, `page_explore`, `page_capture`; 15-minute explore window; per-version approval bound to the executed code.

### Phase 4 — Page bridge
MV3 extension and native-messaging host; per-site grant; network CSP on the user-script world.

### Phase 3 — Plugin, reviewer, guides
Claude Code plugin with `/website-mcp:mint`, a read-only reviewer subagent, and the `authoring/` guides.

### Phase 2 — Gates and fixtures
Draft, test and publish gates; fixture site; scripted-minter tests that mint with no model.

### Phase 1 — Core loop
stdio MCP server, model-free runtime and Playwright runner, CLI.
