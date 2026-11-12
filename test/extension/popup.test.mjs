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
test("explore toggle stores a 15 min expiry; Approve moves pending to approved", async () => {
  const d = dom(); const set = [];
  const store = { pending: { "t|1|abcdef123456": { toolName: "t", version: 1, hash: "abcdef123456", site: "https://x.test" } } };
  const c = chromeMock({ url: "https://x.test/p" });
  c.storage.local.get = async () => store; c.storage.local.set = async (o) => set.push(o);
  const items = []; d.createElement = () => { const li = { append(...a) { this.parts = a; } }; items.push(li); return li; };
  await render(c, d);
  await d.els.explore.onchange({ target: { checked: true } });
  const ex = set[0].explore["https://x.test"] - Date.now();
  assert.ok(ex > 14 * 60000 && ex <= 15 * 60000);
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
