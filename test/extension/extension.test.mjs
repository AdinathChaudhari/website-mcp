import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { handleMessage, matchesPath, pickTab, composeCode } from "../../extension/lib.js";

const helpers = readFileSync(new URL("../../extension/page-helpers.js", import.meta.url), "utf8");
const O = "https://quotes.toscrape.com";

function mockChrome({ enabled, us = true, granted = [O], tabs = [], exec } = {}) {
  const calls = [];
  return {
    calls,
    storage: { local: { get: async () => (enabled === undefined ? {} : { enabled }) } },
    permissions: { contains: async ({ origins }) => granted.some((g) => origins[0] === `${g}/*`) },
    tabs: { query: async () => tabs },
    userScripts: us
      ? {
          getScripts: async () => [],
          execute: async (o) => { calls.push(o); return exec ? exec(o) : [{ result: { ok: true, value: { n: 1 } } }]; },
        }
      : undefined,
  };
}
const run = (c, extra = {}) =>
  handleMessage(c, { type: "run", id: "7", source: "async ({input}) => input", input: { a: 1 }, urlPattern: "/*", origins: [O], world: "USER_SCRIPT", timeoutMs: 500, ...extra }, helpers, "0.1.0");
const tab = (id, p, o = {}) => ({ id, url: `${O}${p}`, ...o });

test("hello reply", async () => {
  assert.deepEqual(await handleMessage(mockChrome(), { type: "hello" }, helpers, "0.1.0"), { type: "hello", version: 1, extVersion: "0.1.0" });
});
test("routing: active tab wins", async () => {
  const c = mockChrome({ tabs: [tab(1, "/a", { lastAccessed: 9 }), tab(2, "/b", { active: true, lastAccessed: 1 })] });
  const r = await run(c);
  assert.equal(r.ok, true); assert.equal(r.id, "7"); assert.equal(c.calls[0].target.tabId, 2);
  assert.equal(c.calls[0].world, "USER_SCRIPT"); assert.equal(c.calls[0].injectImmediately, true);
});
test("routing: MRU fallback and path filter", async () => {
  const c = mockChrome({ tabs: [tab(1, "/x/1", { lastAccessed: 5 }), tab(2, "/x/2", { lastAccessed: 8 }), tab(3, "/y", { lastAccessed: 99 })] });
  await run(c, { urlPattern: "/x/*" });
  assert.equal(c.calls[0].target.tabId, 2);
});
test("NO_TAB names the URL to open", async () => {
  const r = await run(mockChrome({ tabs: [] }));
  assert.equal(r.error.code, "NO_TAB"); assert.match(r.error.message, /quotes\.toscrape\.com/);
});
test("SITE_NOT_GRANTED", async () => {
  const r = await run(mockChrome({ granted: [], tabs: [tab(1, "/")] }));
  assert.equal(r.error.code, "SITE_NOT_GRANTED");
});
test("USER_SCRIPTS_OFF (api missing and toggle off)", async () => {
  assert.equal((await run(mockChrome({ us: false }))).error.code, "USER_SCRIPTS_OFF");
  const c = mockChrome({ tabs: [tab(1, "/")] });
  c.userScripts.getScripts = async () => { throw new Error("off"); };
  assert.equal((await run(c)).error.code, "USER_SCRIPTS_OFF");
});
test("master switch off refuses and never executes", async () => {
  const c = mockChrome({ enabled: false, tabs: [tab(1, "/")] });
  const r = await run(c);
  assert.equal(r.ok, false); assert.equal(c.calls.length, 0);
});
test("TAB_HIDDEN when needsVisible and tab inactive", async () => {
  const r = await run(mockChrome({ tabs: [tab(1, "/", { active: false })] }), { needsVisible: true });
  assert.equal(r.error.code, "TAB_HIDDEN");
});
test("error mapping: script error, exec error, empty, throw, timeout", async () => {
  const t = [tab(1, "/")];
  assert.equal((await run(mockChrome({ tabs: t, exec: () => [{ result: { ok: false, message: "boom" } }] }))).error.message, "boom");
  assert.equal((await run(mockChrome({ tabs: t, exec: () => [{ error: "x" }] }))).error.code, "SCRIPT_ERROR");
  assert.equal((await run(mockChrome({ tabs: t, exec: () => [] }))).error.code, "SCRIPT_ERROR");
  assert.equal((await run(mockChrome({ tabs: t, exec: () => { throw new Error("nope"); } }))).error.code, "SCRIPT_ERROR");
  assert.equal((await run(mockChrome({ tabs: t, exec: () => new Promise(() => {}) }), { timeoutMs: 30 })).error.code, "TIMEOUT");
});
test("pure helpers", () => {
  assert.equal(matchesPath("/account/*", `${O}/account/x`), true);
  assert.equal(matchesPath("/account/*", `${O}/other`), false);
  assert.equal(pickTab([]), undefined);
});
test("composed code runs: wm helpers + input + thrown errors", async () => {
  const dom = { querySelector: (s) => (s === ".a" ? { textContent: " hi " } : null), querySelectorAll: () => [1, 2] };
  const ctx = vm.createContext({ document: dom, setTimeout, Date });
  const ok = await vm.runInContext(composeCode("async ({input, wm}) => ({t: wm.text('.a'), n: wm.all('x').length, i: input})", { k: 1 }, helpers), ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ok)), { ok: true, value: { t: "hi", n: 2, i: { k: 1 } } });
  const bad = await vm.runInContext(composeCode("async () => { throw new Error('bad'); }", null, helpers), ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(bad)), { ok: false, message: "bad" });
});

test("pickTab prefers the most recently accessed among active tabs (two windows)", () => {
  assert.equal(pickTab([tab(1, "/a", { active: true, lastAccessed: 1 }), tab(2, "/b", { active: true, lastAccessed: 9 }), tab(3, "/c", { lastAccessed: 99 })]).id, 2);
});

test("tabs request obeys the master switch and granted origins", async () => {
  const off = await handleMessage(mockChrome({ enabled: false, tabs: [tab(1, "/")] }), { type: "tabs", id: "x", origins: [O] }, "", "1");
  assert.equal(off.error.code, "NO_BRIDGE");
  const none = await handleMessage(mockChrome({ granted: [], tabs: [tab(1, "/")] }), { type: "tabs", id: "x", origins: [O] }, "", "1");
  assert.deepEqual(none.value, []);
});
