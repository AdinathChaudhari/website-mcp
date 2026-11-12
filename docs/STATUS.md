# website-mcp — status and resume guide

**As of 2026-11-12: Phases 1–5 of 8 done (Phase 5 live check pending in the user's Chrome). Phase 6 next (gated).**
Plan: `docs/01-planning/PLAN v2.md` (private, git-ignored). Phases 1–2 committed (4df108d); Phase 3 uncommitted.

## Resume in 3 steps

1. `cd` into the repo and run `npm test` → expect `tests 150 / pass 150`.
2. Run `node dist/cli.js test quotes_by_tag` → expect `4/4 passed`.
3. Run `docs/runs/06-phase-5/USER-CHECKLIST.md` in Chrome, then decide Phase 6 go/no-go with the same workflow shape as Phases 1–2
   (Haiku extract → Sonnet build/prove/fix → one Opus verifier → Haiku recorder).

## What works today

| Area | Files | Notes |
|---|---|---|
| Runtime | `src/runtime/{load,run,schema,errors}.ts`, `runners/{types,playwright}.ts` | Ajv in/out validation, `kind` dispatch (only `browser`), timeout kills the browser, route guard enforces `site.allowedOrigins` |
| Snapshot / cap | `src/browser/snapshot.ts` | ARIA snapshot; results >16 KiB spill to `<home>/spill/` |
| Mint session + gates | `src/mint/{session,tests,publish}.ts` | Drafts → cases → test → publish; ≥3 cases, ≥70% on current source hash (re-run, never trusted from disk); schema, origin and secret scans; version bump + `.history/` |
| MCP server | `src/server/mcp.ts` | `open`, `snapshot`, `explore`, `save_tool` (draft), `save_cases`, `test_tool`, `publish_tool`, `list_tools`, `run_tool`, one tool per published folder, live `tools/list_changed` |
| CLI | `src/cli.ts` | `serve`, `run`, `list`, `test [--draft]`, `publish` |
| Skill | `.claude/skills/mint/SKILL.md` | Project-level `/mint` loop |
| Tests | `test/unit`, `test/browser`, `test/fixtures/{site,tools}` | 73 tests, loopback only; scripted no-model mint |
| Plugin | `.claude-plugin/marketplace.json`, `plugin/` (launch.mjs, skill, reviewer agent) | Local marketplace, loads in place; `/website-mcp:mint` |
| Page bridge | `extension/` (211 lines), `src/bridge/`, `runners/page.ts` | `bridge install/status/uninstall --browser chrome` (Brave can't find user-level hosts — D-033); host copied to `~/.website-mcp/bridge/` |
| Review gate | `src/mint/review.ts` | Publish needs an allow bound to name + source hash + cases hash |
| Guides + waits | `authoring/*.md`, `src/server/guides.ts`, `src/browser/waits.ts` | `guide(topic)`; `wm.waitForOutcome`, `wm.paginate` |
| CI | `.github/workflows/ci.yml` | Node 22, actions pinned to SHAs |

Deps (exact): playwright 1.65.0, @modelcontextprotocol/sdk 1.32.2, ajv 8.20.0; dev: typescript 7.0.2,
@types/node 26.6.6. Node 23.11 locally.

Tool home: `~/.website-mcp/` (`WEBSITE_MCP_HOME` overrides). Published: `quotes_by_tag` (v2, 4 cases, pre-review), `books_by_category` (v1, 8 cases, reviewed).

## Not done / known limits

- Exit test "type `/mint` in a real restarted Claude Code session" has only been proven through an
  MCP client acting as Claude Code, not by a human in Claude Code.
- "Network off" for `npm test` is approximated (dead proxy + URL grep), not a firewall.
- npm name `website-mcp` not reserved (publishing needs an explicit ask).
- Open questions Q-001–Q-005 (browser = Brave?, hard-target go/no-go, …) still open; needed by Phase 4/6.

## Next phases

| # | Phase | Hours |
|---|---|---|
| 5 | Mint page tools: explore, capture, test offline, approve in popup | 4–6 |
| 6 | Hard-target signed-in read (gated on go/no-go) | 2–3 |
| 7 | Writes, both kinds | 6–8 |
| 8 | Open-source release | 3–4 |

## Where the records are

- `DECISIONS.md`, `CONVERSATIONS.md` — private, git-ignored, repo root.
- `docs/runs/02-phase-1/`, `docs/runs/03-phase-2/` — RUNLOG, checklist, verbatim agent reports,
  evidence (private, git-ignored).
- `docs/research/` — prior-art notes (publishable).

## Install the plugin in your own Claude Code (not done by agents)

```
claude plugin marketplace add <path-to-this-repo>
claude plugin install website-mcp@website-mcp
```
Then in any folder: `/website-mcp:mint <task> on <site>`. Requires `npm run build` in the repo first.
