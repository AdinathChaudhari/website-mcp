import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tempHome, rm, installFixtureTool } from "../helpers/index.mjs";

const home = tempHome("wm-unit-raterun-");
process.env.WEBSITE_MCP_HOME = home;
const { runTool } = await import("../../dist/runtime/run.js");
after(() => rm(home));

const O = "https://example.test";
const install = (as, source, kind = "tools") =>
  installFixtureTool(home, "fixture_search", O, kind, { as, sourceTransform: () => source, manifestTransform: (m) => ({ ...m, minIntervalSec: 60 }) });
const code = (p) => p.then(() => "ok", (e) => e.code);

test("a run that reaches the site and fails still counts: the retry is TOO_SOON", async () => {
  install("failing_tool", `export default async () => { throw new Error("boom"); };`);
  assert.equal(await code(runTool("failing_tool", { q: "a" })), "tool_failed");
  assert.equal(await code(runTool("failing_tool", { q: "a" })), "TOO_SOON");
});

test("parallel runs: only one gets through (the slot is reserved before the await)", async () => {
  install("par_tool", `export default async () => ({ items: [] });`);
  const r = await Promise.all([1, 2, 3].map(() => code(runTool("par_tool", { q: "a" }))));
  assert.deepEqual(r.slice().sort(), ["TOO_SOON", "TOO_SOON", "ok"]);
});

test("a draft run and the published run of one tool share one interval", async () => {
  install("shared_tool", `export default async () => ({ items: [] });`);
  install("shared_tool", `export default async () => ({ items: [] });`, "drafts");
  assert.equal(await code(runTool("shared_tool", { q: "a" }, { draft: true })), "ok");
  assert.equal(await code(runTool("shared_tool", { q: "a" })), "TOO_SOON");
});

test("a failure that never reaches the page (no bridge) gives the slot back", async () => {
  installFixtureTool(home, "quotes_page", O, "tools", { as: "nb_page", manifestTransform: (m) => ({ ...m, minIntervalSec: 60 }) });
  assert.equal(await code(runTool("nb_page", {})), "NO_BRIDGE");
  assert.equal(await code(runTool("nb_page", {})), "NO_BRIDGE");
});
