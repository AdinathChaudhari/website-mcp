import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

test("LICENSE is MIT and matches package.json", () => {
  assert.match(read("LICENSE"), /^MIT License\n\nCopyright \(c\) \d{4} website-mcp contributors/);
  assert.equal(JSON.parse(read("package.json")).license, "MIT");
});

test("npm pack ships only the allowlisted paths", () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8" });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  for (const must of ["LICENSE", "README.md", "package.json", "dist/cli.js", "authoring/core.md", "extension/manifest.json", "docs/safety.md"]) assert.ok(files.includes(must), `missing ${must}`);
  const bad = files.filter((f) => /^(test|src|docs\/(research|runs|01-planning)|\.github)\//.test(f) || f === "docs/STATUS.md");
  assert.deepEqual(bad, []);
});

test("extension key and permissions are unchanged", () => {
  const m = JSON.parse(read("extension/manifest.json"));
  assert.deepEqual([...m.permissions].sort(), ["activeTab", "alarms", "nativeMessaging", "storage", "userScripts"]);
  assert.ok(typeof m.key === "string" && m.key.length > 100);
});

test("model seam file is interfaces only and docs exist", () => {
  const src = read("src/mint/minter.ts");
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.match(src, /export interface ChatModel/);
  assert.match(src, /export interface Reviewer/);
  for (const d of ["docs/model-seam.md", "docs/prior-art.md"]) assert.ok(existsSync(join(ROOT, d)), d);
});

test("README opens with the house metadata comment and carries no local paths", () => {
  const r = read("README.md");
  assert.match(r, /^<!--\nGitHub metadata[\s\S]*?About:[\s\S]*?Topics/);
  for (const f of ["README.md", "CHANGELOG.md", "docs/safety.md", "docs/model-seam.md", "docs/prior-art.md"]) assert.doesNotMatch(read(f), /\/Users\/|\/home\/[a-z]/);
});

test("plugin version equals package version (launch.mjs pins npx website-mcp@<plugin version>)", () => {
  assert.equal(JSON.parse(read("plugin/.claude-plugin/plugin.json")).version, JSON.parse(read("package.json")).version);
});

test("package has a prepack guard so npm publish cannot ship a stale dist/", () => {
  const s = JSON.parse(read("package.json")).scripts;
  assert.match(s.prepack ?? "", /npm test|npm run build/);
});

test("tracked docs do not point at the git-ignored plan or the owner's clone layout", () => {
  for (const f of ["src/mint/README.md", "src/bridge/README.md", "third-party/README.md", "src/browser/README.md", "src/runtime/README.md", "src/server/README.md", "test/browser/README.md", "test/extension/README.md", "test/unit/README.md", "docs/research/04-browser-options.md", "docs/research/README.md"]) {
    assert.doesNotMatch(read(f), /01-planning|GitHub\/Pulled/, f);
  }
});
