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

test("the page runner's fail-closed refusal (no allowedOrigins) is marked preflight, so run.ts treats it as never reached", async () => {
  const { PageRunner } = await import("../../dist/runtime/runners/page.js");
  const ctx = { manifest: { name: "x", kind: "page", effect: "write", site: {} }, fn: () => 1, dir: home, input: {}, signal: new AbortController().signal };
  await assert.rejects(new PageRunner().run(ctx), (e) => e.code === "tool_failed" && e.preflight === true && /fail closed/.test(e.message));
});

test("two processes claiming the same slot at once: exactly one wins (cross-process lock)", async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const rate = fileURLToPath(new URL("../../dist/runtime/rate.js", import.meta.url));
  const script = `import(${JSON.stringify(rate)}).then(m=>{try{m.reserveInterval("xproc",3600);console.log("ok")}catch(e){console.log(e.code)}})`;
  const one = () => new Promise((res) => {
    let out = "";
    const c = spawn(process.execPath, ["-e", script], { env: { ...process.env, WEBSITE_MCP_HOME: home } });
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => res(out.trim()));
  });
  const r = await Promise.all(Array.from({ length: 6 }, one));
  assert.equal(r.filter((x) => x === "ok").length, 1, r.join(","));
  assert.equal(r.filter((x) => x === "TOO_SOON").length, 5, r.join(","));
});
