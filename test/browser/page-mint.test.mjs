// A "minter" with no model mints a PAGE tool through the real MCP server, against a fake extension on the real bridge host.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, appendFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { FIXTURE_TOOLS, startMcp, tempHome, rm } from "../helpers/index.mjs";

const proto = await import("../../dist/bridge/protocol.js");
const { startHost } = await import("../../dist/bridge/host.js");

const O = "https://quotes.toscrape.com";
const CAPS = join(FIXTURE_TOOLS, "quotes_page", "tests", "captures");
const fixtureSource = readFileSync(join(FIXTURE_TOOLS, "quotes_page", "tool.mjs"), "utf8");
const fixtureTool = () => {
  const m = JSON.parse(readFileSync(join(FIXTURE_TOOLS, "quotes_page", "tool.json"), "utf8"));
  delete m.name;
  return m;
};

let home, mcp, host, seen, state;
const approved = new Set();

/** The extension side, faked: tabs, explore window, capture, snapshot, explore, run with per-hash approval. */
function fakeExtension() {
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  const dec = new proto.FrameDecoder();
  const send = (m) => toHost.write(proto.encodeFrame(m));
  fromHost.on("data", (c) => {
    for (const m of dec.push(c)) {
      if (m.type === "hello") continue;
      seen.push(m);
      const ok = (v) => send(proto.okResult(m.id, v));
      const err = (code, msg) => send(proto.errResult(m.id, code, msg));
      if (m.type === "tabs") ok([{ id: 5, url: `${O}/`, title: "Quotes", active: true, granted: true, explore: state.explore }, { id: 9, url: "https://other.test/", title: "Other", active: false, granted: false, explore: false }]);
      else if (state.exploreChallenge && ["snapshot", "explore", "capture"].includes(m.type)) err("CHALLENGE", "The page shows a challenge or block (captcha on the page); the run stopped and will not retry");
      else if (m.type === "snapshot") ok("- row: " + "x".repeat(40000));
      else if (m.type === "explore") ok({ n: 3 });
      else if (m.type === "capture") ok({ url: `${O}/`, title: "Quotes", html: readFileSync(join(CAPS, state.captureFile), "utf8") });
      else if (m.type === "run") {
        if (m.draft && !state.explore) return err("EXPLORE_OFF", "explore window closed");
        if (state.challenge) return err("CHALLENGE", "The page shows a challenge or block (captcha on the page); the run stopped and will not retry");
        if (!m.draft && !approved.has(m.hash)) return err("NEEDS_APPROVAL", "not approved");
        ok({ quotes: [{ text: "t", author: "a" }] });
      }
    }
  });
  send({ type: "hello", version: proto.PROTOCOL_VERSION, extVersion: "9.9.9" });
  return { toHost, fromHost };
}

before(async () => {
  home = tempHome("wm-pagemint-");
  seen = [];
  state = { explore: false, captureFile: "1.html" };
  const peer = fakeExtension();
  host = await startHost({ input: peer.toHost, output: peer.fromHost, sock: join(home, "bridge.sock"), logFile: null });
  mcp = await startMcp(home);
});
after(async () => {
  await mcp?.close();
  await host?.close();
  rm(home);
});
const reasons = (r) => (r.v.error?.reasons ?? []).map((x) => x.code);

test("protocol: version 2, new error codes", () => {
  assert.equal(proto.PROTOCOL_VERSION, 2);
  for (const c of ["NEEDS_APPROVAL", "SIGNED_OUT", "EXPLORE_OFF"]) assert.ok(proto.BRIDGE_ERROR_CODES.includes(c));
});

test("page_tabs lists tabs; explore/snapshot/capture are refused while the explore window is off, and nothing is sent", async () => {
  const t = await mcp.call("page_tabs");
  assert.deepEqual(t.v.map((x) => [x.id, x.granted, x.explore]), [[5, true, false], [9, false, false]]);
  for (const [tool, args] of [["page_snapshot", { tabId: 5 }], ["page_explore", { tabId: 5, code: "return 1" }], ["page_capture", { tabId: 5, name: "quotes_page" }]]) {
    const r = await mcp.call(tool, args);
    assert.equal(r.isError, true);
    assert.equal(r.v.error.code, "EXPLORE_OFF", tool);
    assert.match(r.v.error.message, /popup/);
  }
  assert.deepEqual(seen.filter((m) => ["snapshot", "explore", "capture"].includes(m.type)), [], "refused before anything reached the extension");
  assert.equal((await mcp.call("page_explore", { tabId: 9, code: "return 1" })).v.error.code, "SITE_NOT_GRANTED");
  assert.equal((await mcp.call("page_explore", { tabId: 77, code: "return 1" })).v.error.code, "NO_TAB");
  assert.equal((await mcp.call("page_explore", { tabId: 5, code: "" })).v.error.code, "invalid_input");
});

test("explore window on: snapshot is capped at 16 KiB, explore returns data, capture saves files (dir 700, files 600)", async () => {
  state.explore = true;
  const snap = await mcp.call("page_snapshot", { tabId: 5 });
  assert.ok(Buffer.byteLength(typeof snap.v === "string" ? snap.v : JSON.stringify(snap.v)) <= 16 * 1024 + 8);
  assert.match(JSON.stringify(snap.v), /truncated/);
  assert.deepEqual((await mcp.call("page_explore", { tabId: 5, code: "return 3" })).v, { n: 3 });
  const c1 = await mcp.call("page_capture", { tabId: 5, name: "quotes_page" });
  assert.equal(c1.v.capture, "1.html");
  state.captureFile = "2.html";
  assert.equal((await mcp.call("page_capture", { tabId: 5, name: "quotes_page" })).v.capture, "2.html");
  const dir = join(home, "drafts", "quotes_page", "captures");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(dir).sort(), ["1.html", "1.json", "2.html", "2.json"]);
  state.captureFile = "3.html";
  assert.equal((await mcp.call("page_capture", { tabId: 5, name: "quotes_page" })).v.capture, "3.html");
  state.captureFile = "1.html";
  for (const f of readdirSync(dir)) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
  assert.equal(JSON.parse(readFileSync(join(dir, "1.json"), "utf8")).url, `${O}/`);
  assert.equal((await mcp.call("page_capture", { tabId: 5, name: "../evil" })).v.error.code, "invalid_input");
});

let hash;
test("mint a page tool: save, cases, capture test, then publish needs the review and a live pass", async () => {
  const signin = { marker: "a.signout", loginUrl: `${O}/login` };
  const saved = await mcp.call("save_tool", { name: "quotes_page", tool: fixtureTool(), source: fixtureSource, signin });
  assert.equal(saved.isError, false);
  assert.deepEqual(saved.v.problems, [], JSON.stringify(saved.v));
  hash = saved.v.sourceHash;
  assert.ok(existsSync(join(home, "drafts", "quotes_page", "signin.json")));
  const cases = JSON.parse(readFileSync(join(FIXTURE_TOOLS, "quotes_page", "tests", "cases.json"), "utf8"));
  assert.equal((await mcp.call("save_cases", { name: "quotes_page", cases })).v.cases, 5);
  const t = await mcp.call("test_tool", { name: "quotes_page" });
  assert.equal(t.v.passRate, 1, JSON.stringify(t.v));
  assert.equal(t.v.liveRuns, 0);
  assert.equal((await mcp.call("submit_review", { name: "quotes_page", verdict: "allow", findings: ["read-only DOM scrape"], sourceHash: hash })).v.current, true);
  const early = await mcp.call("publish_tool", { name: "quotes_page" });
  assert.equal(early.isError, true);
  assert.deepEqual(reasons(early), ["live_proof"]);
});

test("one live run (run_tool draft:true) is sent with draft + signin, is counted, and unlocks publish", async () => {
  const r = await mcp.call("run_tool", { name: "quotes_page", input: {}, draft: true });
  assert.equal(r.isError, false, JSON.stringify(r.v));
  const run = seen.filter((m) => m.type === "run").at(-1);
  assert.equal(run.draft, true);
  assert.deepEqual(run.signin, { marker: "a.signout", loginUrl: `${O}/login` });
  assert.match(run.hash, /^[0-9a-f]{64}$/); // the run hash (code + scope), not the draft source hash
  assert.equal(JSON.parse(readFileSync(join(home, "drafts", "quotes_page", "live-runs.json"), "utf8")).count, 1);
  const pub = await mcp.call("publish_tool", { name: "quotes_page" });
  assert.equal(pub.isError, false, JSON.stringify(pub.v));
  assert.equal(pub.v.version, 1);
  const files = readdirSync(join(home, "tools", "quotes_page")).sort();
  assert.deepEqual(files, ["README.md", "review.json", "signin.json", "tests", "tool.json", "tool.mjs"]);
  assert.ok(!existsSync(join(home, "tools", "quotes_page", "captures")), "real captures are not copied into the published tool");
});

test("published run: NEEDS_APPROVAL (message points at the popup) until that exact hash is approved; a hand edit asks again", async () => {
  const first = await mcp.call("run_tool", { name: "quotes_page", input: {} });
  assert.equal(first.isError, true);
  assert.equal(first.v.error.code, "NEEDS_APPROVAL");
  assert.match(first.v.error.message, /popup/);
  assert.match(first.v.error.message, /quotes_page v1/);
  const sent = seen.filter((m) => m.type === "run").at(-1);
  assert.equal(sent.toolName, "quotes_page");
  assert.equal(sent.version, 1);
  assert.equal(sent.draft, undefined);
  assert.match(sent.hash, /^[0-9a-f]{64}$/);
  approved.add(sent.hash);
  const ok = await mcp.call("quotes_page", {});
  assert.equal(ok.isError, false, JSON.stringify(ok.v));
  assert.deepEqual(ok.v, { quotes: [{ text: "t", author: "a" }] });
  const tp = join(home, "tools", "quotes_page", "tool.mjs");
  writeFileSync(tp, readFileSync(tp, "utf8").replace("return", "const edited = 1; return")); // a change to the code that runs
  const again = await mcp.call("run_tool", { name: "quotes_page", input: {} });
  assert.equal(again.v.error.code, "NEEDS_APPROVAL");
  assert.notEqual(seen.filter((m) => m.type === "run").at(-1).hash, sent.hash);
});

test("live cap: a hardTarget mint gets 2 live runs, the third is refused before touching the site", async () => {
  const tool = { ...fixtureTool(), hardTarget: true };
  assert.equal((await mcp.call("save_tool", { name: "hard_page", tool, source: fixtureSource })).isError, false);
  const runs = () => seen.filter((m) => m.type === "run" && m.toolName === "hard_page").length;
  assert.equal((await mcp.call("run_tool", { name: "hard_page", input: {}, draft: true })).isError, false);
  assert.equal((await mcp.call("run_tool", { name: "hard_page", input: {}, draft: true })).isError, false);
  const third = await mcp.call("run_tool", { name: "hard_page", input: {}, draft: true });
  assert.equal(third.v.error.code, "live_cap");
  assert.match(third.v.error.message, /2 per mint/);
  assert.equal(runs(), 2);
  // re-saving does not hand out a fresh budget
  await mcp.call("save_tool", { name: "hard_page", tool, source: fixtureSource + "\n// v2\n" });
  assert.equal((await mcp.call("run_tool", { name: "hard_page", input: {}, draft: true })).v.error.code, "live_cap");
});

test("the gate refuses a page tool that fetches, closes over a helper, or asks for MAIN without a reviewer note", async () => {
  const bad = `const helper = () => 1;\nexport default async ({ input, wm }) => { const r = await fetch("/x"); return { quotes: [helper()] }; };`;
  const s = await mcp.call("save_tool", { name: "bad_page", tool: fixtureTool(), source: bad });
  assert.ok(s.v.problems.some((p) => /forbidden in a page tool: fetch/.test(p)), JSON.stringify(s.v.problems));
  assert.ok(s.v.problems.some((p) => /top-level/.test(p)));
  const mainTool = { ...fixtureTool(), page: { urlPattern: "/*", world: "MAIN", tab: "existing" } };
  const m = await mcp.call("save_tool", { name: "main_page", tool: mainTool, source: fixtureSource });
  assert.deepEqual(m.v.problems, []);
  const cases = JSON.parse(readFileSync(join(FIXTURE_TOOLS, "quotes_page", "tests", "cases.json"), "utf8"));
  await mcp.call("save_cases", { name: "main_page", cases: cases.filter((c) => c.expect !== "signed_out") }); // main_page has no signin.json
  // main_page has no captures of its own: reuse quotes_page's through a copy
  const { cpSync } = await import("node:fs");
  cpSync(join(home, "drafts", "quotes_page", "captures"), join(home, "drafts", "main_page", "captures"), { recursive: true });
  assert.equal((await mcp.call("test_tool", { name: "main_page" })).v.passRate, 1);
  await mcp.call("submit_review", { name: "main_page", verdict: "allow", findings: ["fine"], sourceHash: m.v.sourceHash });
  await mcp.call("run_tool", { name: "main_page", input: {}, draft: true });
  assert.deepEqual(reasons(await mcp.call("publish_tool", { name: "main_page" })), ["review_main"]);
  await mcp.call("submit_review", { name: "main_page", verdict: "allow", findings: [{ severity: "warn", message: "world MAIN is needed because the data lives on a page-global" }], sourceHash: m.v.sourceHash });
  const pub = await mcp.call("publish_tool", { name: "main_page" });
  assert.equal(pub.isError, false, JSON.stringify(pub.v));
});

test("minIntervalSec: a published tool refuses a run that comes too soon (TOO_SOON), before the tab is touched", async () => {
  const { cpSync } = await import("node:fs");
  const dir = join(home, "tools", "paced_page");
  cpSync(join(FIXTURE_TOOLS, "quotes_page"), dir, { recursive: true });
  writeFileSync(join(dir, "tool.json"), JSON.stringify({ ...fixtureTool(), name: "paced_page", version: 1, minIntervalSec: 3600 }));
  const runs = () => seen.filter((m) => m.type === "run" && m.toolName === "paced_page").length;
  const first = await mcp.call("run_tool", { name: "paced_page", input: {} });
  assert.equal(first.v.error?.code, "NEEDS_APPROVAL"); // reached the tab: approval is the extension's gate
  approved.add(seen.filter((m) => m.type === "run").at(-1).hash);
  assert.equal((await mcp.call("run_tool", { name: "paced_page", input: {} })).isError, false);
  assert.equal(runs(), 2);
  const again = await mcp.call("run_tool", { name: "paced_page", input: {} });
  assert.equal(again.v.error.code, "TOO_SOON");
  assert.match(again.v.error.message, /Try again in \d+s/);
  assert.equal(runs(), 2, "the second run never reached the extension");
});

test("CHALLENGE stops the mint: the run fails, nothing retries, and no further live run touches the site", async () => {
  const tool = { ...fixtureTool(), hardTarget: true, minIntervalSec: 60 };
  await mcp.call("save_tool", { name: "chal_page", tool, source: fixtureSource });
  const runs = () => seen.filter((m) => m.type === "run" && m.toolName === "chal_page").length;
  state.challenge = true;
  try {
    const first = await mcp.call("run_tool", { name: "chal_page", input: {}, draft: true });
    assert.equal(first.v.error.code, "CHALLENGE");
    assert.match(first.v.error.message, /nothing was retried/);
    assert.equal(runs(), 1, "one attempt, no retry");
    state.challenge = false; // even if the page now looks fine, the mint is stopped
    const second = await mcp.call("run_tool", { name: "chal_page", input: {}, draft: true });
    assert.equal(second.v.error.code, "CHALLENGE");
    assert.match(second.v.error.message, /fresh mint/);
    assert.equal(runs(), 1, "the second live run was refused before touching the site");
    const t = await mcp.call("test_tool", { name: "chal_page" });
    assert.equal(runs(), 1);
    assert.ok(t);
  } finally {
    state.challenge = false;
  }
});

test("a CHALLENGE on the explore path stops further exploring of that site this session, and marks the draft", async () => {
  state.explore = true;
  state.exploreChallenge = true;
  const sent = () => seen.filter((m) => ["snapshot", "explore", "capture"].includes(m.type)).length;
  const before = sent();
  const first = await mcp.call("page_capture", { tabId: 5, name: "chal_cap" });
  assert.equal(first.v.error.code, "CHALLENGE");
  assert.equal(sent(), before + 1);
  state.exploreChallenge = false; // page looks fine now: still refused, nothing sent
  const second = await mcp.call("page_explore", { tabId: 5, code: "return 1" });
  assert.equal(second.v.error.code, "CHALLENGE");
  assert.equal(sent(), before + 1, "refused before anything was sent");
  assert.ok(existsSync(join(home, "drafts", "chal_cap", "challenge.json")), "the draft is marked challenged");
});
