import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tempHome, rm } from "../helpers/index.mjs";

const home = tempHome("wm-unit-cap-");
process.env.WEBSITE_MCP_HOME = home;
const { NAME_RE, readManifest, homeDir } = await import("../../dist/runtime/load.js");
const { capResult, CAP_BYTES } = await import("../../dist/browser/snapshot.js");
const { MintSession, RESERVED_NAMES } = await import("../../dist/mint/session.js");
const { ToolNotFound } = await import("../../dist/runtime/errors.js");
after(() => rm(home));

test("WEBSITE_MCP_HOME is honoured", () => assert.equal(homeDir(), home));

test("name validation", () => {
  for (const ok of ["ab", "quotes_by_tag", "a1_b2"]) assert.ok(NAME_RE.test(ok), ok);
  for (const bad of ["a", "A", "1abc", "a-b", "../x", "a/b", "x".repeat(64), ""]) assert.ok(!NAME_RE.test(bad), bad);
  assert.throws(() => readManifest("../etc"), ToolNotFound);
});

test("reserved names cannot be minted", () => {
  const s = new MintSession();
  for (const n of RESERVED_NAMES) assert.throws(() => s.draftDir(n), /name must match/);
});

test("capResult passes small text through", () => {
  assert.equal(capResult("hello", "t"), "hello");
});

test("capResult truncates to the cap and spills the full text", () => {
  const big = "é".repeat(CAP_BYTES); // 2 bytes each, well over the cap
  const out = capResult(big, "my label!");
  assert.ok(Buffer.byteLength(out) <= CAP_BYTES, "output within cap");
  const m = /saved to (.+)\]/.exec(out);
  assert.ok(m, "pointer present");
  assert.ok(m[1].startsWith(join(home, "spill")));
  assert.equal(readFileSync(m[1], "utf8"), big);
  assert.ok(!out.includes("�"), "no split multibyte char");
  capResult(big, "my label!");
  assert.equal(readdirSync(join(home, "spill")).length, 2, "spill files are numbered, not overwritten");
});
