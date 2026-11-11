# Pomerado (pomerado.ai / github.com/Pomerado/pomerado)

Studied 2026-11-11. YC-backed. Open-source core is MIT, TypeScript, ~1.6k stars, very active.
Local clone at commit c7f4c80f.

## Product
"Connect agents to any website. No API needed." Turns a natural-language task on a site into a
deterministic MCP integration. Cloud tiers: Free ($0, 100 tool calls/day, 10 new integrations/mo),
Premium ($50/mo, 1,000/day, 100/mo), Business (contact; 100k+/day, SSO-style controls, SLAs).
Cloud adds hosting, saved logins + 2FA, a managed browser fleet that handles bot protection
(residential proxies), and breakage detection with auto-repair.

## Open-source core — architecture
~88.5k lines TS in 272 files. Two phases:
1. **Minting** — a model agent (`typescript/src/mint/`, 26.8k LOC) with a workspace and a real
   Playwright Chromium explores the site, writes operation modules under `src/`, runs them live.
   Reads must pass ≥70% of 10–20 self-designed live test cases. Writes perform the action once
   for real and must reach every declared commit mark (`writePath`). 20 min active budget.
2. **Running** — the saved folder (`src/`, `pomerado.json` with input/output JSON Schemas,
   `auth-fill.json`, `deployment.json`, `mcp.mjs`) runs with no model and no key
   (`typescript/src/runtime/`, 21.3k LOC). Each integration is its own MCP server.

**Guardian** (`typescript/src/guardian/`, 7.3k LOC): a second, smaller model reviews every browser
action before it runs, every question to the owner, and the final source. Labels actions
read / write / authentication. Policy adapted from OpenAI Codex (Apache-2.0).

**Sign-in** (`typescript/src/destinations/`, 10.8k LOC): types credentials only on the site's own
origin or pre-approved auth origins, key by key at human pace; never stores them; account-lock
detection.

MCP tools while minting: `mint`, `get_job`, `provide_input`, `cancel_job` (async job model).

## Model coupling
- Built on the OpenAI Agents SDK (`@openai/agents`). Models hard-coded in
  `typescript/src/models/models.ts` (`gpt-6.1-sol` mints, `gpt-6-luna` reviews).
- `standalone/contracts.ts` has optional `minterProvider` / `guardianProvider` /
  `outcomeReviewerProvider` (`ModelProvider`) hooks, but the CLI does not expose them.
- Context compaction relies on the OpenAI Responses API's server-side compaction
  (`mint/idle-compaction.ts`, `compaction_trigger`) — the main blocker for other providers.
- Prompt-cache options are OpenAI-specific but fall back cleanly when a provider rejects them.

## Ways to run it with other models (assessed, not tried)
1. Proxy (LiteLLM) mapping its model names to Claude / Ollama — ~1 h to try; compaction breaks long builds.
2. Proper `ModelProvider` adapter via `@openai/agents-extensions` + Vercel AI SDK — ~1–2 days.
3. Claude Code as its model — not workable (`claude -p` is an agent, not a turn-by-turn model endpoint).

## What website-mcp takes from it
Mint → test → publish → model-free replay; the 70% live-test bar for reads; write commit marks
and `possibleCommit`; 16 KiB result cap with spill files; explore/act split; read vs write
authority; signed-in test-input cap; authoring guides per concern (auth, forms, pagination,
search, testing, writes). Deliberately not taken: Guardian-per-action, credential autofill/2FA,
async jobs, compaction, prompt caching, one-server-per-tool, hosted features.
