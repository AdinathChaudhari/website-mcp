import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start } from "../fixtures/site/server.mjs";
import { approve, installFixtureTool, startMcp, tempHome, rm, sleep } from "../helpers/index.mjs";

const home = tempHome("wm-writes-");
process.env.WEBSITE_MCP_HOME = home;
const { runTool } = await import("../../dist/runtime/run.js");
const { toErrorPayload } = await import("../../dist/runtime/errors.js");
const { readManifest } = await import("../../dist/runtime/load.js");
const { staticChecks, publishDraft } = await import("../../dist/mint/publish.js");
const { scanPageSource } = await import("../../dist/mint/page-gate.js");
const { MintSession } = await import("../../dist/mint/session.js");
const { composeEval } = await import("../../dist/runtime/runners/page-eval.js");
const { readPageHelpers } = await import("../../dist/bridge/page-helpers.js");
let site;
before(async () => { site = await start(); });
after(async () => { await site?.close(); rm(home); });

const install = (as, opts = {}, kind = "tools") => installFixtureTool(home, "fixture_profile_write", site.url, kind, { as, ...opts });
const counter = async () => Number(await (await fetch(site.url + "/count")).text());

test("E1: a dry run (the default) leaves the server counter unchanged and says nothing was committed", async () => {
  install("pw_dry");
  const before = await counter();
  const r = await runTool("pw_dry", { name: "Ada" });
  assert.equal(await counter(), before);
  assert.deepEqual(r, { committed: false, possibleCommit: false, dryRun: true, marksReached: ["save_profile"], result: { filled: "Ada" } });
  const explicit = await runTool("pw_dry", { name: "Ada", dryRun: true });
  assert.equal(explicit.committed, false);
  assert.equal(await counter(), before);
});

test("E2: a real run (dryRun false) raises the counter by exactly 1 and reports committed", async () => {
  install("pw_real");
  const before = await counter();
  const r = await runTool("pw_real", { name: "Ada", dryRun: false });
  assert.equal(await counter(), before + 1);
  assert.deepEqual(r, { committed: true, possibleCommit: false, dryRun: false, marksReached: ["save_profile"], result: { filled: "Ada" } });
});

test("E3: a run killed inside the commit reports possibleCommit true (and the server really did get the save); nothing is retried", async () => {
  install("pw_kill", { manifestTransform: (m) => ({ ...m, timeoutSec: 1, minIntervalSec: 30 }) });
  const before = await counter();
  let err;
  try { await runTool("pw_kill", { name: "Ada", delayMs: 4000, dryRun: false }); } catch (e) { err = e; }
  assert.equal(err?.code, "timeout");
  const p = toErrorPayload(err).error;
  assert.equal(p.possibleCommit, true);
  assert.equal(p.committed, false);
  await sleep(1500);
  assert.equal(await counter(), before + 1, "the save reached the server once: the report is honest, not 'nothing happened'");
  // never retried, and a write that reached the page keeps its interval slot
  let again;
  try { await runTool("pw_kill", { name: "Ada", dryRun: false }); } catch (e) { again = e; }
  assert.equal(again?.code, "TOO_SOON");
  assert.equal(await counter(), before + 1);
});

test("an error thrown inside the commit also reports possibleCommit true; one before it reports false", async () => {
  install("pw_throw", { sourceTransform: (s) => s.replace('await page.waitForSelector(".saved");', 'throw new Error("boom");') });
  const e1 = await runTool("pw_throw", { name: "Ada", dryRun: false }).catch((e) => e);
  assert.equal(e1.code, "tool_failed");
  assert.deepEqual(e1.outcome, { committed: false, possibleCommit: true });
  install("pw_early", { sourceTransform: (s) => s.replace("await page.fill", 'throw new Error("early"); await page.fill') });
  const e2 = await runTool("pw_early", { name: "Ada", dryRun: false }).catch((e) => e);
  assert.deepEqual(e2.outcome, { committed: false, possibleCommit: false });
});

test("wm.commit refuses a mark that tool.json does not declare", async () => {
  install("pw_badmark", { sourceTransform: (s) => s.replace('"save_profile"', '"other_mark"') });
  const e = await runTool("pw_badmark", { name: "Ada", dryRun: false }).catch((x) => x);
  assert.match(e.message, /not listed in tool.json commitMarks/);
  assert.equal(e.outcome.committed, false);
});

test("a write tool's schema gets dryRun (boolean, default true); declaring your own is refused; read tools are untouched", () => {
  install("pw_schema");
  const m = readManifest("pw_schema");
  assert.deepEqual({ type: m.input.properties.dryRun.type, d: m.input.properties.dryRun.default }, { type: "boolean", d: true });
  installFixtureTool(home, "fixture_profile_write", site.url, "tools", { as: "pw_ownflag", manifestTransform: (x) => ({ ...x, input: { ...x.input, properties: { ...x.input.properties, dryRun: { type: "boolean" } } } }) });
  assert.throws(() => readManifest("pw_ownflag"), /added automatically/);
  installFixtureTool(home, "fixture_search", site.url, "tools", { as: "ro_tool" });
  assert.equal("dryRun" in readManifest("ro_tool").input.properties, false);
});

test("MCP: write tools advertise destructiveHint, read tools do not; act needs a write mint; act dry-runs by default", async () => {
  const h = tempHome("wm-writes-mcp-");
  installFixtureTool(h, "fixture_profile_write", site.url, "tools", { as: "pw_listed" });
  installFixtureTool(h, "fixture_search", site.url, "tools", { as: "ro_listed" });
  const mcp = await startMcp(h);
  try {
    const tools = (await mcp.client.listTools()).tools;
    const by = (n) => tools.find((t) => t.name === n);
    assert.equal(by("pw_listed").annotations?.destructiveHint, true);
    assert.equal(by("ro_listed").annotations?.destructiveHint, undefined);
    assert.equal(by("pw_listed").inputSchema.properties.dryRun.default, true);
    assert.equal(by("act").annotations?.destructiveHint, true);
    assert.equal(by("run_tool").annotations?.destructiveHint, true, "the generic entry point keeps the write prompt");
    const refused = await mcp.call("act", { code: "return 1" });
    assert.equal(refused.isError, true);
    assert.match(refused.v.error.message, /mint_effect/);
    assert.equal((await mcp.call("mint_effect", { effect: "write" })).isError, false);
    const code = `await page.goto(${JSON.stringify(site.url + "/form")}); return await wm.commit("m1", async () => { await page.click("#save"); return "clicked"; });`;
    const before = await counter();
    const dry = await mcp.call("act", { code });
    assert.deepEqual({ c: dry.v.committed, d: dry.v.dryRun, m: dry.v.marksReached, r: dry.v.result }, { c: false, d: true, m: ["m1"], r: null });
    assert.equal(await counter(), before);
    const real = await mcp.call("act", { code, dryRun: false });
    assert.deepEqual({ c: real.v.committed, r: real.v.result }, { c: true, r: "clicked" });
    await sleep(300);
    assert.equal(await counter(), before + 1);
    const bad = await mcp.call("act", { code: `await page.goto(${JSON.stringify(site.url + "/form")}); await wm.commit("m1", async () => { await page.click("#save"); }); return 10n;`, dryRun: false });
    assert.equal(bad.v.committed, true, "a result that cannot be serialised must not hide the commit");
    assert.ok(bad.v.error);
    await mcp.call("mint_effect", { effect: "read" });
    assert.equal((await mcp.call("act", { code: "return 1" })).isError, true);
  } finally { await mcp.close(); rm(h); }
});

test("a read mint cannot save a write tool; a write mint can", () => {
  const s = new MintSession();
  install("pw_dry");
  const tool = JSON.parse(readFileSync(join(home, "tools", "pw_dry", "tool.json"), "utf8"));
  const src = readFileSync(join(home, "tools", "pw_dry", "tool.mjs"), "utf8");
  assert.throws(() => s.saveDraft("w_draft", tool, src), /mint_effect/);
  s.setEffect("write");
  assert.equal(s.saveDraft("w_draft", tool, src).problems.length, 0);
  assert.throws(() => s.setEffect("admin"), /read.*write/);
});

// ---------- publish gate ----------
const draftOf = (name, { manifest = (m) => m, source = (s) => s } = {}) => {
  const dir = install(name, { manifestTransform: manifest, sourceTransform: source }, "drafts");
  return dir;
};
const refusedWith = async (name, dir, code) => {
  await approve(dir);
  const e = await publishDraft(name, dir).then(() => null, (x) => x);
  assert.equal(e?.code, "publish_refused", `${name}: ${e?.message}`);
  assert.ok(e.details.some((r) => r.code === code), `${name}: expected ${code}, got ${JSON.stringify(e.details)}`);
};

test("publish: a good write tool publishes (cases ran as dry runs: nothing saved)", async () => {
  const before = await counter();
  const dir = draftOf("wp_good");
  await approve(dir);
  const r = await publishDraft("wp_good", dir);
  assert.equal(r.version, 1);
  assert.equal(await counter(), before, "the publish gate never writes");
  assert.equal(readManifest("wp_good").effect, "write");
});

test("R2/R3: a write tool whose commit mark no case ever reaches is refused", async () => {
  const dir = draftOf("wp_unreached", { source: (s) => s.replace('await wm.commit("save_profile"', 'if (input.name === "never-used") await wm.commit("save_profile"') });
  await refusedWith("wp_unreached", dir, "marks_unreached");
  assert.ok(!existsSync(join(home, "tools", "wp_unreached")));
});

test("publish: no wm.commit in the source, an undeclared/missing commitMarks, a hardTarget write and a page write without handOff are refused", async () => {
  await refusedWith("wp_nocommit", draftOf("wp_nocommit", { source: (s) => s.replace(/await wm\.commit\("save_profile", async \(\) => \{/, "await (async () => {").replace(/\}\);\n  return/, "})();\n  return") }), "write_no_commit");
  await refusedWith("wp_nomarks", draftOf("wp_nomarks", { manifest: (m) => ({ ...m, commitMarks: undefined }) }), "bad_write");
  await refusedWith("wp_hard", draftOf("wp_hard", { manifest: (m) => ({ ...m, hardTarget: true }) }), "bad_manifest");
  const hard = staticChecks(draftOf("wp_hard2", { manifest: (m) => ({ ...m, hardTarget: true }) }));
  assert.ok(hard.length > 0);
  const marks = staticChecks(draftOf("wp_marks2", { manifest: (m) => ({ ...m, commitMarks: ["save_profile", "extra_mark"] }) }));
  assert.ok(marks.some((r) => r.code === "write_no_commit" && /extra_mark/.test(r.message)));
  const pageDir = installFixtureTool(home, "profile_page_write", site.url, "drafts", { as: "wp_page", sourceTransform: (s) => s.replace(/const r = await wm\.handOff[^\n]*\n  return \{ committed: r\.committed \};/, "return { committed: false };") });
  assert.ok(staticChecks(pageDir).some((r) => r.code === "write_no_handoff"));
  assert.equal(staticChecks(installFixtureTool(home, "profile_page_write", site.url, "drafts", { as: "wp_page_ok" })).length, 0);
});

test("effect other than read/write is refused", () => {
  const dir = draftOf("wp_effect", { manifest: (m) => ({ ...m, effect: "delete" }) });
  assert.ok(staticChecks(dir).some((r) => r.code === "bad_manifest"));
});

// ---------- page kind ----------
test("B8: a page write tool that clicks, submits or dispatches a click fails the static scan; a read page tool may click", () => {
  const body = (b) => `export default async ({ input, wm }) => { ${b} return {}; }`;
  for (const b of ['document.querySelector("#save").click();', 'document.querySelector("form").submit();', 'document.querySelector("form").requestSubmit();', 'document.querySelector("#s").dispatchEvent(new MouseEvent("click"));', 'document.querySelector("#s").dispatchEvent(new Event("click"));', 'const el = document.body; el.click?.();', 'const f = document.forms[0]; f.requestSubmit?.();', 'const f = document.forms[0]; f["requestSubmit"]();', 'document.body["click"]();', 'HTMLFormElement.prototype.submit.call(document.forms[0]);', 'const f = document.forms[0]; const s = f.requestSubmit; s.call(f);', 'const b = document.body; const {click} = b; click.apply(b);']) {
    assert.ok(scanPageSource(body(b), { write: true }).forbidden.length > 0, b);
    assert.deepEqual(scanPageSource(body(b)).forbidden, [], `read tools are unaffected: ${b}`);
  }
  assert.deepEqual(scanPageSource(body('wm.fill("#a", "b");'), { write: true }).problems, []);
});

test("page write: fixture tool is clean, wrapper shows committed false on a dry run offline (capture)", async () => {
  const dir = installFixtureTool(home, "profile_page_write", site.url, "drafts", { as: "pg_w" });
  assert.deepEqual(staticChecks(dir), []);
  const cap = join(home, "cap.html");
  writeFileSync(cap, '<html><body><input id="name"></body></html>');
  const r = await runTool("pg_w", { name: "Ada" }, { draft: true, capture: cap });
  assert.deepEqual(r, { committed: false, possibleCommit: false, dryRun: true, marksReached: [], result: { committed: false } });
});

test("E4 (offline, real page): fill then handOff reports committed false until the user presses Save, then true", async () => {
  installFixtureTool(home, "profile_page_write", site.url, "drafts", { as: "pg_w" });
  const src = readFileSync(join(home, "drafts", "pg_w", "tool.mjs"), "utf8").replace("export default ", "").replace(/;\s*$/, "");
  const browser = await chromium.launch();
  try {
    const run = async (press) => {
      const page = await (await browser.newContext()).newPage();
      await page.goto(site.url + "/form");
      const before = await counter();
      const p = page.evaluate(composeEval(src, { name: "Ada", waitSec: press ? 10 : 1 }, readPageHelpers(), { dryRun: false }));
      p.catch(() => {});
      if (press) { await page.waitForFunction(() => document.querySelector("#name").value === "Ada"); await page.click("#save"); }
      return { r: await p, delta: (await counter()) - before };
    };
    const idle = await run(false);
    assert.deepEqual(idle.r, { ok: true, value: { value: { committed: false }, committed: false } });
    assert.equal(idle.delta, 0, "the tool alone never saves");
    const saved = await run(true);
    assert.deepEqual(saved.r, { ok: true, value: { value: { committed: true }, committed: true } });
    assert.equal(saved.delta, 1);
  } finally { await browser.close(); }
});

test("write fixes: commit() after the run was aborted throws and never runs fn", async () => {
  const { WriteState } = await import("../../dist/runtime/write.js");
  const ac = new AbortController();
  const st = new WriteState(false, ["m"]);
  st.signal = ac.signal;
  let ran = 0;
  await st.commit("m", () => { ran++; });
  ac.abort();
  await assert.rejects(() => st.commit("m", () => { ran++; }), /aborted/);
  assert.equal(ran, 1);
});

test("write fixes: handOff refuses an `until` that already matches (stale marker) instead of reporting committed", async () => {
  installFixtureTool(home, "profile_page_write", site.url, "drafts", { as: "pg_w" });
  const src = readFileSync(join(home, "drafts", "pg_w", "tool.mjs"), "utf8").replace("export default ", "").replace(/;\s*$/, "");
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(site.url + "/form");
    await page.evaluate(() => { const d = document.createElement("div"); d.className = "saved"; document.body.appendChild(d); });
    const r = await page.evaluate(composeEval(src, { name: "Ada", waitSec: 1 }, readPageHelpers(), { dryRun: false }));
    assert.equal(r.ok, false);
    assert.match(JSON.stringify(r), /already matches/);
  } finally { await browser.close(); }
});
