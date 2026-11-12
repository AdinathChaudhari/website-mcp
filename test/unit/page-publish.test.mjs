import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { tempHome, rm, FIXTURE_TOOLS } from "../helpers/index.mjs";

const home = tempHome("wm-unit-pagepub-");
process.env.WEBSITE_MCP_HOME = home;
const { publishDraft, staticChecks } = await import("../../dist/mint/publish.js");
const { hashSource, hashCases, parseCases, caseProblems, caseMode } = await import("../../dist/mint/tests.js");
const { liveCapFor, reserveLiveRun, liveRunsUsed, LIVE_CAP, LIVE_CAP_HARD } = await import("../../dist/mint/live.js");
const { PublishRefused, LiveCapReached } = await import("../../dist/runtime/errors.js");
const proto = await import("../../dist/bridge/protocol.js");
const { startHost } = await import("../../dist/bridge/host.js");
const { bridgeRequest } = await import("../../dist/bridge/client.js");
after(() => rm(home));

const O = "https://quotes.toscrape.com";
const SRC = readFileSync(join(FIXTURE_TOOLS, "quotes_page", "tool.mjs"), "utf8");
const manifest = (extra = {}) => ({ ...JSON.parse(readFileSync(join(FIXTURE_TOOLS, "quotes_page", "tool.json"), "utf8")), ...extra });
const cap = (n) => ({ name: `c${n}`, purpose: "p", input: {}, expect: "result", mode: "capture", capture: "1.html" });

function draft(name, { tool = manifest(), source = SRC, cases = [cap(1), cap(2), cap(3)], findings = [], signin } = {}) {
  const dir = join(home, "drafts", name);
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "tool.json"), JSON.stringify({ ...tool, name }));
  writeFileSync(join(dir, "tool.mjs"), source);
  writeFileSync(join(dir, "tests", "cases.json"), JSON.stringify(cases));
  if (signin) writeFileSync(join(dir, "signin.json"), JSON.stringify(signin));
  writeFileSync(join(dir, "review.json"), JSON.stringify({ verdict: "allow", findings, sourceHash: hashSource(dir), name, casesHash: hashCases(dir), reviewedAt: "2026-01-01T00:00:00.000Z" }));
  return dir;
}
/** A run the session would hold: all capture cases pass, plus optional live results. */
function run(dir, { capture = 3, failing = 0, live = 0 } = {}) {
  const results = [
    ...Array.from({ length: capture }, (_, i) => ({ name: `c${i}`, pass: i >= failing, ms: 1, mode: "capture", ...(i < failing ? { error: "boom" } : {}) })),
    ...Array.from({ length: live }, (_, i) => ({ name: `l${i}`, pass: true, ms: 1, mode: "live" })),
  ];
  return { ranAt: "2026-01-01T00:00:00.000Z", version: null, sourceHash: hashSource(dir), casesHash: hashCases(dir), results, passRate: 1 };
}
const refused = async (name, dir, opts) => {
  try { await publishDraft(name, dir, opts); } catch (e) { assert.ok(e instanceof PublishRefused); return e.details.map((r) => r.code); }
  assert.fail("expected a refusal");
};

test("proof rule: >=3 capture cases all passing AND >=1 live pass for this exact source", async () => {
  const dir = draft("proof_a");
  assert.deepEqual(await refused("proof_a", dir, { trustedRun: run(dir) }), ["live_proof"]);
  assert.deepEqual(await refused("proof_a", dir, { trustedRun: run(dir), liveProof: { sourceHash: "0".repeat(64) } }), ["live_proof"], "a live pass for other source does not count");
  assert.deepEqual(await refused("proof_a", dir, { trustedRun: run(dir, { failing: 1 }), liveProof: { sourceHash: hashSource(dir) } }), ["pass_rate"], "every capture case must pass (2 of 3 is not enough)");
  assert.deepEqual(await refused("proof_a", dir, { trustedRun: run(dir, { capture: 2 }), liveProof: { sourceHash: hashSource(dir) } }), ["too_few_cases"]);
  const ok = await publishDraft("proof_a", dir, { trustedRun: run(dir), liveProof: { sourceHash: hashSource(dir) } });
  assert.equal(ok.version, 1);
  assert.ok(existsSync(join(home, "tools", "proof_a", "tool.mjs")));
});
test("a live case that passed in the trusted run counts as the live pass", async () => {
  const dir = draft("proof_b", { cases: [cap(1), cap(2), cap(3), { name: "live1", purpose: "p", input: {}, expect: "result", mode: "live" }] });
  assert.equal((await publishDraft("proof_b", dir, { trustedRun: run(dir, { capture: 3, live: 1 }) })).version, 1);
});
test("fewer than 3 capture CASES is refused even with many live cases; a capture case must name its file", async () => {
  const live = (n) => ({ name: `l${n}`, purpose: "p", input: {}, expect: "result", mode: "live" });
  const dir = draft("proof_c", { cases: [cap(1), cap(2), live(1), live(2)] });
  assert.ok((await refused("proof_c", dir, {})).includes("too_few_cases"));
  const d2 = draft("proof_d", { cases: [cap(1), cap(2), { name: "nofile", purpose: "p", input: {}, expect: "result" }] });
  assert.ok((await refused("proof_d", d2, {})).includes("bad_cases"));
});
test("static gate: forbidden call, closure, bad block, signin outside the origin, hardTarget type", async () => {
  const d1 = draft("gate_a", { source: 'export default async ({ input, wm }) => { await fetch("/x"); return { quotes: [] }; };' });
  assert.ok((await refused("gate_a", d1, {})).includes("page_source"));
  const d2 = draft("gate_b", { source: "const k = 1;\nexport default async ({ input }) => ({ quotes: [k] });" });
  assert.ok((await refused("gate_b", d2, {})).includes("page_source"));
  const d3 = draft("gate_c", { signin: { marker: ".x", loginUrl: "https://elsewhere.test/login" } });
  assert.ok(staticChecks(d3).some((r) => r.code === "signin" && /allowedOrigins/.test(r.message)));
  assert.ok(staticChecks(draft("gate_d", { tool: manifest({ hardTarget: "yes" }) })).some((r) => /hardTarget/.test(r.message)));
  assert.ok(staticChecks(draft("gate_e", { tool: manifest({ kind: "browser" }) })).some((r) => /for kind "page" only|page/.test(r.message)));
  assert.ok(staticChecks(draft("gate_f", { tool: manifest({ kind: "teleport" }) })).some((r) => /kind must be/.test(r.message)));
  assert.deepEqual(staticChecks(draft("gate_ok", { signin: { marker: "a.x", loginUrl: `${O}/login` } })), []);
});
test("signin.json is part of the source hash (editing it changes what must be re-reviewed/approved)", () => {
  const dir = draft("hash_a");
  const h = hashSource(dir);
  writeFileSync(join(dir, "signin.json"), JSON.stringify({ marker: "a", loginUrl: `${O}/l` }));
  assert.notEqual(hashSource(dir), h);
});
test("case rules per kind", () => {
  assert.throws(() => parseCases([{ name: "a", purpose: "p", input: {}, expect: "result", mode: "weird" }]), /mode/);
  assert.throws(() => parseCases([{ name: "a", purpose: "p", input: {}, expect: "result", capture: "../x.html" }]), /capture/);
  assert.throws(() => parseCases([{ name: "a", purpose: "p", input: {}, expect: "result", mode: "live", capture: "1.html" }]), /live case/);
  assert.equal(caseMode({ expect: "result" }, "page"), "capture");
  assert.equal(caseMode({ expect: "result" }, "browser"), "live");
  assert.ok(caseProblems([cap(1)], "browser").length);
  assert.deepEqual(caseProblems([cap(1)], "page"), []);
});
test("live budget: 4 per mint, 2 for a hardTarget, counted on disk, refused beyond", () => {
  assert.equal(LIVE_CAP, 4);
  assert.equal(LIVE_CAP_HARD, 2);
  assert.equal(liveCapFor({}), 4);
  assert.equal(liveCapFor({ hardTarget: true }), 2);
  const dir = join(home, "drafts", "budget");
  for (let i = 1; i <= 4; i++) assert.equal(reserveLiveRun(dir, 4), i);
  assert.throws(() => reserveLiveRun(dir, 4), LiveCapReached);
  assert.equal(liveRunsUsed(dir), 4);
  writeFileSync(join(dir, "live-runs.json"), "garbage");
  assert.throws(() => reserveLiveRun(dir, 4), LiveCapReached, "an unreadable counter fails closed");
});
test("host: a protocol-1 extension may list tabs but never run/explore/capture; a newer one is told to update website-mcp", async () => {
  const sock = join(home, "b1.sock");
  const mk = (version) => {
    const toHost = new PassThrough();
    const fromHost = new PassThrough();
    const dec = new proto.FrameDecoder();
    fromHost.on("data", (c) => { for (const m of dec.push(c)) if (m.type !== "hello") toHost.write(proto.encodeFrame(proto.okResult(m.id, [{ id: 1 }]))); });
    toHost.write(proto.encodeFrame({ type: "hello", version, extVersion: "0.0.1" }));
    return { toHost, fromHost };
  };
  const old = mk(1);
  const h = await startHost({ input: old.toHost, output: old.fromHost, sock, logFile: null });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(await bridgeRequest({ type: "tabs" }, { sock }), [{ id: 1 }]);
  for (const req of [{ type: "run", toolName: "t" }, { type: "explore", tabId: 1, code: "1", timeoutMs: 1 }, { type: "capture", tabId: 1 }, { type: "snapshot", tabId: 1 }]) {
    await assert.rejects(bridgeRequest(req, { sock }), (e) => e.code === "PROTOCOL_MISMATCH" && /out of date.*chrome:\/\/extensions/.test(e.message), req.type);
  }
  await h.close();
  const newer = mk(3);
  const h2 = await startHost({ input: newer.toHost, output: newer.fromHost, sock, logFile: null });
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(bridgeRequest({ type: "tabs" }, { sock }), (e) => e.code === "PROTOCOL_MISMATCH" && /update website-mcp/.test(e.message));
  await h2.close();
});
test("explain(): approval and sign-in errors tell the user what to do", async () => {
  const { explain } = await import("../../dist/runtime/runners/page.js");
  const { BridgeError } = await import("../../dist/runtime/errors.js");
  const a = explain(new BridgeError("NEEDS_APPROVAL", "x"), "my_tool", 3, "ab".repeat(32));
  assert.equal(a.code, "NEEDS_APPROVAL");
  assert.match(a.message, /my_tool v3 \(hash abababababab\).*popup.*Approve/);
  assert.deepEqual(a.details, { toolName: "my_tool", version: 3, hash: "ab".repeat(32) });
  const s = explain(new BridgeError("SIGNED_OUT", "x"), "my_tool", 3, "h", "https://x.test/login");
  assert.match(s.message, /https:\/\/x\.test\/login/);
  const other = new BridgeError("NO_TAB", "keep me");
  assert.equal(explain(other, "t", 1, "h"), other);
});
