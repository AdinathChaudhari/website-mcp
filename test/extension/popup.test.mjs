import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { render, originOf } from "../../extension/popup.js";

function dom() {
  const els = {};
  for (const id of ["enabled", "status", "origin", "allow", "sites", "explore", "exploreNote", "pending", "approved"]) els[id] = { id, textContent: "", disabled: false, checked: false, replaceChildren(...c) { this.children = c; } };
  return { getElementById: (id) => els[id], createElement: () => ({ append() {} }), els };
}
function chromeMock({ url, connected = true, enabled, origins = [] } = {}) {
  return {
    storage: { local: { get: async () => (enabled === undefined ? {} : { enabled }), set: async () => {} } },
    runtime: { sendMessage: async () => ({ connected }) },
    tabs: { query: async () => (url === undefined ? [] : [{ url }]) },
    permissions: { getAll: async () => ({ origins }), request: async () => true, remove: async () => true },
  };
}

test("active tab with a URL: origin shown, Allow enabled", async () => {
  const d = dom();
  await render(chromeMock({ url: "https://quotes.toscrape.com/page/2/?x=1" }), d);
  assert.equal(d.els.origin.textContent, "https://quotes.toscrape.com");
  assert.equal(d.els.allow.disabled, false);
});
test("no URL or non-web URL: '(no web page)' and Allow disabled", async () => {
  for (const url of [undefined, "chrome://extensions", "about:blank"]) {
    const d = dom();
    await render(chromeMock({ url }), d);
    assert.equal(d.els.origin.textContent, "(no web page)");
    assert.equal(d.els.allow.disabled, true);
  }
});
test("status text follows the reported connection state", async () => {
  const a = dom(); await render(chromeMock({ connected: true }), a);
  const b = dom(); await render(chromeMock({ connected: false }), b);
  assert.equal(a.els.status.textContent, "Bridge connected");
  assert.match(b.els.status.textContent, /not connected/);
});
test("originOf only accepts http(s)", () => {
  assert.equal(originOf("ftp://x/y"), null);
  assert.equal(originOf("nope"), null);
});
test("manifest keeps activeTab (Allow button relies on it) and the popup", () => {
  const m = JSON.parse(readFileSync(new URL("../../extension/manifest.json", import.meta.url), "utf8"));
  assert.ok(m.permissions.includes("activeTab"));
});
test("Approve moves pending to approved; explore choice 1 hour stores a 1 hour expiry", async () => {
  const d = dom(); const set = [];
  const store = { pending: { "t|1|abcdef123456": { toolName: "t", version: 1, hash: "abcdef123456", site: "https://x.test" } } };
  const c = chromeMock({ url: "https://x.test/p" });
  c.storage.local.get = async () => store; c.storage.local.set = async (o) => set.push(o);
  const items = []; d.createElement = () => { const li = { append(...a) { this.parts = a; } }; items.push(li); return li; };
  await render(c, d);
  await d.els.explore.onchange({ target: { value: "hour" } });
  const ex = set[0].explore["https://x.test"] - Date.now();
  assert.ok(ex > 59 * 60000 && ex <= 60 * 60000);
  const approve = items[0].parts[1]; assert.match(items[0].parts[0], /t v1 on https:\/\/x.test #abcdef123456/);
  await approve.onclick();
  const last = set.at(-1); assert.ok(last.approved["t|1|abcdef123456"]); assert.deepEqual(last.pending, {});
});
test("Revoke removes the approval", async () => {
  const d = dom(); const set = [];
  const A = { toolName: "t", version: 1, hash: "abcdef1234567890", site: "https://x.test" };
  const store = { approved: { "t|1|abcdef1234567890": A, "u|2|ffff": { ...A, toolName: "u" } } };
  const c = chromeMock({ url: "https://x.test/p" });
  c.storage.local.get = async () => store; c.storage.local.set = async (o) => set.push(o);
  const items = []; d.createElement = () => { const li = { append(...a) { this.parts = a; } }; items.push(li); return li; };
  await render(c, d);
  assert.match(items[0].parts[0], /#abcdef123456$/);
  await items[0].parts[1].onclick();
  assert.deepEqual(Object.keys(set.at(-1).approved), ["u|2|ffff"]);
});

// ---- explore duration choice ----
function exploreChrome({ local = {}, session = {}, mode = {}, noSession = false } = {}) {
  const c = chromeMock({ url: "https://x.test/p" });
  const db = { local: { explore: local, exploreMode: mode }, session: { exploreSession: session } };
  c.storage.local.get = async (k) => ({ ...db.local, ...(k ? {} : {}) });
  c.storage.local.set = async (o) => Object.assign(db.local, o);
  if (!noSession) c.storage.session = { get: async () => ({ ...db.session }), set: async (o) => Object.assign(db.session, o) };
  return { c, db };
}
const X = "https://x.test";
async function choose(v, opts) {
  const { c, db } = exploreChrome(opts); const d = dom();
  await render(c, d); await d.els.explore.onchange({ target: { value: v } });
  return { c, db, d };
}
test("explore choice: 1 hour and 1 day set a local expiry and clear the session flag", async () => {
  for (const [v, ms] of [["hour", 3600000], ["day", 86400000]]) {
    const { db } = await choose(v, { session: { [X]: true } });
    const left = db.local.explore[X] - Date.now();
    assert.ok(left > ms - 5000 && left <= ms, v);
    assert.equal(db.session.exploreSession[X], undefined);
  }
});
test("explore choice: until the browser closes sets the session flag and clears the local expiry", async () => {
  const { db } = await choose("session", { local: { [X]: Date.now() + 60000, "https://other.test": 5 } });
  assert.equal(db.session.exploreSession[X], true);
  assert.equal(db.local.explore[X], undefined);
  assert.equal(db.local.explore["https://other.test"], 5);
});
test("explore choice: Off clears both areas for the origin", async () => {
  const { db } = await choose("off", { local: { [X]: Date.now() + 60000 }, session: { [X]: true } });
  assert.equal(db.local.explore[X], undefined);
  assert.equal(db.session.exploreSession[X], undefined);
});
test("explore choice: without session storage 'until the browser closes' stays off", async () => {
  const { c, db, d } = await choose("session", { noSession: true, local: { [X]: Date.now() + 60000 } });
  assert.equal(db.local.explore[X], undefined);
  await render(c, d); // same chrome the choice wrote to
  assert.equal(d.els.explore.value, "off");
  assert.equal(d.els.exploreNote.textContent, "off");
});
test("explore choice: a 1 day window still shows '1 day' in its last hour", async () => {
  const { c, db, d } = await choose("day", {});
  assert.equal(db.local.exploreMode[X], "day");
  db.local.explore[X] = Date.now() + 30 * 60000;
  await render(c, d);
  assert.equal(d.els.explore.value, "day");
  for (const v of ["off", "session"]) {
    const r = await choose(v, { local: { [X]: Date.now() + 60000 }, mode: { [X]: "day", "https://other.test": "hour" } });
    assert.equal(r.db.local.exploreMode[X], undefined, v);
    assert.equal(r.db.local.exploreMode["https://other.test"], "hour", v);
  }
});
test("explore note shows which option is active and when it ends", async () => {
  const note = async (o) => { const { c } = exploreChrome(o); const d = dom(); await render(c, d); return [d.els.explore.value, d.els.exploreNote.textContent]; };
  assert.deepEqual(await note({}), ["off", "off"]);
  assert.deepEqual(await note({ session: { [X]: true } }), ["session", "until the browser closes"]);
  const [h, ht] = await note({ local: { [X]: Date.now() + 1800000 } }); assert.equal(h, "hour"); assert.match(ht, /^until /);
  const [dy, dt] = await note({ local: { [X]: Date.now() + 86000000 } }); assert.equal(dy, "day"); assert.match(dt, /^until (tomorrow )?\d\d:\d\d$/);
  assert.deepEqual(await note({ local: { [X]: Date.now() - 1 } }), ["off", "off"]);
});
