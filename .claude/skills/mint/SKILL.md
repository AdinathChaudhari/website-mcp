---
name: mint
description: Turn a website into a saved, deterministic tool that runs later with no model. Use on "/mint" or "turn this site into a tool".
---

# mint

Explore a public site with the website-mcp tools, write a script, prove it, save it. Tools are read-only: tools only read data.

## Loop

1. **open** the URL. Check the final URL, status and title.
2. **snapshot** the page (ARIA tree). Then **explore** with small JS bodies (`page` is in scope, `return` the result) until the locators and the data shape are solid. Prefer roles, labels, text and stable attributes over brittle CSS paths. Check pagination and empty states.
3. **Write tool.mjs**. Import-free, one default export:
   ```js
   export default async ({ page, input, wm }) => {
     if (!input.tag) throw new wm.InvalidInput("tag is required");
     await page.goto(`https://example.com/tag/${encodeURIComponent(input.tag)}/`);
     // robust locators, then return plain JSON matching the output schema
     return { items: [] };
   };
   ```
   The tool navigates itself with `page.goto`. It gets a fresh browser, not the minting page. Throw `wm.InvalidInput` for bad input.
4. **Write tool.json** fields: `description`, `input` and `output` (JSON Schema, set `additionalProperties:false` on input), `effect: "read"`, `site.allowedOrigins` (REQUIRED, non-empty: exact origins the tool may reach, e.g. `["https://example.com"]`; the input schema must have `type:"object"`).
5. **save_tool** saves a DRAFT (in `drafts/<name>/`, not yet a callable tool; the result lists static problems to fix). Re-save to fix. **run_tool** with `draft:true` runs it on 2-3 inputs, including one with no results (it must return an empty list, not fail).
6. **save_cases**: at least 3 cases `{ name, purpose, input, expect }`. Include a normal `result` case, an `empty` case (valid input, no results) and an `invalid_input` case (the tool or its schema must reject it). If the output has several arrays, set `resultsPath` in tool.json (dot path to the main list); otherwise the first array property is used for `empty`.
7. **test_tool** (`which:"draft"`). Fix and re-save until it passes. The pass rate must be at least 70% on the current source.
8. **publish_tool**. It refuses on under 3 cases, under 70% pass (naming the failing cases), schema errors, URLs outside `site.allowedOrigins`, or secret-shaped literals. On success the tool is live in this session (no restart) and the previous version is kept in `.history/<n>/`.
9. Tell the user: `website-mcp run <name> --input '<json>'` and `website-mcp test <name>`. Both run with no model.

## Rules

- Tool names: `^[a-z][a-z0-9_]{1,62}$`.
- Before `getAttribute`/`textContent`/`innerText` on an element that may be absent, check `await loc.count()` first. Otherwise the call waits the full 30 s default timeout, even inside `.catch`.
- No secrets, no logins, no writes in this phase.
- Keep results small. Output over 16 KiB is truncated with the full text spilled to a file.
