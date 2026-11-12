# Browser layer options

Assessed 2026-11-11 (planner v1 + v2). Summary of the planning notes.

| Option | Good for | Why not the primary engine |
|---|---|---|
| Own Playwright (chosen for browser tools) | Minting and deterministic replay in one engine | Detectable automation; separate session |
| Own MV3 extension + `chrome.userScripts.execute` (chosen for page tools) | Model-free runs in the real signed-in browser | Browser must be open with the tab; extension setup |
| Playwright MCP | Zero-code exploration | Ref-based clicks don't replay; two engines; `browser_run_code_unsafe` gives no safety gain |
| Chrome DevTools MCP | Protocol-level debugging | Debugging tool; no replay/profile story |
| Claude in Chrome | Manual one-off reads in the real browser | A model issues every call; no deterministic replay |
| Tampermonkey / Violentmonkey + localhost bridge | No own extension | Scripts can't be installed programmatically; polling bridge; broad 3rd-party permissions |
| Native WebMCP | Sites that publish their own tools | Origin trial only; outside MCP clients still need an extension |
