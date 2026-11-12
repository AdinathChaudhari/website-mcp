import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { handleMessage, composeCode, runHash } from "../../extension/lib.js";

const helpers = readFileSync(new URL("../../extension/page-helpers.js", import.meta.url), "utf8");
const O = "https://form.test";
const SRC = `async ({ input, wm }) => { const r = await wm.handOff({ prompt: "Press Save", until: ".saved", timeoutSec: 1 }); return { saved: r.committed }; }`;

/** A page whose `.saved` marker appears when state.saved is set (the user pressed Save). */
const mkPage = (state) => {
  const bars = [];
  return vm.createContext({
    state,
    bars,
    Date,
    setTimeout,
    location: { pathname: "/form" },
    document: {
      title: "T",
      querySelectorAll: () => [],
      querySelector: (s) => (s === ".saved" && state.saved ? {} : null),
      createElement: () => ({ style: {}, remove() { bars.splice(0); } }),
      body: { appendChild: (b) => bars.push(b) },
    },
  });
};
const exec = (code, ctx) => vm.runInContext(code, ctx);
const plain = (v) => JSON.parse(JSON.stringify(v));

test("handOff: committed false until the user saves, true after; the tool never clicks", async () => {
  const state = { saved: false };
  const ctx = mkPage(state);
  const timedOut = plain(await exec(composeCode(SRC, {}, helpers, null, { dryRun: false }), ctx));
  assert.deepEqual(timedOut, { ok: true, value: { value: { saved: false }, committed: false } });
  assert.equal(ctx.bars.length, 0, "the banner is removed when the wait ends");
  setTimeout(() => (state.saved = true), 300);
  const saved = plain(await exec(composeCode(SRC, {}, helpers, null, { dryRun: false }), mkPage(state)));
  assert.deepEqual(saved, { ok: true, value: { value: { saved: true }, committed: true } });
});

test("handOff in a dry run returns at once, shows nothing and never reports committed", async () => {
  const state = { saved: true }; // even if the marker is there
  const t0 = Date.now();
  const r = plain(await exec(composeCode(SRC, {}, helpers, null, { dryRun: true }), mkPage(state)));
  assert.deepEqual(r, { ok: true, value: { value: { saved: false }, committed: false } });
  assert.ok(Date.now() - t0 < 500);
});

test("the tool cannot re-arm the helper to turn a dry run into a real one", async () => {
  const src = `async ({ wm }) => { wm._arm(false); const r = await wm.handOff({ until: ".saved", timeoutSec: 1 }); return r; }`;
  const r = plain(await exec(composeCode(src, {}, helpers, null, { dryRun: true }), mkPage({ saved: false })));
  assert.equal(r.value.value.dryRun, true);
});

test("a read tool's composed code is unchanged (no wrapper, no arming)", async () => {
  assert.equal(composeCode("async () => 1", null, "HELPERS").includes("_arm"), false);
  assert.equal(composeCode("async () => 1", null, "HELPERS").includes("committed"), false);
});

test("fill sets the value through the native setter, fires input+change, and fails on a missing field", async () => {
  const ev = [];
  class Input { constructor() { this._v = ""; } dispatchEvent(e) { ev.push(e.type); } }
  Object.defineProperty(Input.prototype, "value", { set(v) { this._v = v; }, get() { return this._v; }, configurable: true });
  const el = new Input();
  const ctx = vm.createContext({ HTMLInputElement: Input, HTMLTextAreaElement: class {}, HTMLSelectElement: class {}, Event: class { constructor(t) { this.type = t; } }, document: { querySelector: (s) => (s === "#n" ? el : null), querySelectorAll: () => [] }, location: { pathname: "/" }, Date, setTimeout });
  const wm = exec(helpers, ctx);
  assert.equal(wm.fill("#n", "Ada"), true);
  assert.equal(el._v, "Ada");
  assert.deepEqual(ev, ["input", "change"]);
  assert.throws(() => wm.fill("#missing", "x"), /no element/);
});

test("runHash: write tools bind to effect + helper text; read tools hash exactly as before", async () => {
  const m = { source: "s", origins: [O], world: "USER_SCRIPT" };
  const read = await runHash(m);
  assert.equal(await runHash(m, helpers), read, "helper text is ignored for read tools");
  const w1 = await runHash({ ...m, effect: "write" }, helpers);
  assert.notEqual(w1, read);
  assert.notEqual(await runHash({ ...m, effect: "write" }, helpers + "//"), w1, "a helper change asks for approval again");
  const { runHash: nodeHash } = await import("../../dist/runtime/runners/page.js");
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256").update(helpers).digest("hex");
  assert.equal(nodeHash({ source: "s", world: "USER_SCRIPT", origins: [O], needsVisible: false, effect: "write", helpers: h }), w1, "Node and the extension agree");
});

function chromeMock({ exec: execFn }) {
  const badges = [];
  const data = { approved: new Proxy({}, { get: () => ({}) }) };
  return {
    badges,
    action: { setBadgeText: ({ text }) => badges.push(text) },
    storage: { local: { get: async (k) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in data).map((x) => [x, data[x]])), set: async () => {} } },
    permissions: { contains: async () => true },
    windows: { get: async () => ({ focused: true }) },
    tabs: { query: async () => [{ id: 1, url: `${O}/form` }], get: async () => ({}) },
    userScripts: { getScripts: async () => [], execute: async (o) => execFn(o) },
  };
}
const runMsg = (extra) => ({ type: "run", id: "1", toolName: "w", version: 1, hash: "h", source: SRC, input: {}, origins: [O], world: "USER_SCRIPT", timeoutMs: 400, effect: "write", ...extra });

test("badge: set while a real write run waits for the user, cleared on finish and on timeout; none for a dry run", async () => {
  const done = chromeMock({ exec: () => [{ result: { ok: true, value: { value: 1, committed: true } } }] });
  const r = await handleMessage(done, runMsg({ dryRun: false }), helpers, "0");
  assert.equal(r.ok, true);
  assert.deepEqual(done.badges, ["WAIT", ""]);
  const hung = chromeMock({ exec: () => new Promise(() => {}) });
  const t = await handleMessage(hung, runMsg({ dryRun: false, timeoutMs: 30 }), helpers, "0");
  assert.equal(t.error.code, "TIMEOUT");
  assert.deepEqual(hung.badges, ["WAIT", ""]);
  const dry = chromeMock({ exec: () => [{ result: { ok: true, value: { value: 1, committed: false } } }] });
  await handleMessage(dry, runMsg({ dryRun: true }), helpers, "0");
  assert.deepEqual(dry.badges, [], "a rehearsal never asks the user for anything");
  const read = chromeMock({ exec: () => [{ result: { ok: true, value: 1 } }] });
  await handleMessage(read, { ...runMsg({}), effect: undefined }, helpers, "0");
  assert.deepEqual(read.badges, []);
});
