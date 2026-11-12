// wm.waitForOutcome and wm.paginate against the loopback fixture site (/items pages, /search has an empty state).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { start, ITEMS } from "../fixtures/site/server.mjs";

const { waitForOutcome, paginate } = await import("../../dist/browser/waits.js");

let site, browser, page;
before(async () => {
  site = await start();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await site?.close();
});
// A fresh page per test; the previous one is closed so no waiter outlives its test.
async function fresh() {
  await page?.close();
  page = await (await browser.newContext()).newPage();
  return page;
}
const title = (i) => ITEMS[i].title;

test("waitForOutcome resolves with whichever outcome appears: results", async () => {
  const p = await fresh();
  await p.goto(site.url + "/search?q=alpha");
  assert.equal(await waitForOutcome(p, { results: "ul.results li.item", empty: ".empty", error: ".error" }), "results");
});

test("waitForOutcome resolves with the empty outcome fast, not after the full timeout", async () => {
  const p = await fresh();
  await p.goto(site.url + "/search?q=zzz-nothing");
  const t0 = Date.now();
  assert.equal(await waitForOutcome(p, { results: "ul.results li.item", empty: ".empty", error: ".error" }, { timeoutMs: 8000 }), "empty");
  assert.ok(Date.now() - t0 < 4000, "must not wait out the timeout for the answer that is absent");
});

test("waitForOutcome sees an outcome that appears later (after the call starts)", async () => {
  const p = await fresh();
  await p.goto(site.url + "/items");
  await p.evaluate(() => setTimeout(() => document.body.insertAdjacentHTML("beforeend", '<div id="late">later</div>'), 300));
  assert.equal(await waitForOutcome(p, { never: "#never", late: "#late" }), "late");
});

test("waitForOutcome with several visible: the first listed wins", async () => {
  const p = await fresh();
  await p.goto(site.url + "/items");
  assert.equal(await waitForOutcome(p, { second: "ul.items", first: "h1" }), "second");
  assert.equal(await waitForOutcome(p, { first: "h1", second: "ul.items" }), "first");
});

test("waitForOutcome times out with an error naming every outcome and selector", async () => {
  const p = await fresh();
  await p.goto(site.url + "/items");
  await assert.rejects(
    () => waitForOutcome(p, { results: ".nope-results", empty: ".nope-empty", error: ".nope-error" }, { timeoutMs: 300 }),
    (e) => {
      assert.match(e.message, /none of the expected outcomes appeared within 300ms/);
      for (const n of ["results (.nope-results)", "empty (.nope-empty)", "error (.nope-error)"]) assert.ok(e.message.includes(n), n);
      return true;
    },
  );
  await assert.rejects(() => waitForOutcome(p, {}), /at least one outcome/);
});

test("paginate collects every page until there is no next, in order", async () => {
  const p = await fresh();
  await p.goto(site.url + "/items");
  const r = await paginate(p, { next: "a.next", item: "ul.items li.item a.title", maxPages: 10 });
  assert.equal(r.stopped, "no_next");
  assert.equal(r.pages, 3);
  assert.equal(r.rows.length, 25);
  assert.deepEqual(r.rows.slice(0, 2), [title(0), title(1)]);
  assert.equal(r.rows[24], title(24));
});

test("paginate stops at maxPages and the second page holds rows the first did not", async () => {
  const p = await fresh();
  await p.goto(site.url + "/items");
  const one = await paginate(p, { next: "a.next", item: "ul.items li.item a.title", maxPages: 1 });
  assert.deepEqual([one.pages, one.stopped, one.rows.length], [1, "max_pages", 10]);
  await p.goto(site.url + "/items");
  const two = await paginate(p, { next: "a.next", item: "ul.items li.item a.title", maxPages: 2 });
  assert.deepEqual([two.pages, two.stopped, two.rows.length], [2, "max_pages", 20]);
  const fresher = two.rows.filter((x) => !one.rows.includes(x));
  assert.equal(fresher.length, 10, "page 2 rows are all new");
});

test("paginate uses extract and dedupe by key", async () => {
  const p = await fresh();
  await p.goto(site.url + "/items?page=3");
  const r = await paginate(p, {
    next: "a.next",
    item: "ul.items li.item",
    extract: async (row) => ({ id: await row.getAttribute("data-id"), tag: (await row.locator(".tag").innerText()).trim() }),
    dedupe: (x) => x.id,
  });
  assert.equal(r.pages, 1);
  assert.equal(r.stopped, "no_next");
  assert.deepEqual(r.rows.map((x) => x.id), ["21", "22", "23", "24", "25"]);
});

test("paginate dedupe drops repeated rows and stops when a page adds nothing new", async () => {
  const p = await fresh();
  await p.goto(site.url + "/items");
  // A "next" that never leaves the page content: extractPage returns the same two rows each time.
  const r = await paginate(p, { next: "a.next", extractPage: async () => ["a", "a", "b"], dedupe: true, maxPages: 5, timeoutMs: 3000 }).catch((e) => e);
  // Page 1 adds a,b; clicking next changes the URL (page 2), page 2 adds nothing new -> stop.
  assert.equal(r.stopped, "no_new_rows");
  assert.deepEqual(r.rows, ["a", "b"]);
  assert.equal(r.pages, 2);
});

test("paginate throws instead of looping when next changes nothing", async () => {
  const p = await fresh();
  await p.goto(site.url + "/items");
  await p.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<a class="dead" href="#" onclick="return false">dead next</a>'));
  await assert.rejects(() => paginate(p, { next: "a.dead", item: "ul.items li.item", timeoutMs: 400 }), /did not change the page/);
});

test("paginate treats a disabled next as the end, and validates its options", async () => {
  const p = await fresh();
  await p.goto(site.url + "/items");
  await p.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<button class="dis" disabled>next</button>'));
  const r = await paginate(p, { next: "button.dis", item: "ul.items li.item" });
  assert.deepEqual([r.pages, r.stopped, r.rows.length], [1, "no_next", 10]);
  await assert.rejects(() => paginate(p, { next: "a.next" }), /exactly one of/);
  await assert.rejects(() => paginate(p, { next: "a.next", item: "li", extractPage: () => [] }), /exactly one of/);
  await assert.rejects(() => paginate(p, { next: "a.next", item: "li", maxPages: 0 }), /maxPages/);
});

test("wm exposes waitForOutcome and paginate to tools (a saved tool uses them end to end)", async () => {
  const { makeHelper } = await import("../../dist/runtime/runners/playwright.js");
  const wm = makeHelper();
  assert.equal(wm.waitForOutcome, waitForOutcome);
  assert.equal(wm.paginate, paginate);
  const p = await fresh();
  await p.goto(site.url + "/search?q=beta");
  assert.equal(await wm.waitForOutcome(p, { results: "ul.results li", empty: ".empty" }), "results");
});
