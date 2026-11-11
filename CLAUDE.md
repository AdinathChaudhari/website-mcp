# website-mcp — project instructions

Turn websites into deterministic MCP tools minted by Claude Code. Current plan:
`docs/01-planning/PLAN v2.md` (supersedes `PLAN.md`). Build only on the user's explicit "go".

## Records (keep these current every session)

- **`DECISIONS.md`** (git-ignored) — every major decision: ID, date, decision, why, alternatives
  rejected, status. Append new entries; supersede old ones with a new entry, never rewrite.
- **`CONVERSATIONS.md`** (git-ignored) — chronological record of every discussion about THIS
  project, per agent: user messages verbatim, Claude and subagent turns summarised, links to
  their saved outputs. Nothing about other projects.
- **`docs/<NN-run>/RUNLOG.md`** — every multi-agent run gets a folder with RUNLOG, the verbatim
  brief/plan and agent reports.
- **`docs/research/`** — prior-art notes. Generic and publishable.

## Rules

- Never edit an existing planning/research document; write a new `… vN.md` beside it.
- Public text stays generic: no personal names, employer, account data or local paths in code,
  tests, fixtures, commits or public docs. The hard-target tool (Phase 6) never enters the repo.
- WebMCP / MCP-B is AGPL-3.0 — ideas only, never copy code. Pomerado is MIT — anything adapted
  closely carries its notice under `third-party/pomerado/`.
- Tools, drafts, captures and the bridge socket live in `~/.website-mcp/`, never in the repo.
- Commit or push only when the user asks. Repo moves to `GitHub/Public/website-mcp/` in Phase 8.
