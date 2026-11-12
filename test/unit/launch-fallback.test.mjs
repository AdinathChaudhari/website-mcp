import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../helpers/index.mjs";

// A copied plugin folder (what a git marketplace install gets): no dist/ next to it.
const tmp = mkdtempSync(join(tmpdir(), "wm-launch-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const copy = join(tmp, "cache", "plugin");
cpSync(join(ROOT, "plugin"), copy, { recursive: true, dereference: true });
const bin = join(tmp, "bin");
mkdirSync(bin);
// Fake npx: records its arguments instead of touching the network.
writeFileSync(join(bin, "npx"), '#!/bin/sh\necho "FAKE-NPX $@"\n');
chmodSync(join(bin, "npx"), 0o755);
const version = JSON.parse(readFileSync(join(ROOT, "plugin", ".claude-plugin", "plugin.json"), "utf8")).version;

const run = (env) =>
  spawnSync(process.execPath, [join(copy, "launch.mjs")], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, ...env },
  });

test("without the opt-in flag a copied plugin keeps the loud error and never runs npx", () => {
  const r = run({});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot find the built server/);
  assert.match(r.stderr, /WEBSITE_MCP_ALLOW_NPX=1/, "the error names the opt-in");
  assert.doesNotMatch(r.stdout, /FAKE-NPX/);
});

test("WEBSITE_MCP_ALLOW_NPX=1 falls back to npx at the pinned plugin version", () => {
  const r = run({ WEBSITE_MCP_ALLOW_NPX: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`FAKE-NPX -y website-mcp@${version.replaceAll(".", "\\.")} serve`));
});

test("only the exact value 1 opts in", () => {
  for (const v of ["0", "", "true"]) assert.equal(run({ WEBSITE_MCP_ALLOW_NPX: v }).status, 1, v);
});
