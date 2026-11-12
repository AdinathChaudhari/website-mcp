import { test } from "node:test";
import assert from "node:assert/strict";

const { scanPageSource, codeOnly } = await import("../../dist/mint/page-gate.js");
const GOOD = `export default async ({ input, wm }) => {
  const rows = [...document.querySelectorAll(".row")].map((r) => ({ t: r.textContent.trim(), n: input.n ?? 1 }));
  await wm.waitFor(".row", 100);
  return { rows, ok: /a\\/b/.test("a/b") };
};
`;
const bad = (src) => scanPageSource(src).problems.join(" | ");

test("a clean page tool passes (strings, regex, comments, template parts do not trip it)", () => {
  assert.deepEqual(scanPageSource(GOOD).problems, []);
  const tricky = `export default async ({ input }) => {
    // fetch("x") in a comment, and "fetch" in a string
    const s = "fetch XMLHttpRequest eval(";
    const t = \`value \${input.a} fetch\`;
    const { a, b: c } = input;
    const f = (x, y = 2) => x + y + c;
    for (const k of Object.keys(input)) { f(k); }
    try { JSON.parse("{}"); } catch (e) { return { e: String(e) }; }
    return { s, t, a, n: f(1), o: { fetch: 1 } };
  };`;
  assert.deepEqual(scanPageSource(tricky).problems, [], bad(tricky));
});

test("codeOnly blanks comments, strings and regexes but keeps template expressions", () => {
  const c = codeOnly('const a = "x fetch"; // eval\nconst r = /fetch/g; const t = `q ${fetch(1)}`;');
  assert.ok(!/eval/.test(c) && !/fetch\b.*fetch\b.*fetch/.test(c));
  assert.match(c, /\{fetch\(1\)/);
  assert.equal(c.length, 'const a = "x fetch"; // eval\nconst r = /fetch/g; const t = `q ${fetch(1)}`;'.length);
});

test("forbidden constructs are each refused", () => {
  const body = (x) => `export default async ({ input, wm }) => { ${x}; return {}; };`;
  const cases = {
    fetch: 'await fetch("/api")',
    "window.fetch": 'await window.fetch("/api")',
    XMLHttpRequest: "new XMLHttpRequest()",
    WebSocket: 'new WebSocket("wss://x")',
    sendBeacon: 'navigator.sendBeacon("/x")',
    eval: 'eval("1")',
    "new Function": 'new Function("return 1")()',
    importScripts: 'importScripts("x.js")',
    "chrome.": "chrome.runtime.id",
    "document.cookie": "document.cookie",
    "localStorage write": 'localStorage.setItem("a","b")',
    "storage assign": 'sessionStorage.token = "x"',
    "window[": 'window["fe"+"tch"]("/x")',
    globalThis: "globalThis.x",
    constructor: "(()=>1).constructor('return 1')",
    "dynamic import": 'await import("x")',
    require: 'require("fs")',
    "location write": 'location.href = "/x"',
  };
  for (const [k, v] of Object.entries(cases)) assert.ok(scanPageSource(body(v)).forbidden.length > 0, `${k} should be forbidden`);
  // reading is fine
  assert.deepEqual(scanPageSource(body('localStorage.getItem("a"); return location.pathname')).forbidden, []);
});

test("shape: one default export, nothing else", () => {
  assert.match(bad("const helper = () => 1;\nexport default async ({ input }) => helper()"), /top-level|free variable/);
  assert.match(bad("export default async ({ input }) => 1;\nexport const x = 1;"), /only one export|extra code/);
  assert.match(bad("export default async ({ input }) => 1;\nconst later = 2;"), /extra code/);
  assert.match(bad("export const a = 1"), /default export/);
  assert.match(bad("export default 5"), /must be a function/);
  assert.match(bad('import x from "y";\nexport default async ({ input }) => x'), /import|top-level/);
});

test("arguments: only { input, wm }", () => {
  assert.match(bad("export default async ({ page, input }) => 1"), /not: page/);
  assert.match(bad("export default async (a, b) => 1"), /destructured/);
  assert.deepEqual(scanPageSource("export default async ({ input, wm } = {}) => input").problems, []);
  assert.deepEqual(scanPageSource("export default async function ({ input: i, wm }) { return i; }").problems, []);
});

test("free variables are reported, locals and page globals are not", () => {
  const r = scanPageSource("export default async ({ input }) => { return helperFn(input) + Counter + document.title.length; }");
  assert.deepEqual(r.free.sort(), ["Counter", "helperFn"]);
  assert.deepEqual(scanPageSource("export default async ({ input }) => { const local = 1; function inner(z) { return z + local; } return inner(2) + Math.max(1, 2); }").free, []);
  assert.match(bad("export default async ({ input }) => process.env.HOME"), /free variable\(s\) process/);
});

test("scan gap probes: defaultView/navigator lookups, built-up keys, string timers", () => {
  const wrap = (b) => `export default async () => { ${b} };`;
  for (const b of ["document.defaultView['fe'+'tch'](1)", "navigator['send'+'Beacon']('x')", "(()=>{})['constr'+'uctor']('return 1')()", "setTimeout('code')", "setInterval(`x`, 5)"]) {
    assert.notEqual(bad(wrap(b)), "", b);
  }
  for (const b of ["const a = [1,2]; return a[a.length - 1] + a[0 + 1];", "setTimeout(() => 1, 5); setTimeout(function () {}, 1); setTimeout(async () => 1)"]) {
    assert.equal(bad(wrap(b)), "", b);
  }
});

test("write gate: computed string key is flagged in code only, not after of/return, in comments or in strings", () => {
  const w = (src) => scanPageSource(src, { write: true }).forbidden.join(" | ");
  assert.match(w('export default async () => { const e = document.body; e["cl"+"ick"]; return e["x"]; };'), /computed member access/);
  assert.equal(w('export default async () => { for (const f of ["a", "b"]) { f; } return ["a"]; };'), "");
  assert.equal(w('export default async () => { // el["x"] in a comment\n /* el["y"] */ const s = \'a["b"]\'; return s; };'), "");
});
