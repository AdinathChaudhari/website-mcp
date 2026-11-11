// A "minter" with no model: canned explore code + canned tool source, driven through the real MCP server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { start } from "../fixtures/site/server.mjs";
import { startMcp, tempHome, rm, waitFor } from "../helpers/index.mjs";

let site, home, mcp;
before(async () => {
  site = await start();
  home = tempHome("wm-minter-");
  mcp = await startMcp(home);
});
after(async () => {
  await mcp?.close();
  await site?.close();
  rm(home);
});

test("open -> snapshot -> explore -> save -> cases -> test -> publish -> call", async () => {
  const { call, client, state } = mcp;
  const o = await call("open", { url: `${site.url}/items` });
  assert.equal(o.v.status, 200);
  assert.equal(o.v.title, "Items");

  const snap = await call("snapshot");
  assert.match(snap.v, /Fixture item 01/);

  const ex = await call("explore", { code: `return await page.locator("ul.items li.item a.title").allTextContents();` });
  assert.equal(ex.v.length, 10);
  const nextHref = await call("explore", { code: `return await page.locator("a.next").getAttribute("href");` });
  assert.equal(nextHref.v, "/items?page=2");

  const tool = {
    description: "List one page of the fixture items.",
    effect: "read",
    site: { allowedOrigins: [site.url] },
    input: { type: "object", properties: { page: { type: "integer", minimum: 1, default: 1 } }, additionalProperties: false },
    output: { type: "object", properties: { items: { type: "array", items: { type: "string" } }, hasNext: { type: "boolean" } }, required: ["items", "hasNext"] },
  };
  const source = `export default async ({ page, input }) => {
  const n = input.page ?? 1;
  await page.goto(${JSON.stringify(site.url)} + "/items?page=" + n);
  const items = await page.locator("ul.items li.item a.title").allTextContents();
  return { items, hasNext: (await page.locator("a.next").count()) > 0 };
};
`;
  const saved = await call("save_tool", { name: "fixture_list", tool, source });
  assert.equal(saved.isError, false);
  assert.deepEqual(saved.v.problems, []);
  assert.ok(existsSync(join(home, "drafts", "fixture_list", "tool.mjs")));
  assert.ok(!existsSync(join(home, "tools", "fixture_list")), "a draft is not published");

  // Publishing before cases exist is refused.
  const early = await call("publish_tool", { name: "fixture_list" });
  assert.equal(early.isError, true);
  assert.ok(early.v.error.reasons.some((r) => r.code === "too_few_cases"));

  const cases = [
    { name: "first_page", purpose: "page 1 has 10 items", input: { page: 1 }, expect: "result" },
    { name: "last_page", purpose: "page 3 has the last items", input: { page: 3 }, expect: "result" },
    { name: "past_the_end", purpose: "page 9 is empty", input: { page: 9 }, expect: "empty" },
    { name: "page_zero", purpose: "page 0 is invalid", input: { page: 0 }, expect: "invalid_input" },
  ];
  assert.equal((await call("save_cases", { name: "fixture_list", cases })).v.cases, 4);
  const t = await call("test_tool", { name: "fixture_list", which: "draft" });
  assert.equal(t.v.passRate, 1, JSON.stringify(t.v.results));

  const before = state.changed;
  const pub = await call("publish_tool", { name: "fixture_list" });
  assert.equal(pub.isError, false, JSON.stringify(pub.v));
  assert.equal(pub.v.version, 1);
  assert.ok(await waitFor(() => state.changed > before));
  assert.ok((await client.listTools()).tools.some((x) => x.name === "fixture_list"));

  const r = await call("fixture_list", { page: 3 });
  assert.equal(r.v.items.length, 5);
  assert.equal(r.v.hasNext, false);
  assert.equal((await call("fixture_list", { page: 1 })).v.hasNext, true);

  const files = readdirSync(join(home, "tools", "fixture_list")).sort();
  assert.deepEqual(files, ["README.md", "tests", "tool.json", "tool.mjs"]);
  const rerun = await call("test_tool", { name: "fixture_list", which: "published" });
  assert.equal(rerun.v.passRate, 1);
});
