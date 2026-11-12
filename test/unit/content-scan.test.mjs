import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../helpers/index.mjs";

const SCAN = join(ROOT, "tools", "content-scan.mjs");
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A throwaway git repo with the given files; the scanner is run against it. */
function repo(files, { denylist } = {}) {
  const d = mkdtempSync(join(tmpdir(), "wm-scan-"));
  dirs.push(d);
  execFileSync("git", ["init", "-q"], { cwd: d });
  for (const [f, t] of Object.entries(files)) {
    if (f === ".gitignore") continue;
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), t);
  }
  if (denylist !== undefined) writeFileSync(join(d, ".content-denylist"), denylist);
  writeFileSync(join(d, ".gitignore"), ".content-denylist\n" + (files[".gitignore"] ?? ""));
  return d;
}
const scan = (d, env = {}) => spawnSync(process.execPath, [SCAN, d], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

test("clean tree passes", () => {
  const r = scan(repo({ "a.md": "hello world\n", "b.mjs": "export const x = 1;\n" }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("absolute local paths fail, with file and line", () => {
  const unix = ["", "Users", "someone", "proj"].join("/");
  const linux = ["", "home", "someone", "proj"].join("/");
  const win = "C:" + "\\" + "Users" + "\\" + "someone";
  for (const p of [unix, linux, win]) {
    const r = scan(repo({ "docs/x.md": `line1\nsee ${p} here\n` }));
    assert.equal(r.status, 1, p);
    assert.match(r.stdout, /docs\/x\.md:2/);
  }
});

test("email addresses fail except noreply and example domains", () => {
  assert.equal(scan(repo({ "a.md": "mail jane.doe" + "@" + "corp-mail.com now" })).status, 1);
  assert.equal(scan(repo({ "a.md": "1234+name@users.noreply.github.com" })).status, 0);
  assert.equal(scan(repo({ "a.md": "you@example.com" })).status, 0);
  assert.equal(scan(repo({ "a.md": "import x from '@scope/pkg'; // npm scope, not an email" })).status, 0);
});

test("the git-ignored denylist is applied, case-insensitively, and never printed", () => {
  const d = repo({ "a.md": "this mentions Secretword here" }, { denylist: "# comment\n\nsecretword\n" });
  const r = scan(d);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /a\.md:1/);
  assert.doesNotMatch(r.stdout + r.stderr, /secretword/i, "the private word is not echoed back");
  assert.equal(scan(repo({ "a.md": "fine" }, { denylist: "secretword\n" })).status, 0);
});

test("denylist path can come from CONTENT_SCAN_DENYLIST", () => {
  const d = repo({ "a.md": "has zzword" });
  const list = join(d, "elsewhere.txt");
  writeFileSync(list, "zzword\n");
  assert.equal(scan(d, { CONTENT_SCAN_DENYLIST: list }).status, 1);
});

test("git-ignored files are not scanned; binary files are skipped", () => {
  const unix = ["", "Users", "x", "y"].join("/");
  const d = repo({ "ignored.log": unix, ".gitignore": "ignored.log\n" });
  assert.equal(scan(d).status, 0);
  writeFileSync(join(d, "img.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0, 0]), Buffer.from(unix)]));
  assert.equal(scan(d).status, 0);
});

test("the scanner passes on this repository", () => {
  const r = scan(ROOT);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("an example denylist is committed and the real one is git-ignored", () => {
  const ignored = execFileSync("git", ["check-ignore", ".content-denylist"], { cwd: ROOT, encoding: "utf8" });
  assert.match(ignored, /\.content-denylist/);
  const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" });
  assert.match(tracked, /^content-denylist\.example$/m);
});
