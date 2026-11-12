# Page tools (kind "page")

A page tool is a small function that runs INSIDE a tab the user already has open in their own browser, with their
real, signed-in session. Use it when the site needs that session or is bot-sensitive. Public pages that should
run unattended are `browser` tools instead. Saved page tools run with no model, and only after the user approves
that exact version.

## What you write

`tool.mjs`: one default export and nothing else.

```js
export default async ({ input, wm }) => {
  const rows = [...document.querySelectorAll("[data-testid=row]")].map((r) => ({
    title: r.querySelector("a")?.textContent?.trim() ?? "",
  }));
  return { rows };
};
```

- It is serialised with `toString()` and sent to the tab, so it cannot see anything outside itself: no imports,
  no helper functions or constants above it, no closures. Put helpers inside the function.
- It receives only `{ input, wm }`. `document`, `window`, `location` are the tab's own.
- `wm.waitFor(selector, ms)`, `wm.text(selector)`, `wm.all(selector, mapFn)`, `wm.scrollIntoView(selector)`.
- Read only. No clicks that change data, no form posts. One document: do not navigate away.
- No network of its own. Refused at publish: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`,
  `eval`, `new Function`, `importScripts`, `chrome.*`, `document.cookie`, `localStorage`/`sessionStorage` writes,
  `indexedDB`, `window[...]`-style dynamic lookups, `.constructor`, `location` assignments, `window.open`.
  Read what is already in the DOM. If the data is only in an API response, that is a different tool.

`tool.json` adds:

```json
{ "kind": "page", "effect": "read",
  "site": { "allowedOrigins": ["https://example.com"] },
  "page": { "urlPattern": "/account/*", "world": "USER_SCRIPT", "tab": "existing", "needsVisible": false },
  "minIntervalSec": 0, "hardTarget": false }
```

`world` stays `USER_SCRIPT` (isolated from the page's own scripts). `MAIN` runs inside the page's own world; it needs
a reviewer finding that mentions MAIN and why. `hardTarget: true` marks a bot-sensitive site and halves the live budget.

`signin.json` (optional, pass it as `signin` to save_tool): `{ "marker": "<css selector present only when signed in>",
"loginUrl": "https://example.com/login" }`. It is checked in the tab before the script runs; absent marker returns
`SIGNED_OUT` naming `loginUrl`.

## How you explore

1. `page_tabs` lists the user's tabs (id, url, title, granted, explore). Ask the user to open the tab on the page
   you need and, in the extension popup, to allow the site and switch on **Explore this site**. The window turns itself
   off after 15 minutes. `page_snapshot`, `page_explore` and `page_capture` are refused while it is off.
2. `page_snapshot` for an outline, `page_explore` for small read-only probes. Results over 16 KiB are truncated.
3. `page_capture(tabId, name)` saves the page's HTML as `captures/<n>.html` of your draft. Capture the normal state,
   an empty state if you can reach one, and (if there is a signin marker) a signed-out state. Captures hold the
   user's real page: they stay in the tool home, never in a repo, a fixture or a report.

## How you test

- Cases default to `mode: "capture"` and must name the file: `{ "name": "...", "purpose": "...", "input": {},
  "expect": "result", "capture": "1.html" }`. They run offline in a Chromium with JavaScript disabled and the network
  blocked, with the same helpers and the same function, so a stray `fetch` fails.
- `mode: "live"` cases, and `run_tool` with `draft: true`, run in the user's real tab (explore window open). Live runs
  hit the real site: 4 per mint, 2 when `hardTarget` is true. Spend them well.
- Publish needs at least 3 capture cases, all passing, AND at least one live pass for the exact source. Any edit to
  tool.mjs or tool.json afterwards needs another live pass.
- `expect: "signed_out"` checks the signin marker against a signed-out capture.

## After publish

The first run of every published version returns `NEEDS_APPROVAL`. Tell the user to open the extension popup, check name,
version, site and hash, and click Approve. Editing `tool.mjs` by hand changes the hash and asks again.

## Limits of the publish scan

It is a text scan, not a parser. Strings, comments and regexes are blanked first, so a banned word inside text passes
and a banned name built from pieces is not seen; it refuses the usual ways to reach globals instead. The free-variable
check ignores scope blocks and treats any name declared anywhere in the function as declared. It catches honest
mistakes; the real boundary is the user's approval of the hash and the extension's per-site grants.
