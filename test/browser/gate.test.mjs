import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { start } from "../fixtures/site/server.mjs";
import { installFixtureTool, startMcp, tempHome, rm, waitFor } from "../helpers/index.mjs";

let site, home, mcp;
before(async () => {
  site = await start();
  home = tempHome("wm-gate-");
  mcp = await startMcp(home);
});
after(async () => {
  await mcp?.close();
  await site?.close();
  rm(home);
});

const SELECTOR = "ul.results li.item a.title";
const mutate = (s) => {
  assert.ok(s.includes(SELECTOR), "mutation target present in the fixture source");
  return s.replace(SELECTOR, "ul.results li.item a.titleBROKEN");
};

test("a copy of the fixture tool with ONE broken selector: test fails, publish refuses and names the failing cases", async () => {
  installFixtureTool(home, "fixture_search", site.url, "drafts", { as: "fixture_broken", sourceTransform: mutate });
  const t = await mcp.call("test_tool", { name: "fixture_broken", which: "draft" });
  assert.equal(t.isError, false);
  const failing = t.v.results.filter((r) => !r.pass).map((r) => r.name);
  assert.deepEqual(failing, ["tag_alpha", "tag_beta", "tag_gamma"]);
  assert.equal(t.v.passRate, 0.5);
  const p = await mcp.call("publish_tool", { name: "fixture_broken" });
  assert.equal(p.isError, true);
  assert.equal(p.v.error.code, "publish_refused");
  const r = p.v.error.reasons.find((x) => x.code === "pass_rate");
  assert.deepEqual(r.cases, ["tag_alpha", "tag_beta", "tag_gamma"]);
  assert.match(p.v.error.message, /tag_alpha/);
  assert.ok(!existsSync(join(home, "tools", "fixture_broken")), "nothing published");
});

test("control: the unmutated copy publishes (so the selector change is what failed it)", async () => {
  installFixtureTool(home, "fixture_search", site.url, "drafts", { as: "fixture_ok" });
  const t = await mcp.call("test_tool", { name: "fixture_ok", which: "draft" });
  assert.equal(t.v.passRate, 1);
  const p = await mcp.call("publish_tool", { name: "fixture_ok" });
  assert.equal(p.isError, false, JSON.stringify(p.v));
  assert.equal(p.v.version, 1);
  assert.equal(JSON.parse(readFileSync(join(home, "tools", "fixture_ok", "tests", "last-run.json"), "utf8")).version, 1);
});

test("publish emits tools/list_changed and the new tool is callable in the same running server", async () => {
  const names = async () => (await mcp.client.listTools()).tools.map((t) => t.name);
  installFixtureTool(home, "fixture_search", site.url, "drafts", { as: "fixture_live" });
  assert.ok(!(await names()).includes("fixture_live"), "a draft is not a callable tool");
  const before = mcp.state.changed;
  const p = await mcp.call("publish_tool", { name: "fixture_live" });
  assert.equal(p.isError, false, JSON.stringify(p.v));
  assert.ok(await waitFor(() => mcp.state.changed > before), "tools/list_changed received");
  assert.ok((await names()).includes("fixture_live"));
  const r = await mcp.call("fixture_live", { q: "beta" });
  assert.equal(r.isError, false);
  assert.ok(r.v.items.length > 0);
});
