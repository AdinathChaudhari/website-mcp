# Model seam

Claude Code is the minter today, but nothing below the minting loop depends on it. This page says where the seam is and what a replacement (a local model, or the Anthropic API) would have to do.

## What is model-free

Saved tools run with no model: the runtime, both runners (Playwright and the page-eval runner), the tool folder format, both gates (test and publish), the extension, the native host and the authoring text import nothing provider-specific. The scripted-minter tests (`test/browser/scripted-minter.test.mjs`) mint a browser tool and a page tool with canned code and no model, which is the proof.

## The interfaces

`src/mint/minter.ts` holds interfaces only:

- `ChatModel.complete({ system, messages, tools })` returns `{ text, toolCalls }`. One turn of any chat-style model.
- `Reviewer.review(bundle)` returns `{ verdict, findings }`. A second reader of a draft. The verdict is stored against the source hash it saw, so a later edit makes it stale.

## What a replacement minter does

A replacement is a loop outside this package, for example a future `website-mcp mint --provider <name>`:

1. Load the guides (`authoring/*.md`, served by the `guide` tool, source in `src/server/guides.ts`) into the system prompt.
2. Offer the `MintSession` methods as tools, using the same names and JSON Schemas the MCP server already publishes: `open`, `snapshot`, `explore`, `mint_effect`, `act`, `save_tool`, `save_cases`, `test_tool`, `publish_tool`, plus the page methods `page_tabs`, `page_snapshot`, `page_explore`, `page_capture`.
3. Feed each `toolCalls` entry to the matching method and return the result as a `tool` message.
4. Stop at `publish_tool`, which applies the same gate as today.

The gates do not trust the minter, whichever model it is. The publish gate re-runs the cases on a staged copy, and page tools still need the user's per-site grant and per-version approval in the extension popup. A weaker model gets the same checks, not looser ones.

## Not built

The loop above is not in this repo. The reviewer today is a read-only Claude Code subagent (`plugin/agents`). A provider-backed reviewer would implement `Reviewer` and call `submit_review`.
