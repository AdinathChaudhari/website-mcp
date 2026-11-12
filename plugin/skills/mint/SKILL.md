---
name: mint
description: Turn a website task into a saved, tested, deterministic tool that runs later with no model. Use for "/mint <task> on <site>" or "turn this site into a tool".
argument-hint: <what to read> on <site url>
---

# mint

Explore a public site with the website-mcp tools, write a script, prove it, get it reviewed, save it. Saved
tools are read-only unless minted with `mint_effect` write (the user saves, never the tool), and run later with no model in the loop.

Task: $ARGUMENTS

The tools below are the `website-mcp` MCP server's: `guide`, `open`, `snapshot`, `explore`, `save_tool`,
`save_cases`, `test_tool`, `run_tool`, `submit_review`, `publish_tool`, `list_tools`, and for page tools
`page_tabs`, `page_snapshot`, `page_explore`, `page_capture`, and for write mints `mint_effect`, `act`.

## First: browser or page?

Ask the user "browser or page?" unless it is obvious. One rule: **signed-in or bot-sensitive means page; public and
unattended means browser.** A browser tool gets a fresh Playwright browser (the loop below). A page tool runs in a tab
the user already has open, with their real session: read `guide` topic `page-tools` and follow the page loop at the end.
If the site is bot-sensitive (accounts get locked for automation), also read `hard-targets`: own account only, read only what
the open tab shows, `hardTarget: true` with `minIntervalSec` >= 60, stop on any `CHALLENGE`, and prefer the site's own export.

## Loop

1. **Read the guides first.** Call `guide` with topic `core`. Also read `pagination` if the task lists things
   that can span pages, `search` if it takes a query or filters, and `testing` before you write cases. Call
   `guide` with no topic to see the list. Follow them; they hold the rules that keep tools working.
2. **Explore.** `open` the URL and check the final URL, status and title. `snapshot` the page, then `explore`
   with small JS bodies (`page` is in scope, `return` the result) until the locators and data shape are solid.
   Look at the normal, empty and bad-input states, and at page 2 if there is paging.
3. **Write tool.mjs**: import-free, one default export `async ({ page, input, wm }) => result`. It navigates
   itself with `page.goto` (it gets a fresh browser, not the minting page). Helpers on `wm`:
   `wm.InvalidInput(msg)`, `wm.waitForOutcome(page, { results, empty, error })` (waits for whichever appears
   first, resolves with its name), `wm.paginate(page, { next, item, extract, maxPages, dedupe })` (collects rows
   across pages), `wm.log`.
4. **Write tool.json**: `description` (what it reads, inputs, output, what empty means), `input` and `output`
   JSON Schemas (`input` is `type: "object"` with `additionalProperties: false`), `effect: "read"`,
   `site.allowedOrigins` (REQUIRED, exact origins, e.g. `["https://example.com"]`), and `resultsPath` when the
   output has several arrays.
5. **save_tool** saves a DRAFT and returns `draft` (its folder), `problems` to fix, and `sourceHash`. Re-save to
   fix. Try it with `run_tool` and `draft: true` on two or three inputs, including one with no results.
6. **save_cases**: at least 3, `{ name, purpose, input, expect }` where `expect` is `result`, `empty` or
   `invalid_input`. Cover a normal result, an empty result, an invalid input, and, if the tool pages, first,
   later and past-the-end pages.
7. **test_tool** (`which: "draft"`). Fix and re-save until it passes (at least 70% is required; aim for all).
8. **Review.** Start the `website-mcp-reviewer` subagent (in a plugin install it is listed as
   `website-mcp:website-mcp-reviewer`). Give it: the draft folder path from `save_tool`, the user's request
   verbatim, and the `sourceHash` from the latest `save_tool`. It returns a verdict, findings and the hash.
9. **submit_review** with `name`, the reviewer's `verdict`, `findings` and `sourceHash`, exactly as returned.
   If the verdict is `deny`, fix the findings, `save_tool` again (a new hash), re-run tests, and review again.
10. **publish_tool**. It refuses without an `allow` review for the current source, under 3 cases, under 70%
    pass, schema errors, URLs outside `allowedOrigins`, or secret-shaped literals; the reasons name what to fix.
    On success the tool is live in this session and the review is stored in the tool folder.
11. Tell the user: `website-mcp run <name> --input '<json>'` and `website-mcp test <name>`. Both run with no model.

## Rules

- Names match `^[a-z][a-z0-9_]{1,62}$`. Name the tool for what it returns.
- Before `getAttribute`, `textContent` or `innerText` on an element that may be absent, check `await loc.count()`.
  Otherwise the call waits the full 30 s default timeout, even inside `.catch`.
- Wait for outcomes, never for time: use `wm.waitForOutcome`.
- Any edit to tool.mjs or tool.json after a review makes the review stale. Re-test, re-review, re-submit.
- No secrets, no logins. Writes only through the explicit write mint (`mint_effect`, see the writes guide); `explore` must never change state. Keep results small (over 16 KiB is truncated).

## Page loop (kind "page")

1. `guide` topic `page-tools`, then `core` and `testing`.
2. `page_tabs`. If the site's tab is missing, not granted, or the explore window is off, ask the user to open the page,
   click "Allow this site" and switch on "Explore this site" in the extension popup (it turns off after 15 minutes).
3. `page_snapshot` and small `page_explore` probes (read-only) until the selectors and data shape are solid.
4. `page_capture` the states you will test (normal, empty, signed-out if there is a marker). Never put a capture in a repo.
5. Write tool.mjs (one default export `async ({ input, wm })`, no imports or closures, no network) and tool.json
   (`kind: "page"`, `page`, `site.allowedOrigins`). Add `signin` to `save_tool` when the page can be signed out.
6. `save_cases`: at least 3 capture cases (`capture: "<n>.html"`), including empty and invalid_input.
7. `test_tool`, then ONE live run: `run_tool` with `draft: true` (explore window open). Live runs are capped at 4 per
   mint (2 for a hard target); do not use them to debug, use captures.
8. Review (`website-mcp-reviewer`), `submit_review`, `publish_tool`. World MAIN needs a reviewer finding that says why.
9. Tell the user to open the extension popup and approve the published version (name, version, site, hash). The first run
   returns `NEEDS_APPROVAL` until they do; editing the tool later asks again.
