# Publication: the gates, the review, and what ships

A draft becomes a tool only through `publish_tool`. Know what it checks so you can fix a refusal in one pass.

## The order

1. `save_tool` (draft), `save_cases` (at least 3), `test_tool` until it passes.
2. Review: hand the draft to the **website-mcp-reviewer** subagent. Give it the draft folder path and the
   `sourceHash` from `save_tool`. It reads the files and returns a verdict (`allow` or `deny`), findings, and the
   hash it reviewed.
3. `submit_review` with exactly what it returned. This writes `drafts/<name>/review.json`.
4. `publish_tool`.

Any edit to `tool.mjs` or `tool.json` after the review changes the hash and makes the review stale: publish
refuses and says so. Re-run the tests, review again, submit again. Editing `tests/cases.json` after the
review makes it stale too, and a review only counts for the tool name it was written for.

Honest limit: the review is a gate against forgetting, not against the minting model itself. `save_tool` hands
back the source hash, so a model could call `submit_review` with `allow` without running the reviewer, or run
`website-mcp review <name> allow` through Bash. `review.json` is a plain file and can be forged by anyone who can
write the draft folder. Run the reviewer; do not skip it.

## What publish refuses

- No review, a `deny`, or a stale review.
- Fewer than 3 cases, or under 70% passing on the current source.
- A manifest that is not valid, schemas that do not compile, a script that does not parse.
- `effect` other than `"read"`, or `kind` other than `"browser"`.
- A URL literal outside `site.allowedOrigins`, or a secret-shaped literal (API keys, tokens, high-entropy
  strings). The URL scan reads literal text only; the runtime route guard blocks the rest.

## Write for the caller

The caller is a model that will choose this tool from a list. Name it for what it returns (`books_by_category`),
and write a description that says what it reads, from which site, what the inputs mean, what comes back, and
what an empty result means. Mention paging (`page`, `hasNext`) in the description when it exists. Describe
every input and output field in the schemas.

## What the reviewer looks for

- The tool does what was asked, no more. A request for one category does not become a crawl of the site.
- Read-only. No clicks that submit, delete, buy, subscribe or post.
- Origins are tight: only the site's real hosts, not wildcards or third parties.
- No literal secrets, emails, phone numbers, or personal data in the source or the cases.
- Locators are robust and absent elements are guarded with `count()`.
- Cases include a result, an empty and an invalid input case, plus paging when the tool pages.
- No network or navigation away from the allowed origins.

Fix `deny` findings in the draft rather than arguing with them, then review again.

## After publishing

The tool is live in the running session and listed under its own name. Tell the user how to run it without a
model (`website-mcp run <name> --input '<json>'`) and how to test it (`website-mcp test <name>`). The previous
version stays in `.history/<n>/`. Republishing an existing tool needs a fresh review of the new draft too.
