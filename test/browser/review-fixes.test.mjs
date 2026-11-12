import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { start } from "../fixtures/site/server.mjs";
import { installFixtureTool, tempHome, rm } from "../helpers/index.mjs";

const home = tempHome("wm-fixes-");
process.env.WEBSITE_MCP_HOME = home;
const { runTool } = await import("../../dist/runtime/run.js");
const { toErrorPayload } = await import("../../dist/runtime/errors.js");
const { parseCases, caseProblems, runCase } = await import("../../dist/mint/tests.js");
const { staticChecks } = await import("../../dist/mint/publish.js");
const { scanPageSource } = await import("../../dist/mint/page-gate.js");
const { WriteState } = await import("../../dist/runtime/write.js");
const { recordRun } = await import("../../dist/runtime/rate.js");
let site;
before(async () => { site = await start(); });
after(async () => { await site?.close(); rm(home); });
const install = (as, opts = {}, kind = "tools") => installFixtureTool(home, "fixture_profile_write", site.url, kind, { as, ...opts });
const counter = async () => Number(await (await fetch(site.url + "/count")).text());

test("F1: cases that set dryRun:false are rejected, and a stored one still runs as a dry run", async () => {
  const bad = { name: "c", purpose: "p", input: { name: "Ada", dryRun: false }, expect: "result" };
  assert.throws(() => parseCases([bad]), /dryRun/);
  assert.ok(caseProblems([bad], "browser").some((p) => /dryRun/.test(p)));
  const dir = install("fx_case");
  const before = await counter();
  const r = await runCase("fx_case", bad, { draft: false, dir, kind: "browser" });
  assert.equal(await counter(), before, "no commit");
  assert.equal(r.pass, true, r.error);
});

test("F2: InvalidOutput after a real write carries the committed outcome", async () => {
  install("fx_badout", { sourceTransform: (s) => s.replace("return { filled: input.name };", "return { filled: 5 };") });
  const e = await runTool("fx_badout", { name: "Ada", dryRun: false }).catch((x) => x);
  assert.equal(e.code, "invalid_output");
  assert.equal(toErrorPayload(e).error.committed, true);
});

test("F11: a malformed commit mark gives a refusal, not a thrown RegExp error", () => {
  const dir = install("fx_mark", { manifestTransform: (m) => ({ ...m, commitMarks: ["save("] }) }, "drafts");
  const r = staticChecks(dir);
  assert.ok(r.some((x) => x.code === "bad_write"));
});

test("F10: array literal after of/return passes the write gate; computed click is still caught", () => {
  const body = (b) => `export default async ({ input, wm }) => { ${b} return {}; }`;
  assert.deepEqual(scanPageSource(body('for (const f of ["a","b"]) { wm.fill(f, "x"); }'), { write: true }).forbidden, []);
  assert.deepEqual(scanPageSource(body('const x = (() => { return ["a"]; })();'), { write: true }).forbidden, []);
  assert.ok(scanPageSource(body('document.body["click"]();'), { write: true }).forbidden.length > 0);
});

test("F16/F17: a failed commit stays possibleCommit after a later commit succeeds", async () => {
  const w = new WriteState(false);
  await w.commit("a", async () => { throw new Error("x"); }).catch(() => {});
  await w.commit("b", async () => 1);
  assert.equal(w.possibleCommit, true);
  assert.equal(w.committed, true);
});

test("F13: recordRun survives an unreadable run-time record", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "state", "last-run.json"), "{not json");
  assert.doesNotThrow(() => recordRun("k"));
});
