import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start } from "../fixtures/site/server.mjs";
import { FIXTURE_TOOLS, installFixtureTool, tempHome, rm } from "../helpers/index.mjs";

const home = tempHome("wm-pageeval-");
process.env.WEBSITE_MCP_HOME = home;
const { runTool } = await import("../../dist/runtime/run.js");
const { runCases, readCases } = await import("../../dist/mint/tests.js");
after(() => rm(home));
const CAP1 = join(FIXTURE_TOOLS, "quotes_page", "tests", "captures", "1.html");
const O = "https://quotes.toscrape.com";

test("fixture capture cases run through page-eval and pass (result, empty, invalid_input)", async () => {
  const dir = installFixtureTool(home, "quotes_page", O, "drafts");
  assert.equal(readCases(dir).length, 5);
  writeFileSync(join(dir, "signin.json"), JSON.stringify({ marker: "a.signout", loginUrl: `${O}/login` }));
  const run = await runCases("quotes_page", dir, { draft: true, version: null });
  assert.equal(run.passRate, 1, JSON.stringify(run.results)); // includes expect "signed_out" on the signed-out capture
  rmSync(join(dir, "signin.json"));
  assert.ok(run.results.every((r) => r.mode === "capture"));
  assert.equal(run.liveRuns, 0);
  const out = await runTool("quotes_page", {}, { draft: true, capture: CAP1 });
  assert.deepEqual(out.quotes.map((q) => q.author), ["Ada Example", "Ben Sample", "Cy Fixture"]);
});

test("JavaScript in the capture does not run, and the tool cannot reach the network", async () => {
  installFixtureTool(home, "quotes_page", O, "drafts", {
    as: "probe_page",
    sourceTransform: () => `export default async ({ input, wm }) => {
      let net = "none";
      try { await fetch("https://example.org/"); net = "reached"; } catch (e) { net = "blocked"; }
      return { quotes: [{ text: String(document.body.getAttribute("data-ran")) + "|" + document.title + "|" + net + "|" + typeof wm.waitFor, author: location.href }] };
    };`,
  });
  const out = await runTool("probe_page", {}, { draft: true, capture: CAP1 });
  assert.equal(out.quotes[0].text, "null|Quotes|blocked|function", "capture script must not run (title stays 'Quotes'), fetch must be blocked, wm injected");
  assert.equal(out.quotes[0].author, "https://capture.invalid/");
});

test("a capture's sidecar .json gives the page its real URL", async () => {
  const dir = join(home, "drafts", "probe_page", "captures");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "7.html"), '<html><body><div class="quote"><span class="text">t</span><small class="author">a</small></div></body></html>');
  writeFileSync(join(dir, "7.json"), JSON.stringify({ url: `${O}/page/2/` }));
  installFixtureTool(home, "quotes_page", O, "drafts", {
    as: "probe_page",
    sourceTransform: () => `export default async ({ input, wm }) => ({ quotes: [{ text: location.pathname, author: location.origin }] });`,
  });
  const out = await runTool("probe_page", {}, { draft: true, capture: join(dir, "7.html") });
  assert.deepEqual(out.quotes[0], { text: "/page/2/", author: O });
});

test("output validation applies to capture runs, and a script error is tool_failed", async () => {
  installFixtureTool(home, "quotes_page", O, "drafts", { as: "badout_page", sourceTransform: () => "export default async () => ({ nope: 1 });" });
  await assert.rejects(runTool("badout_page", {}, { draft: true, capture: CAP1 }), (e) => e.code === "invalid_output");
  installFixtureTool(home, "quotes_page", O, "drafts", { as: "throw_page", sourceTransform: () => 'export default async () => { throw new Error("boom"); };' });
  await assert.rejects(runTool("throw_page", {}, { draft: true, capture: CAP1 }), (e) => e.code === "tool_failed" && /boom/.test(e.message));
});

test("signin.json marker: present passes, absent is SIGNED_OUT naming loginUrl", async () => {
  const dir = installFixtureTool(home, "quotes_page", O, "drafts", { as: "signin_page" });
  writeFileSync(join(dir, "signin.json"), JSON.stringify({ marker: "a.signout", loginUrl: `${O}/login` }));
  assert.equal((await runTool("signin_page", {}, { draft: true, capture: CAP1 })).quotes.length, 3);
  writeFileSync(join(dir, "signin.json"), JSON.stringify({ marker: "a.account-menu", loginUrl: `${O}/login` }));
  await assert.rejects(runTool("signin_page", {}, { draft: true, capture: CAP1 }), (e) => e.code === "SIGNED_OUT" && e.message.includes(`${O}/login`));
  writeFileSync(join(dir, "signin.json"), "{ not json");
  await assert.rejects(runTool("signin_page", {}, { draft: true, capture: CAP1 }), (e) => /signin\.json/.test(e.message), "malformed signin.json fails closed");
});

test("a capture run needs a page tool and an existing file", async () => {
  installFixtureTool(home, "fixture_search", "http://127.0.0.1:9", "drafts");
  await assert.rejects(runTool("fixture_search", { q: "a" }, { draft: true, capture: CAP1 }), (e) => e.code === "invalid_input");
  await assert.rejects(runTool("quotes_page", {}, { draft: true, capture: join(home, "nope.html") }), (e) => e.code === "tool_failed");
});

test("network is really blocked: a same-origin fetch to a LIVE server is aborted (CORS would hide a leak to other origins)", async () => {
  const site = await start();
  try {
    const dir = join(home, "drafts", "probe_page", "captures");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "9.html"), "<html><body><div class='quote'></div></body></html>");
    writeFileSync(join(dir, "9.json"), JSON.stringify({ url: `${site.url}/items` }));
    installFixtureTool(home, "quotes_page", site.url, "drafts", {
      as: "probe_page",
      sourceTransform: () => `export default async () => { let r; try { const x = await fetch("/items?page=2"); r = "status " + x.status; } catch (e) { r = "blocked"; } return { quotes: [{ text: r, author: "a" }] }; };`,
    });
    const out = await runTool("probe_page", {}, { draft: true, capture: join(dir, "9.html") });
    assert.equal(out.quotes[0].text, "blocked");
  } finally {
    await site.close();
  }
});
