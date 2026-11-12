# Hard targets: bot-sensitive, signed-in sites

Read this with `page-tools` when the site is signed-in AND watches for automation (accounts get checked, locked or
banned for it). Set `"hardTarget": true` in tool.json. These rules are stricter than a normal page tool on purpose.

## Rules

1. **Own account only.** The tool reads the page of the account that is signed in, in the user's own browser. Never
   someone else's account, never a list of other people, never a search.
2. **Read only what the open page shows.** The tool runs on a tab the user already opened to the right page. It does
   not navigate, click through, open tabs, follow links or paginate by itself. If the data is not on the page the user
   opened, say so and ask them to open the right page; do not go and get it.
3. **No automatic tab opening, no schedules, no loops.** One run is one human request. `minIntervalSec` is required
   (at least 60) and is enforced: a run that comes too soon fails with `TOO_SOON` before touching the site.
4. **Stop on any challenge.** A captcha, a "verify you are human" page, a checkpoint or security-check path, or a
   429-style block makes the run fail with `CHALLENGE`. It is never retried, a mint may not spend more live runs, and
   the user is told to deal with it themselves. Do not write code that tries to get around a challenge.
5. **Human pace.** Lazy sections need scrolling: use `wm.scrollToLoad({ maxSteps, pauseMs })` (bounded, jittered
   pauses, stops when nothing more loads). Do not write tight loops, retries or fixed-rate polling in the tool.
   Set `page.needsVisible: true` when sections only render in a visible tab; the extension refuses a hidden tab or an
   unfocused window with `TAB_HIDDEN`.
6. **Few live runs.** A hard-target mint gets 2 live runs, not 4. Capture the page once (`page_capture`), write cases
   against the capture, and spend the live runs only to confirm. `minIntervalSec` also spaces your draft live runs.
7. **Prefer the site's own export.** If the site offers a data download or export for the account, tell the user:
   that is zero risk and beats any automation. Mint a tool only if they still want one.
8. **Captures stay private.** They hold the signed-in page. They live in the tool home, never in a repo or a report.

## tool.json for a hard target

```json
{ "kind": "page", "effect": "read", "hardTarget": true, "minIntervalSec": 300,
  "site": { "allowedOrigins": ["https://example.com"] },
  "page": { "urlPattern": "/profile/*", "world": "USER_SCRIPT", "tab": "existing", "needsVisible": true } }
```

## What the safeguards are (and are not)

- `CHALLENGE` is a built-in check on the open page, before the tool, after it, and when it throws. It looks at the
  path (whole segments `checkpoint`, `challenge`, `captcha`, `security-check`, `authwall`, `sorry`), captcha frames
  and widgets, and the title and headings ("verify you are human", "unusual traffic", "too many requests", 429/999).
  A tool can call `wm.challenge()` itself. It is a tripwire, not a guarantee: a site can block in ways it cannot see.
- `minIntervalSec` is a local record in the tool home. It stops loops and hurried retries; it does not stop a user
  who edits the file.
- None of this makes automation allowed. The site's terms still apply and the account is the user's to risk.
