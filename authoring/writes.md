# Writes: change something once, on purpose

Read `core` first. A write tool changes something on the site (saves a profile field, posts a form). It is the one
kind of tool that can do harm, so it is built to rehearse first, to save in exactly one place, and to report honestly.

## Start

1. Call `mint_effect({ effect: "write" })`. Without it `act` and `save_tool` with `effect: "write"` are refused.
2. Explore with `explore` / `page_explore` as usual (read only). Use `act` only for the one real change you are testing.
   `act` runs with `page` and `wm`; `dryRun` defaults to true, so `wm.commit` skips its function until you pass `dryRun: false`.
   Claude Code asks the user every time `act` or a write tool runs.

## Browser tools

- `tool.json`: `"effect": "write"` and `"commitMarks": ["save_profile"]` (the names of your `wm.commit` calls; at least one).
- Everything that saves or submits goes inside `await wm.commit("save_profile", async () => { ... })`. Fill fields and
  navigate outside it; click Save, wait for the confirmation inside it. With `dryRun` the callback is skipped.
- Do not declare `dryRun` in `input`: every write tool gets `dryRun` (boolean, default `true`) automatically.
- Mark names are checked: `wm.commit` with a name not in `commitMarks` fails, and publish refuses a tool whose source
  has no `wm.commit("<mark>", ...)` for every listed mark.
- Cases run as dry runs (the default), so testing and publishing never change the site. Write at least one case whose
  input reaches every `wm.commit`: publish refuses a tool whose marks no passing case reached.

## Page tools

- `tool.json`: `"effect": "write"`, `"kind": "page"`, no `commitMarks`.
- Fill with `wm.fill(selector, value)`, then end with
  `await wm.handOff({ prompt, until, timeoutSec })`. `until` is a selector that appears once the user has saved; it must not match before that (handOff throws if it already does).
  The tool never clicks Save, never submits, never dispatches events: the static scan refuses the names `click`, `submit`,
  `requestSubmit` (called, aliased or destructured), `dispatchEvent`, `.prototype` access and string-literal computed keys
  (`el["x"]`) in a write tool. It is best-effort, not a sandbox. The user presses Save in their own tab.
- `handOff` waits up to `timeoutSec` (keep `timeoutSec` in `tool.json` larger) and shows a banner with your prompt;
  the extension badge shows WAIT while it waits. Dry run: `handOff` returns at once with nothing shown.
- Approval binds to the tool code and the helper text, so a helper update asks the user again.

## What a write returns

`{ committed, possibleCommit, dryRun, marksReached, result }`, `result` being your tool's own output.
`committed`: a commit callback finished (page tools: the user's Save appeared). `possibleCommit`: a commit started and
did not finish (error, timeout, kill): the change may or may not have happened, so say so and do not assume either.
Failures carry the same two fields in the error. The runtime never retries a write, and a write that reached the
page keeps its `minIntervalSec` slot. Do not write retry loops yourself.

## Not allowed

Write tools on a `hardTarget` site. Payments, file upload, multi-step carts. A save outside `wm.commit` (browser tools)
or any click on the final control (page tools). The static checks are best-effort; the reviewer enforces the same rule and must state that nothing saves outside the
commit. `explore` is not gated by `mint_effect`: it must never change state (in a read mint it could click Save).
