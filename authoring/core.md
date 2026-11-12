# Core: how to write a tool that keeps working

A minted tool runs later with no model and no one watching. Everything below serves one goal: the script
must give the same kind of answer tomorrow, and fail loudly and specifically when the site changes.

## The shape

```js
export default async ({ page, input, wm }) => {
  if (!input.tag?.trim()) throw new wm.InvalidInput("tag is required");
  await page.goto(`https://example.com/tag/${encodeURIComponent(input.tag)}/`);
  const outcome = await wm.waitForOutcome(page, { results: "li.row", empty: ".no-results" });
  if (outcome === "empty") return { items: [] };
  return { items: await page.locator("li.row").evaluateAll((els) => els.map((e) => e.textContent.trim())) };
};
```

- The tool gets a fresh browser every run. It starts on a blank page and must navigate itself.
- Return plain JSON that matches `output`. Never return Playwright objects, Dates or `undefined` fields.
- Write `input` and `output` as JSON Schema. Set `additionalProperties: false` on `input` and give every
  field a `description`: that text is what the calling model reads.
- `effect` is `"read"`. `site.allowedOrigins` lists the exact origins the tool may touch; the runtime blocks
  every other request, so a missing origin shows up as a failed navigation, not a leak.

## Explore first, then write

1. `open` the page, `snapshot` it, and use `explore` to try each locator and read real values.
2. Look at the page in at least three states: normal results, nothing found, and bad input. Write down how
   each one looks in the DOM before you write the script.
3. Check whether the data is already in the page as JSON (a `<script type="application/ld+json">`, an
   inline state object) or comes from a request the page makes. Reading structured data beats scraping
   markup when it exists on the page you already loaded.

## Locators that survive redesigns

Prefer, in order: roles and accessible names, labels and placeholder text, stable attributes (`data-*`,
`itemprop`, `name`), then short class selectors. Avoid long CSS chains, `nth-child` positions, and generated
class names (`css-1x2y3z`). Scope a locator to its container (`row.locator(".price")`) rather than querying
the whole page for each field.

## Absent elements: count before you read

`locator.getAttribute()`, `textContent()` and `innerText()` wait up to 30 seconds for the element to exist,
even inside `.catch()`. On a field that is sometimes missing, that turns one empty cell into a 30-second stall
per row, and a timeout for the whole tool.

```js
const badge = row.locator(".badge");
const label = (await badge.count()) ? (await badge.first().textContent()).trim() : null;
```

Check `await loc.count()` first. Use `null` in the output for a missing optional field; do not invent a default.

## Wait for outcomes, never for time

Do not use fixed sleeps. After any navigation or click, a page can end in several valid states: results, an
empty message, an error banner. Wait for all of them at once with
`wm.waitForOutcome(page, { results: sel, empty: sel, error: sel })`, which resolves with the name of the
first one that shows up and, on timeout, names every outcome it was waiting for. Then branch on the name.
Waiting on the results selector alone makes the empty case burn the whole timeout and fail.

## Input and errors

- Validate input first and throw `wm.InvalidInput("what is wrong")` for values the site cannot accept
  (blank query, page below 1, unknown category). The model sees that message.
- Build URLs with `encodeURIComponent` or `URLSearchParams`; never paste raw input into a URL or selector.
- Empty is an answer, not an error: return the empty list. Throw only when the page is not what the tool
  expects (login wall, captcha, layout changed) and say which one in the message.

## Keep results small and honest

- Return the fields a caller needs, not the page. Output over 16 KiB is cut and spilled to a file.
- Cap lists (a `limit` input, a `maxPages` bound). An unbounded loop is a tool that hangs.
- Trim whitespace, normalise numbers and currencies to one format, and say which in the schema description.

## Never

No secrets, tokens, cookies or personal data in `tool.mjs` or `tool.json`. No URLs outside
`allowedOrigins`. No writes, form submissions that change state, or purchases: this version is read-only.
