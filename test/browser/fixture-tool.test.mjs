import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { start } from "../fixtures/site/server.mjs";
import { ROOT, installFixtureTool, startMcp, tempHome, rm, waitFor } from "../helpers/index.mjs";

let site, home, mcp;
before(async () => {
  site = await start();
  home = tempHome("wm-browser-");
  installFixtureTool(home, "fixture_search", site.url, "tools");
  installFixtureTool(home, "fixture_search", site.url, "drafts");
});
after(async () => {
  await mcp?.close();
  await site?.close();
  rm(home);
});

// Async on purpose: the fixture site lives in this process, so a sync spawn would deadlock it.
const cli = (...args) =>
  new Promise((resolve) =>
    execFile(process.execPath, [join(ROOT, "dist", "cli.js"), ...args], { env: { ...process.env, WEBSITE_MCP_HOME: home }, encoding: "utf8" }, (err, stdout, stderr) =>
      resolve({ status: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }),
    ),
  );

test("fixture site serves list, pagination, search and empty state", async () => {
  const get = async (p) => (await fetch(site.url + p)).text();
  const p1 = await get("/items");
  assert.equal((p1.match(/class="item"/g) ?? []).length, 10);
  assert.match(p1, /class="next"/);
  const p3 = await get("/items?page=3");
  assert.equal((p3.match(/class="item"/g) ?? []).length, 5);
  assert.doesNotMatch(p3, /class="next"/);
  assert.match(await get("/search?q=zzz"), /class="empty"/);
  assert.match(await get("/item/7"), /Fixture item 07/);
  assert.equal((await fetch(site.url + "/item/999")).status, 404);
});

test("CLI run returns a result from the fixture tool, no model", async () => {
  const r = await cli("run", "fixture_search", "--input", '{"q":"alpha"}');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.items, ["Fixture item 01", "Fixture item 06", "Fixture item 11", "Fixture item 16", "Fixture item 21"]);
});

test("CLI run reports invalid_input and empty results", async () => {
  const bad = await cli("run", "fixture_search", "--input", '{"q":""}');
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout || bad.stderr).error.code, "invalid_input");
  const empty = await cli("run", "fixture_search", "--input", '{"q":"zzz-nothing"}');
  assert.deepEqual(JSON.parse(empty.stdout), { items: [] });
});

test("allowedOrigins is enforced: a tool whose manifest allows another origin cannot reach the site", async () => {
  installFixtureTool(home, "fixture_search", site.url, "tools", {
    as: "fixture_wrong_origin",
    manifestTransform: (m) => ({ ...m, site: { allowedOrigins: ["http://127.0.0.1:1"] }, timeoutSec: 20 }),
  });
  const r = await cli("run", "fixture_wrong_origin", "--input", '{"q":"alpha"}');
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout || r.stderr).error.code, "tool_failed");
});

test("website-mcp test passes the fixture tool (exit 0)", async () => {
  const r = await cli("test", "fixture_search");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS/);
  const last = JSON.parse(readFileSync(join(home, "tools", "fixture_search", "tests", "last-run.json"), "utf8"));
  assert.equal(last.passRate, 1);
  assert.equal(last.results.length, 6);
});

test("the stdio server runs the fixture tool as a dynamic tool", async () => {
  mcp = await startMcp(home);
  const names = (await mcp.client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("fixture_search"));
  const r = await mcp.call("fixture_search", { q: "alpha" });
  assert.equal(r.isError, false);
  assert.equal(r.v.items.length, 5);
});
