# Pagination: one bounded page of rows, and a way to the next

Any list a site can run past one screen needs a decision about paging before you fix the output schema.

## Decide the contract

Pick one and write it into the tool description so the calling model knows how to continue:

- **Page input** (most sites): `input.page` (integer, default 1) and an output with `items` and `hasNext`.
  Each call reads one page. The caller asks for the next page itself. This is cheap, predictable, and testable.
- **Collect N**: `input.maxPages` or `input.limit`, with the tool clicking through pages itself and returning
  up to that many rows. Use it only when callers always want a run of pages, and keep the bound small (3 to 5
  pages), since the whole result must stay small.

Prefer the page input unless the user asked for "all" or a total count. A tool that reads 50 pages on every
call is slow and fragile; the caller can loop.

## Reach the page

- If the site puts the page in the URL (`?page=2`, `/page/2/`), open that URL directly. It is faster and
  does not depend on a button.
- If paging is a button or "load more", click it and wait for the page to change. Do not sleep.
- Never trust a page number the site did not show. Past the end, read what the site does (empty list, a
  redirect, a 404) and map it to an empty result.

## wm.paginate for click-through paging

```js
const { rows, pages, stopped } = await wm.paginate(page, {
  next: "a.next",                 // the control that goes forward
  item: "li.row",                 // one row
  extract: async (row) => ({ id: await row.getAttribute("data-id"), title: (await row.locator("a").innerText()).trim() }),
  maxPages: 3,
  dedupe: (r) => r.id,            // key on the item's own id, not its position or link text
});
```

It reads the current page, clicks `next` while it is visible and enabled, waits until the URL or the first row
changes, and stops on no next control (`no_next`), at `maxPages` (`max_pages`), or when a page adds only rows
you already have (`no_new_rows`). If a click changes nothing it throws instead of looping. Use `extractPage`
(a function of `page`) instead of `item` when a row needs more than its own element to read. With `extractPage` the
page is recognised as changed by URL only; for AJAX paging that keeps the URL, pass `changed: "<selector>"` (an
element whose text differs per page, such as the active page number), or the click throws "did not change the page".

Navigate to page 1 yourself first. Report `stopped` in the output (or `hasNext`) so the caller can tell a full
list from a cut one.

## Traps

- **Duplicates across pages.** Sites shift items between pages when the list changes, and repeat promoted
  rows. Dedupe on a stable id.
- **A disabled next.** Many sites keep the control in the DOM but disabled on the last page. `paginate`
  treats disabled as the end; if you click yourself, check `isEnabled()`.
- **Infinite scroll.** Scroll, then wait for the row count to grow; stop when it does not. Bound the loop.
- **Totals.** Return a total only if the site shows an exact one. Do not compute one from the pages you read.
- **Size.** A page of 100 rows with five fields each is already large. Trim fields before returning.

## Test it

Cases: page 1 (hasNext true), a middle page, the last page (hasNext false, fewer rows), and past the end
(`expect: "empty"`). The exit check is that page 2 returns rows page 1 did not.
