# extension/

Unpacked MV3 extension (plain JS, no build step): `manifest.json`, `sw.js`, `lib.js`, `popup.*`, `page-helpers.js`. Runs page tools in the user's real browser via `chrome.userScripts.execute`.

Load it from `chrome://extensions` (Developer mode, Load unpacked), then turn on **Allow User Scripts** on its details page. See the root `README.md` and `docs/safety.md`.
