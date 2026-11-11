import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome, rm } from "../helpers/index.mjs";

const home = tempHome("wm-unit-pub-");
process.env.WEBSITE_MCP_HOME = home;
const { scanSecrets, offOriginUrls, staticChecks, publishDraft } = await import("../../dist/mint/publish.js");
const { mainList, parseCases, hashSource, hashCases, MIN_CASES, MIN_PASS_RATE, meetsBar } = await import("../../dist/mint/tests.js");
const { PublishRefused } = await import("../../dist/runtime/errors.js");
const { MintSession } = await import("../../dist/mint/session.js");
after(() => rm(home));

const ORIGIN = "http://127.0.0.1:9";
const manifest = (extra = {}) => ({
  name: "demo", description: "d", effect: "read", kind: "browser",
  site: { allowedOrigins: [ORIGIN] },
  input: { type: "object", properties: {}, additionalProperties: false },
  output: { type: "object", properties: { items: { type: "array" } }, required: ["items"] },
  ...extra,
});
const SRC = `export default async ({ page }) => { await page.goto("${ORIGIN}/"); return { items: [] }; };\n`;
const cases = (n) => Array.from({ length: n }, (_, i) => ({ name: `c${i}`, purpose: "p", input: {}, expect: "result" }));

function draft(name, { tool = manifest(), source = SRC, cs = cases(3) } = {}) {
  const dir = join(home, "drafts", name);
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "tool.json"), JSON.stringify(tool));
  writeFileSync(join(dir, "tool.mjs"), source);
  if (cs) writeFileSync(join(dir, "tests", "cases.json"), JSON.stringify(cs));
  return dir;
}
/** Pretend the draft was tested: write a last-run whose hashes match, so publish does not launch a browser. */
function fakeRun(dir, passed, total) {
  const results = Array.from({ length: total }, (_, i) => ({ name: `c${i}`, pass: i < passed, ms: 1, ...(i < passed ? {} : { error: "boom" }) }));
  const run = { ranAt: new Date().toISOString(), version: null, sourceHash: hashSource(dir), casesHash: hashCases(dir), results, passRate: passed / total };
  writeFileSync(join(dir, "tests", "last-run.json"), JSON.stringify(run)); // on disk: must be ignored by publish
  return run; // in memory: what a MintSession would hold, passed as trustedRun
}
const reasonsOf = async (name, dir, opts) => {
  try { await publishDraft(name, dir, opts); } catch (e) { assert.ok(e instanceof PublishRefused); assert.equal(e.code, "publish_refused"); return e.details; }
  assert.fail("expected a refusal");
};
const codes = (rs) => rs.map((r) => r.code);

test("scanSecrets flags provider shapes and high-entropy tokens", () => {
  assert.deepEqual(scanSecrets("const k = 'sk-abcdefghijklmnopqrstuv';"), ["API key (sk-…)"]);
  assert.ok(scanSecrets("AKIAABCDEFGHIJKLMNOP").length);
  assert.ok(scanSecrets("ghp_" + "a1B2".repeat(10)).length);
  assert.ok(scanSecrets("xoxb-1234567890-abcdef").length);
  assert.ok(scanSecrets("-----BEGIN RSA PRIVATE KEY-----").length);
  assert.ok(scanSecrets(`const t = "${"aZ3kP9qL2mX7vB4nR8tY1wC5eH6jD0fG"}";`).includes("high-entropy token literal"));
});
test("scanSecrets leaves ordinary code alone", () => {
  assert.deepEqual(scanSecrets(SRC), []);
  assert.deepEqual(scanSecrets('const u = "https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";'), []);
  assert.deepEqual(scanSecrets('const s = "the-quick-brown-fox-jumps-over-the-lazy-dog";'), []);
});

test("offOriginUrls finds URLs outside allowedOrigins", () => {
  assert.deepEqual(offOriginUrls(`goto("${ORIGIN}/a"); goto("https://evil.example/x")`, [ORIGIN]), ["https://evil.example"]);
  assert.deepEqual(offOriginUrls("goto(`" + ORIGIN + "/q=${x}`)", [ORIGIN]), []);
  assert.deepEqual(offOriginUrls("no urls", [ORIGIN]), []);
});

test("empty rule: mainList", () => {
  assert.deepEqual(mainList({ items: [1] }), { list: [1] });
  assert.deepEqual(mainList({ n: 1, rows: [] }), { list: [] });
  assert.deepEqual(mainList([1, 2]), { list: [1, 2] });
  assert.deepEqual(mainList({ n: 1 }), {});
  assert.deepEqual(mainList({ data: { items: [1] } }, "data.items"), { list: [1] });
  assert.match(mainList({ items: [1] }, "nope").error, /resultsPath/);
});

test("parseCases validates shape", () => {
  assert.equal(parseCases(cases(2)).length, 2);
  assert.throws(() => parseCases({}), /array/);
  assert.throws(() => parseCases([{ name: "a", purpose: "p", input: {}, expect: "nope" }]), /expect/);
  assert.throws(() => parseCases([{ name: "a", purpose: "p", expect: "result" }]), /input/);
  assert.throws(() => parseCases([...cases(1), ...cases(1)]), /duplicated/);
});

test("bar constants", () => {
  assert.equal(MIN_CASES, 3);
  assert.equal(MIN_PASS_RATE, 0.7);
  assert.ok(meetsBar({ results: [1, 2, 3], passRate: 0.7 }));
  assert.ok(!meetsBar({ results: [1, 2], passRate: 1 }));
  assert.ok(!meetsBar({ results: [1, 2, 3], passRate: 0.69 }));
});

test("refuses with no or too few cases", async () => {
  assert.ok(codes(await reasonsOf("nocases", draft("nocases", { cs: null }))).includes("too_few_cases"));
  assert.ok(codes(await reasonsOf("two", draft("two", { cs: cases(2) }))).includes("too_few_cases"));
});
test("refuses on schema and manifest errors", async () => {
  const bad = manifest({ input: { type: "nonsense" } });
  assert.ok(codes(await reasonsOf("badschema", draft("badschema", { tool: bad }))).includes("bad_schema"));
  const noOrigin = manifest({ site: { allowedOrigins: [] } });
  assert.ok(codes(await reasonsOf("noorigin", draft("noorigin", { tool: noOrigin }))).some((c) => c === "origin" || c === "bad_manifest"));
});
test("refuses on a syntax error", async () => {
  assert.ok(codes(await reasonsOf("syn", draft("syn", { source: "export default async ( => {" }))).includes("bad_source"));
});
test("refuses on an off-origin URL literal", async () => {
  const rs = await reasonsOf("offo", draft("offo", { source: SRC + '// https://evil.example/x\n' }));
  assert.ok(codes(rs).includes("origin"));
});
test("refuses on a secret-shaped literal", async () => {
  const rs = await reasonsOf("sec", draft("sec", { source: SRC + 'const k = "sk-abcdefghijklmnopqrstuvwx";\n' }));
  assert.ok(codes(rs).includes("secret"));
});
test("refuses below 70% and names the failing cases", async () => {
  const dir = draft("low", { cs: cases(4) });
  const rs = await reasonsOf("low", dir, { trustedRun: fakeRun(dir, 2, 4) });
  const r = rs.find((x) => x.code === "pass_rate");
  assert.deepEqual(r.cases, ["c2", "c3"]);
  assert.match(r.message, /50%/);
  assert.ok(!existsSync(join(home, "tools", "low")), "nothing published");
});

test("publishes at the bar, bumps version, keeps history", async () => {
  const dir = draft("ok", { cs: cases(10) });
  const r1 = await publishDraft("ok", dir, { trustedRun: fakeRun(dir, 7, 10) }); // exactly 70%
  assert.equal(r1.version, 1);
  const pub = join(home, "tools", "ok");
  for (const f of ["tool.json", "tool.mjs", "README.md", "tests/cases.json", "tests/last-run.json"]) assert.ok(existsSync(join(pub, f)), f);
  assert.equal(JSON.parse(readFileSync(join(pub, "tool.json"), "utf8")).version, 1);
  assert.equal(JSON.parse(readFileSync(join(pub, "tests", "last-run.json"), "utf8")).version, 1);

  writeFileSync(join(dir, "tool.json"), JSON.stringify(manifest({ description: "v2" })));
  const r2 = await publishDraft("ok", dir, { trustedRun: fakeRun(dir, 10, 10) });
  assert.equal(r2.version, 2);
  assert.equal(r2.previous, 1);
  assert.equal(JSON.parse(readFileSync(join(pub, "tool.json"), "utf8")).description, "v2");
  assert.equal(JSON.parse(readFileSync(join(pub, ".history", "1", "tool.json"), "utf8")).version, 1);

  writeFileSync(join(dir, "tool.json"), JSON.stringify(manifest({ description: "v3" })));
  await publishDraft("ok", dir, { trustedRun: fakeRun(dir, 10, 10) });
  assert.deepEqual(readdirSync(join(pub, ".history")).sort(), ["1", "2"]);
  assert.ok(!readdirSync(join(home, "tools")).some((f) => f.startsWith(".stage")), "no stage dir left");
});

test("MintSession.onPublished fires after a successful publish", async () => {
  const seen = [];
  const s = new MintSession({ onPublished: (n, v) => seen.push([n, v]) });
  // Real run, no navigation: needs a browser but no network.
  const dir = draft("hook", { source: "export default async () => ({ items: [] });\n", cs: cases(3).map((c) => ({ ...c, expect: "empty" })) });
  await s.testDraft("hook");
  assert.ok(existsSync(join(dir, "tests", "last-run.json")));
  await s.publish("hook");
  assert.deepEqual(seen, [["hook", 1]]);
});

const BROKEN = 'export default async () => { throw new Error("broken"); };\n';
test("a forged tests/last-run.json on disk is ignored: the cases re-run and refuse", async () => {
  const dir = draft("forged", { source: BROKEN });
  fakeRun(dir, 3, 3); // forged: hashes match, 100% pass
  const rs = await reasonsOf("forged", dir); // no trustedRun
  assert.ok(codes(rs).includes("pass_rate"));
  assert.ok(!existsSync(join(home, "tools", "forged")));
});
test("a stale trusted run (source or cases edited after it) is re-run and refuses", async () => {
  const dir = draft("stale", { source: BROKEN.replace("broken", "x") });
  const run = fakeRun(dir, 3, 3);
  writeFileSync(join(dir, "tool.mjs"), BROKEN + "// edited after the run\n");
  assert.ok(codes(await reasonsOf("stale", dir, { trustedRun: run })).includes("pass_rate"), "source edit");
  const dir2 = draft("stale2", { source: BROKEN });
  const run2 = fakeRun(dir2, 3, 3);
  writeFileSync(join(dir2, "tests", "cases.json"), JSON.stringify(cases(4)));
  assert.ok(codes(await reasonsOf("stale2", dir2, { trustedRun: run2 })).includes("pass_rate"), "cases edit");
  assert.ok(!existsSync(join(home, "tools", "stale")) && !existsSync(join(home, "tools", "stale2")));
});
test("publish leaves no stage dir behind", () => {
  assert.ok(!readdirSync(home).some((f) => f.startsWith(".publish-")));
});
test("bad name, tool or cases throw InvalidInput (code invalid_input)", () => {
  const s = new MintSession();
  const code = (f) => { try { f(); } catch (e) { return e.code; } return "none"; };
  assert.equal(code(() => s.saveDraft("Bad Name", {}, "export default 1")), "invalid_input");
  assert.equal(code(() => s.saveDraft("fine_name", [], "export default 1")), "invalid_input");
  assert.equal(code(() => s.saveDraft("fine_name", {}, "nope")), "invalid_input");
  assert.equal(code(() => s.saveCases("fine_name", {})), "invalid_input");
});

test("staticChecks reports a missing draft", () => {
  assert.equal(staticChecks(join(home, "drafts", "ghost"))[0].code, "no_draft");
});
