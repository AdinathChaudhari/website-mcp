# Testing: cases that prove the tool, not just run it

`test_tool` runs your cases through the same runtime that runs the saved tool, with no model. Publishing needs
at least 3 cases and a 70% pass rate on the current source. Aim for 100%: a case you expect to fail is a case
you should delete or fix.

## Case format

`save_cases` takes `[{ name, purpose, input, expect }]`.

| expect | passes when |
|---|---|
| `result` | the run succeeds and the main list is non-empty |
| `empty` | the run succeeds and the main list is empty |
| `invalid_input` | the tool rejects the input with `wm.InvalidInput` (or the input schema) |

The main list is the array at `resultsPath` in tool.json (a dot path like `data.items`) or, without it, the
first array property of the output. If the output has several arrays, set `resultsPath`.

## The set to write

Cover every distinct answer the site can give, with the cheapest input that produces it:

1. **A normal result.** A common input with plenty of hits. Prefer a stable one (a category, not "today").
2. **A different normal result.** A second input that changes the shape: fewer hits, optional fields missing,
   a different category. This catches locators that only work on the first example you looked at.
3. **Empty.** A valid input that finds nothing (a nonsense query). Must return the empty list, not fail.
4. **Invalid input.** Blank, out of range, wrong type, or unknown value.
5. **Paging, if the tool pages.** One case on page 1, one deep in the list, one past the end (empty).
6. **A hostile value.** Quotes, ampersands, spaces and unicode in the input. It must be encoded, not break the URL.

Give each case a `purpose` that says what it guards, so a failure reads as "page 3 lost its rows", not "case 4".

## What "pass" does not prove

`expect: "result"` only checks that the list is non-empty. A tool that returns the wrong column still passes.
Close that gap in the draft yourself before you save cases: run the tool on each case input (`run_tool` with
`draft: true`) and read the values against the live page. Compare two or three fields to what the page shows,
not just the count.

## Run, read, fix

1. `test_tool`, then read each failing case's error, not just the rate.
2. Reproduce a failure with `run_tool` (`draft: true`) on that input, and use `explore` on the live page.
3. Fix the script and `save_tool` again. Saving changes the source hash, so tests and review must run again.
4. Stop when every case passes twice in a row. A case that flips between runs is a wait problem: replace
   the timing assumption with `wm.waitForOutcome`.

## Tests are not a substitute for review

Passing cases say the tool works on the inputs you chose. The reviewer subagent checks what the cases cannot:
scope, effect, origins, leaked literals. Run it after the tests pass (see `publication`).
