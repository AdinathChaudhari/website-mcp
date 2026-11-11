# website-mcp

Turn any website into a tested, deterministic tool your agent can call — minted by Claude Code,
replayed with no model in the loop.

> **Status:** Phase 2 built (draft, test and publish gates on top of the Phase 1 stdio MCP server, model-free runtime and Playwright runner). Plan: [`docs/01-planning/PLAN v2.md`](docs/01-planning/PLAN%20v2.md).

## What it will do

You type `/mint <task> on <site>` in Claude Code. Claude explores the site, writes a script, tests
it, and saves it as a tool. From then on the tool runs instantly and for free — no AI — either:

- **Browser tools** — in a background Playwright browser (public sites, unattended runs), or
- **Page tools** — inside a tab of your own signed-in browser, via a small extension (signed-in
  sites; you approve each site and each tool version).

## Draft, test, publish

Minting goes through a draft folder (`<home>/drafts/<name>/`), never straight into `tools/`:

1. `save_tool` writes the draft `tool.json` + `tool.mjs`.
2. `save_cases` writes `tests/cases.json` (at least 3 cases; include an empty and an `invalid_input` case).
3. `test_tool` runs the cases through the normal runtime, no model.
4. `publish_tool` copies the draft to a private stage, re-checks it, and publishes only if the bar is met.

The same loop from a shell:

```
website-mcp test <name> --draft   # run a draft's cases; exits 1 below the bar
website-mcp test <name>           # run a published tool's cases
website-mcp publish <name>        # gate + publish the draft
```

Publish refuses unless: at least 3 cases, at least 70% pass, valid manifest and schemas, source parses,
`effect` is `read`, no secret-shaped literals, and no literal URL outside `site.allowedOrigins`.
The cases are run on the staged copy (a `last-run.json` on disk is never trusted; only a run the same
MCP session just made on identical files is reused). The previous version moves to `.history/<n>/`.

The off-origin URL scan is a **literal-text heuristic**: a URL assembled from parts (`"https:" + "//host"`)
is not seen by it. The runtime route guard, which blocks every request outside `site.allowedOrigins`,
is the real enforcement.

## Build phases

| # | Phase | Hours |
|---|---|---|
| 1 | Core loop on a public site | ≤3 |
| 2 | Test gate + publish gate + fixture site | 4–5 |
| 3 | Plugin + reviewer + authoring guides | 3–4 |
| 4 | Page bridge (extension + native host) | 4–5 |
| 5 | Mint page tools (explore, capture, approve) | 4–6 |
| 6 | Hard-target signed-in read (gated) | 2–3 |
| 7 | Writes, both kinds | 6–8 |
| 8 | Open-source release | 3–4 |

## Repo map

| Path | What |
|---|---|
| `docs/01-planning/` | Briefs and plans (v1, v2) and the planning run log |
| `docs/STATUS.md` | Current status and resume guide |
| `docs/research/` | Prior-art studies: Pomerado, WebMCP / MCP-B, webpage-mcp, browser options |
| `src/` | Runtime, runners, bridge, mint session, MCP server |
| `extension/` | MV3 extension for page tools |
| `plugin/` | Claude Code plugin (skill + reviewer subagent) |
| `authoring/` | Minter guidance |
| `test/` | Fixture site, sample tools, tests |
