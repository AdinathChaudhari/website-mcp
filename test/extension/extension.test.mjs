import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { handleMessage, matchesPath, pickTab, composeCode, CAPS, runHash } from "../../extension/lib.js";

const helpers = readFileSync(new URL("../../extension/page-helpers.js", import.meta.url), "utf8");
const O = "https://quotes.toscrape.com";

const BASE = { toolName: "t", version: 1, source: "async ({input}) => input", urlPattern: "/*", origins: [O], world: "USER_SCRIPT" };
const HASH = await runHash(BASE);
const KEY = `t|1|${HASH}`;
function mockChrome({ session, enabled, us = true, granted = [O], tabs = [], exec, store = {}, approve = true, strict = false, focused = true } = {}) {
  const calls = [];
  const data = { ...(enabled === undefined ? {} : { enabled }), approved: !approve ? {} : strict ? { [KEY]: {} } : new Proxy({}, { get: () => ({}) }), ...store };
  return {
    calls,
    data,
    storage: { local: { get: async (k) => (Array.isArray(k) ? Object.fromEntries(k.filter((x) => x in data).map((x) => [x, data[x]])) : k in data ? { [k]: data[k] } : {}), set: async (o) => Object.assign(data, o) } },
    permissions: { contains: async ({ origins }) => granted.some((g) => origins[0] === `${g}/*`) },
    windows: { get: async () => ({ focused }) },
    tabs: { create: async () => { throw new Error("tab created"); }, update: async () => { throw new Error("tab navigated"); }, query: async () => tabs, get: async (id) => { const t = tabs.find((x) => x.id === id); if (!t) throw new Error("no tab"); return t; } },
    userScripts: us
      ? {
          getScripts: async () => [],
          execute: async (o) => { calls.push(o); return exec ? exec(o) : [{ result: { ok: true, value: { n: 1 } } }]; },
        }
      : undefined,
  };
}
const run = (c, extra = {}) =>
  handleMessage(c, { type: "run", id: "7", toolName: "t", version: 1, hash: "h1", source: "async ({input}) => input", input: { a: 1 }, urlPattern: "/*", origins: [O], world: "USER_SCRIPT", timeoutMs: 500, ...extra }, helpers, "0.1.0");
const tab = (id, p, o = {}) => ({ id, url: `${O}${p}`, ...o });

test("hello reply", async () => {
  assert.deepEqual(await handleMessage(mockChrome(), { type: "hello" }, helpers, "0.1.0"), { type: "hello", version: 2, extVersion: "0.1.0" });
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
test("TAB_HIDDEN when the tab is active but its window is not focused; a focused active tab runs", async () => {
  const t = [tab(1, "/", { active: true, windowId: 3 })];
  const bg = mockChrome({ tabs: t, focused: false });
  assert.equal((await run(bg, { needsVisible: true })).error.code, "TAB_HIDDEN");
  assert.equal(bg.calls.length, 0, "nothing executed in an unfocused window");
  assert.equal((await run(mockChrome({ tabs: t, focused: true }), { needsVisible: true })).ok, true);
  assert.equal((await run(mockChrome({ tabs: t, focused: false }))).ok, true, "without needsVisible focus does not matter");
  const broken = mockChrome({ tabs: t });
  broken.windows.get = async () => { throw new Error("gone"); };
  assert.equal((await run(broken, { needsVisible: true })).error.code, "TAB_HIDDEN", "fails closed when the window cannot be read");
});
test("CHALLENGE from the page stops the run: no retry, no tab opened", async () => {
  const c = mockChrome({ tabs: [tab(1, "/")], exec: () => [{ result: { ok: false, challenge: "captcha frame" } }] });
  const r = await run(c);
  assert.equal(r.error.code, "CHALLENGE"); assert.match(r.error.message, /captcha frame/);
  assert.equal(c.calls.length, 1, "executed once, never retried");
  const none = await run(mockChrome({ tabs: [] }));
  assert.equal(none.error.code, "NO_TAB", "a missing tab is reported, never opened (tabs.create would throw)");
});
test("wm.challenge sees captcha frames, checkpoint paths, 'verify you are human' headings and 429 titles; clean pages pass", () => {
  const page = ({ path = "/profile", title = "Profile", heads = [], frames = [], marks = [], size = { width: 300, height: 80 } } = {}) => vm.createContext({
    location: { pathname: path },
    document: {
      title,
      querySelectorAll: (s) => (s === "iframe" ? frames.map((src) => ({ src, getBoundingClientRect: () => size })) : s === "h1" ? heads.map((t) => ({ textContent: t })) : []),
      querySelector: (s) => (marks.some((m) => s.split(",").includes(m)) ? {} : null),
    },
    setTimeout, Date,
  });
  const ch = (o) => vm.runInContext(helpers, page(o)).challenge();
  assert.equal(ch(), null);
  assert.equal(ch({ heads: ["Experience", "Skills"], title: "Some Name | Site" }), null);
  assert.ok(ch({ path: "/checkpoint/lg/login" }));
  assert.ok(ch({ path: "/security-check" }));
  assert.equal(ch({ path: "/challenges/list" }), null, "only whole path segments count");
  assert.ok(ch({ frames: ["https://www.google.com/recaptcha/api2/anchor"] }));
  assert.ok(ch({ frames: ["https://x.test/embed/hcaptcha"] }));
  assert.equal(ch({ frames: ["https://www.google.com/recaptcha/api2/anchor"], size: { width: 0, height: 0 } }), null, "an invisible reCAPTCHA frame is not a challenge");
  assert.equal(ch({ frames: ["https://x.test/video"] }), null);
  assert.ok(ch({ heads: ["Let's verify you are human"] }));
  assert.ok(ch({ title: "Unusual traffic from your network" }));
  assert.ok(ch({ title: "429 Too Many Requests" }));
  assert.ok(ch({ heads: ["999"] }));
  assert.equal(ch({ heads: ["999 followers"] }), null);
  assert.ok(ch({ marks: [".g-recaptcha"] }));
});
test("F1: a captcha frame that is hidden, transparent or off-screen is not a challenge; a visible one is", () => {
  const ch = (cs, rect = { width: 300, height: 80, left: 10, top: 10, right: 310, bottom: 90 }) => vm.runInContext(helpers, vm.createContext({
    location: { pathname: "/p" }, innerWidth: 1000, innerHeight: 800, getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", ...cs }),
    document: { title: "T", querySelectorAll: (s) => (s === "iframe" ? [{ src: "https://www.google.com/recaptcha/api2/bframe", getBoundingClientRect: () => rect }] : []), querySelector: () => null },
    setTimeout, Date,
  })).challenge();
  assert.ok(ch({}), "visible frame");
  assert.equal(ch({ visibility: "hidden" }), null);
  assert.equal(ch({ display: "none" }), null);
  assert.equal(ch({ opacity: "0" }), null);
  assert.equal(ch({}, { width: 400, height: 580, left: -10000, top: -10000, right: -9600, bottom: -9420 }), null, "off-screen");
});
test("composed code checks for a challenge before the tool (it never runs) and after it", async () => {
  const mk = (state) => vm.createContext({ ran: 0, state, location: { get pathname() { return state.path; } }, document: { title: "T", querySelectorAll: () => [], querySelector: () => null }, setTimeout, Date });
  const pre = mk({ path: "/checkpoint" });
  const a = await vm.runInContext(composeCode("async () => { ran++; return 1; }", null, helpers, { marker: "#in", loginUrl: "https://x.test/l" }), pre);
  assert.equal(a.challenge ? true : false, true, "challenge reported even though the sign-in marker is also absent");
  assert.equal(pre.ran, 0, "tool did not run");
  const post = mk({ path: "/profile" });
  const b = await vm.runInContext(composeCode("async () => { state.path = '/checkpoint'; return 1; }", null, helpers), post);
  assert.equal(b.ok, false); assert.ok(b.challenge, "a challenge that appears during the run discards the result");
  const thrown = mk({ path: "/profile" });
  const c = await vm.runInContext(composeCode("async () => { state.path = '/security-check'; throw new Error('selector missing'); }", null, helpers), thrown);
  assert.ok(c.challenge, "a tool that throws on a challenge page reports the challenge, not the selector error");
});
test("a write run that was saved and then meets a challenge still reports committed:true", async () => {
  const state = { path: "/profile", saved: false };
  const ctx = vm.createContext({ state, location: { get pathname() { return state.path; } }, setTimeout, Date,
    document: { title: "T", body: { appendChild() {} }, createElement: () => ({ style: {}, remove() {} }), querySelectorAll: () => [], querySelector: (s) => (s === "#ok" && state.saved ? {} : null) } });
  const r = await vm.runInContext(composeCode("async ({wm}) => { setTimeout(() => { state.saved = true; }, 5); await wm.handOff({ until: '#ok' }); state.path = '/checkpoint'; return 1; }", null, helpers, undefined, { dryRun: false }), ctx);
  assert.ok(r.challenge); assert.equal(r.committed, true);
});
test("wm.scrollToLoad is bounded, human-paced and stops when nothing more loads", async () => {
  const delays = [];
  const mk = (grow) => {
    const doc = { scrollHeight: 1000 };
    let y = 0;
    const ctx = vm.createContext({
      location: { pathname: "/p" }, innerHeight: 800,
      get scrollY() { return y; },
      scrollBy: (_x, dy) => { y += dy; doc.scrollHeight += grow(); },
      document: { title: "T", documentElement: doc, querySelectorAll: () => [], querySelector: () => null },
      setTimeout: (f, ms) => { delays.push(ms); f(); }, Date,
    });
    return ctx;
  };
  const endless = mk(() => 500);
  const r = await vm.runInContext(helpers, endless).scrollToLoad({ maxSteps: 4, pauseMs: 1000 });
  assert.equal(r.steps, 4, "maxSteps bounds an endless page");
  assert.ok(delays.length >= 4 && delays.every((d) => d >= 750 && d <= 1250), JSON.stringify(delays));
  const hugeReq = await vm.runInContext(helpers, mk(() => 500)).scrollToLoad({ maxSteps: 100000, pauseMs: 0 });
  assert.ok(hugeReq.steps <= 50, "hard ceiling on steps");
  assert.ok(Math.min(...delays) >= 150, "pause has a floor");
  const flat = await vm.runInContext(helpers, mk(() => 0)).scrollToLoad({ maxSteps: 20, pauseMs: 500 });
  assert.ok(flat.steps >= 2 && flat.steps <= 5, "no growth: stops after two quiet steps at the bottom");
  // lazy page: grows only once the bottom is reached; stopping early (not at the bottom) was the bug
  const lazy = mk(() => 0);
  lazy.document.documentElement.scrollHeight = 10000;
  let ly = 0;
  lazy.scrollBy = (_x, dy) => { ly += dy; if (ly >= 6000) lazy.document.documentElement.scrollHeight = 15000; };
  Object.defineProperty(lazy, "scrollY", { get: () => ly });
  const rl = await vm.runInContext(helpers, lazy).scrollToLoad({ maxSteps: 30, pauseMs: 0 });
  assert.ok(rl.height >= 15000, "keeps scrolling until the page really is at the bottom: " + JSON.stringify(rl));
});
test("minIntervalSec and hardTarget are enforced by the runtime, not the extension, so they are not in the approval hash", async () => {
  assert.equal(await runHash({ ...BASE, minIntervalSec: 600, hardTarget: true }), HASH);
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

test("approval binds to the code that runs: a requester-supplied hash is ignored", async () => {
  const exploits = [{ source: "async()=>document.cookie" }, { world: "MAIN" }, { urlPattern: "/admin*" }, { needsVisible: true }, { signin: { marker: "#x", loginUrl: "https://a.test" } }];
  for (const e of exploits) {
    const c = mockChrome({ tabs: [tab(1, "/admin")], strict: true }); // only the benign tool's KEY is approved
    const r = await run(c, { hash: HASH, ...e });
    assert.equal(r.error?.code, "NEEDS_APPROVAL", JSON.stringify(e));
    assert.equal(c.calls.length, 0, "nothing executed");
  }
  const c = mockChrome({ tabs: [tab(1, "/")], strict: true });
  assert.equal((await run(c, { hash: "anything" })).ok, true, "same code, any claimed hash: runs");
});
// ---- Phase 5: approval, explore window, caps ----
const exploreOn = (ms = 60000) => ({ explore: { [O]: Date.now() + ms } });
const msg = (c, m) => handleMessage(c, { id: "9", ...m }, helpers, "1");

test("approval: required, then approved, then hash changed, then revoked", async () => {
  const c = mockChrome({ tabs: [tab(1, "/")], approve: false });
  const r = await run(c);
  assert.equal(r.error.code, "NEEDS_APPROVAL"); assert.equal(c.calls.length, 0);
  assert.equal(c.data.pending[KEY].site, O); assert.equal(c.data.pending[KEY].hash, HASH);
  c.data.approved = { [KEY]: c.data.pending[KEY] };
  assert.equal((await run(c)).ok, true);
  assert.equal((await run(c, { source: "async () => 2" })).error.code, "NEEDS_APPROVAL");
  assert.equal((await run(c, { version: 2 })).error.code, "NEEDS_APPROVAL");
  c.data.approved = {};
  assert.equal((await run(c)).error.code, "NEEDS_APPROVAL");
});
test("draft run: no approval, but only while the explore window is open", async () => {
  const closed = mockChrome({ tabs: [tab(1, "/")], approve: false });
  assert.equal((await run(closed, { draft: true })).error.code, "EXPLORE_OFF");
  const open = mockChrome({ tabs: [tab(1, "/")], approve: false, store: exploreOn() });
  assert.equal((await run(open, { draft: true })).ok, true);
  const expired = mockChrome({ tabs: [tab(1, "/")], approve: false, store: exploreOn(-1) });
  assert.equal((await run(expired, { draft: true })).error.code, "EXPLORE_OFF");
});
test("draft run: a granted origin whose explore window is closed is never run in", async () => {
  const O2 = "https://other.test";
  const c = mockChrome({ granted: [O, O2], tabs: [{ id: 5, url: `${O2}/` }], approve: false, store: exploreOn() });
  const all = c.tabs.query; c.tabs.query = async ({ url }) => (await all()).filter((t) => url.some((u) => t.url.startsWith(u.replace("/*", ""))));
  assert.equal((await run(c, { draft: true, origins: [O, O2] })).error.code, "NO_TAB");
  assert.equal(c.calls.length, 0);
});
test("signin marker is checked in the tab: SIGNED_OUT names the login URL", async () => {
  const c = mockChrome({ tabs: [tab(1, "/")], exec: (o) => { assert.match(o.js[0].code, /querySelector\("a\.me"\)/); return [{ result: { ok: false, signedOut: true } }]; } });
  const r = await run(c, { signin: { marker: "a.me", loginUrl: `${O}/login` } });
  assert.equal(r.error.code, "SIGNED_OUT"); assert.match(r.error.message, /\/login/);
});
test("explore/snapshot/capture: closed and expired window refuse and never execute", async () => {
  for (const store of [{}, exploreOn(-5)])
    for (const type of ["snapshot", "explore", "capture"]) {
      const c = mockChrome({ tabs: [tab(1, "/")], store });
      const r = await msg(c, { type, tabId: 1, code: "return 1", timeoutMs: 500 });
      assert.equal(r.error.code, "EXPLORE_OFF"); assert.equal(c.calls.length, 0);
    }
});
test("explore: open window runs code in USER_SCRIPT world and returns JSON", async () => {
  const c = mockChrome({ tabs: [tab(1, "/")], store: exploreOn(), exec: () => [{ result: { ok: true, value: '{"n":3}' } }] });
  const r = await msg(c, { type: "explore", tabId: 1, code: "return {n:3}", timeoutMs: 500 });
  assert.deepEqual(r.value, { n: 3 }); assert.equal(c.calls[0].world, "USER_SCRIPT");
  assert.match(c.calls[0].js[0].code, /return \{n:3\}/);
});
test("explore refuses ungranted sites, unknown tabs and non-web tabs", async () => {
  const a = mockChrome({ granted: [], tabs: [tab(1, "/")], store: exploreOn() });
  assert.equal((await msg(a, { type: "snapshot", tabId: 1 })).error.code, "SITE_NOT_GRANTED");
  const b = mockChrome({ tabs: [tab(1, "/")], store: exploreOn() });
  assert.equal((await msg(b, { type: "snapshot", tabId: 99 })).error.code, "NO_TAB");
});
test("snapshot and capture results are size-capped", async () => {
  const big = (n) => () => [{ result: { ok: true, value: JSON.stringify("x".repeat(n)) } }];
  const s = await msg(mockChrome({ tabs: [tab(1, "/")], store: exploreOn(), exec: big(CAPS.snapshot) }), { type: "snapshot", tabId: 1 });
  assert.equal(s.error.code, "SCRIPT_ERROR"); assert.match(s.error.message, /cap/);
  const ok = await msg(mockChrome({ tabs: [tab(1, "/")], store: exploreOn(), exec: big(1000) }), { type: "snapshot", tabId: 1 });
  assert.equal(ok.value.length, 1000);
  const cap = await msg(mockChrome({ tabs: [tab(1, "/")], store: exploreOn(), exec: big(CAPS.capture) }), { type: "capture", tabId: 1 });
  assert.equal(cap.error.code, "SCRIPT_ERROR");
});
test("master switch off refuses explore requests", async () => {
  const c = mockChrome({ enabled: false, tabs: [tab(1, "/")], store: exploreOn() });
  assert.equal((await msg(c, { type: "capture", tabId: 1 })).error.code, "NO_BRIDGE"); assert.equal(c.calls.length, 0);
});
test("tabs with no origins lists every http(s) tab with granted/explore", async () => {
  const c = mockChrome({ tabs: [tab(1, "/", { title: "T", active: true }), { id: 2, url: "chrome://extensions" }, { id: 3, url: "https://other.example/" }], store: exploreOn() });
  const r = await msg(c, { type: "tabs" });
  assert.deepEqual(r.value, [
    { id: 1, url: `${O}/`, title: "T", active: true, granted: true, explore: true },
    { id: 3, url: "https://other.example/", title: "", active: false, granted: false, explore: false },
  ]);
});
test("snapshot script compiles and builds an outline from a DOM (prover: a bare \\n in the template once broke it)", async () => {
  let calls;
  const c = mockChrome({ tabs: [tab(1, "/")], store: exploreOn(), exec: (o) => { calls = o; return [{ result: { ok: true, value: "null" } }]; } });
  await msg(c, { type: "snapshot", tabId: 1 });
  const el = (tagName, attrs = {}, kids = []) => ({ tagName, getAttribute: (k) => attrs[k] ?? null, childNodes: kids.map((k) => (typeof k === "string" ? { nodeType: 3, textContent: k } : k)), children: kids.filter((k) => typeof k !== "string") });
  const body = el("BODY", {}, [el("H1", {}, ["Title"]), el("UL", {}, [el("LI", {}, ["one"]), el("LI", {}, ["two"])]), el("A", { "aria-label": "Go" }, ["x"])]);
  const vm = await import("node:vm");
  const out = await vm.runInNewContext(calls.js[0].code, { document: { body } });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(JSON.parse(out.value), '  heading: Title\n  list\n    listitem: one\n    listitem: two\n  link "Go": x');
});

test("Node and the extension compute the same run hash (key order and defaults do not matter)", async () => {
  const { runHash: nodeHash } = await import("../../dist/runtime/runners/page.js");
  const m = { source: "async()=>1", world: "USER_SCRIPT", urlPattern: "/a*", origins: [O], signin: { marker: "#m", loginUrl: "https://x.test/l" }, needsVisible: true };
  assert.equal(nodeHash(m), await runHash({ ...m, signin: { loginUrl: "https://x.test/l", marker: "#m" } }));
  assert.equal(nodeHash({ source: "s", world: "USER_SCRIPT", origins: [O], needsVisible: false }), await runHash({ source: "s", origins: [O] }));
});

test("tool code cannot switch the challenge check off: wm is frozen", async () => {
  const state = { path: "/checkpoint" };
  const ctx = vm.createContext({ state, location: { get pathname() { return state.path; } }, document: { title: "T", querySelectorAll: () => [], querySelector: () => null }, setTimeout, Date });
  const r = await vm.runInContext(composeCode("async ({wm}) => { try { wm.challenge = () => null; } catch (e) {} state.path = '/checkpoint'; return 1; }", null, helpers), ctx);
  assert.ok(r.challenge, "overwriting wm.challenge did not hide the challenge");
  assert.ok(Object.isFrozen(vm.runInContext(helpers, ctx)));
});
test("wm.challenge: a long article heading that mentions 'too many requests' is not a challenge; a real block page is", () => {
  const page = (heads, title = "T") => vm.createContext({ location: { pathname: "/post" }, document: { title, querySelectorAll: (s) => (s === "h1" ? heads.map((t) => ({ textContent: t })) : []), querySelector: () => null }, setTimeout, Date });
  const ch = (h, t) => vm.runInContext(helpers, page(h, t)).challenge();
  assert.equal(ch(["Handling too many requests in your API"]), null);
  assert.equal(ch([], "How to fix a security check failure | Blog"), null);
  assert.ok(ch(["Too many requests"]));
  assert.ok(ch([], "Request denied"));
  assert.equal(vm.runInContext(helpers, vm.createContext({ location: { pathname: "/learn/challenge/5" }, document: { title: "T", querySelectorAll: () => [], querySelector: () => null }, setTimeout, Date })).challenge(), null, "a /challenge/ path alone is not enough");
});
test("explore, snapshot and capture do not run the model's code on a challenge page and report CHALLENGE", async () => {
  for (const type of ["snapshot", "explore", "capture"]) {
    const state = { path: "/checkpoint", ran: 0 };
    const ctx = vm.createContext({ state, location: { get pathname() { return state.path; }, href: "https://x.test/checkpoint" }, document: { title: "T", documentElement: { outerHTML: "" }, querySelectorAll: () => [], querySelector: () => null, body: { innerText: "", scrollHeight: 0 } }, setTimeout, Date });
    const ex = mockChrome({ tabs: [tab(1, "/")], store: { explore: { [O]: Date.now() + 60000 } }, exec: () => [{ result: undefined }] });
    let composed = "";
    ex.userScripts.execute = async (o) => { composed = o.js[0].code; return [{ result: { ok: true, value: "{}" } }]; };
    await handleMessage(ex, { type, id: "2", tabId: 1, code: "state.ran++; return 1", timeoutMs: 500 }, helpers, "0.1.0");
    assert.match(composed, /wm\.challenge\(\)/, type);
    const out = await vm.runInContext(composed, ctx);
    assert.ok(out.challenge, type); assert.equal(state.ran, 0, `${type}: model code never ran on the challenge page`);
    // and the extension maps the page's challenge result to CHALLENGE
    const c = mockChrome({ tabs: [tab(1, "/")], store: { explore: { [O]: Date.now() + 60000 } }, exec: () => [{ result: { ok: false, challenge: "captcha on the page" } }] });
    const r = await handleMessage(c, { type, id: "1", tabId: 1, code: "return 1", timeoutMs: 500 }, helpers, "0.1.0");
    assert.equal(r.error.code, "CHALLENGE", type);
  }
});

// ---- explore duration: local expiry (1 hour / 1 day) or session flag (until the browser closes) ----
const withSession = (c, flags) => { c.storage.session = { get: async () => ({ exploreSession: flags }) }; return c; };
const snap = (c) => msg(c, { type: "snapshot", tabId: 1 });
test("exploreOpen: a day-long local expiry is open, an expired one is closed", async () => {
  assert.equal((await snap(mockChrome({ tabs: [tab(1, "/")], store: exploreOn(86400000), exec: () => [{ result: { ok: true, value: "1" } }] }))).ok, true);
  assert.equal((await snap(withSession(mockChrome({ tabs: [tab(1, "/")], store: exploreOn(-1) }), {}))).error.code, "EXPLORE_OFF");
});
test("exploreOpen: a session flag opens the window for that origin only", async () => {
  const ok = withSession(mockChrome({ tabs: [tab(1, "/")], exec: () => [{ result: { ok: true, value: "1" } }] }), { [O]: true });
  assert.equal((await snap(ok)).ok, true);
  const other = withSession(mockChrome({ tabs: [tab(1, "/")] }), { "https://other.example": true });
  assert.equal((await snap(other)).error.code, "EXPLORE_OFF");
});
test("exploreOpen: missing storage.session fails closed", async () => {
  const c = mockChrome({ tabs: [tab(1, "/")] });
  assert.equal(c.storage.session, undefined);
  assert.equal((await snap(c)).error.code, "EXPLORE_OFF");
  assert.equal(c.calls.length, 0);
});
test("EXPLORE_OFF message names the choices", async () => {
  const r = await snap(mockChrome({ tabs: [tab(1, "/")] }));
  assert.match(r.error.message, /1 hour, 1 day, or until the browser closes/);
});
