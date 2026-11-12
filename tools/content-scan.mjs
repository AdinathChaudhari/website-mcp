#!/usr/bin/env node
// Content scan for the public repository: fails when a tracked (or not-yet-ignored) text file contains
//   - an absolute local path (/Users/..., /home/..., C:\Users\...),
//   - an email address (except noreply and example domains),
//   - a term from the private denylist.
// The denylist is a git-ignored file (.content-denylist, one case-insensitive regex per line, # comments) or the
// file named by CONTENT_SCAN_DENYLIST. Private words never enter the repo; only content-denylist.example does.
// Matches of denylist terms are reported by file:line only, never echoed.
// Usage: node tools/content-scan.mjs [repo-root]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const SKIP_FILES = new Set(["package-lock.json", "tools/content-scan.mjs"]);

const rules = [
  { name: "absolute local path", re: /\/Users\/|\/home\/[A-Za-z]|[A-Za-z]:\\Users\\/ },
  {
    name: "email address",
    re: /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g,
    allow: (m) => /@(users\.noreply\.github\.com|noreply\.[a-z.]+|example\.(com|org|net)|[a-z0-9-]+\.invalid)$/i.test(m),
  },
];

const denyFile = process.env.CONTENT_SCAN_DENYLIST || join(root, ".content-denylist");
const deny = existsSync(denyFile)
  ? readFileSync(denyFile, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l, i) => {
        try { return new RegExp(l, "i"); } catch { console.error(`denylist line ${i + 1} is not a valid regex`); process.exit(2); }
      })
  : [];

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
  .split("\0")
  .filter(Boolean);

const hits = [];
for (const f of new Set(files)) {
  if (SKIP_FILES.has(f)) continue;
  const p = join(root, f);
  if (!existsSync(p)) continue; // tracked but deleted in the working tree
  const buf = readFileSync(p);
  if (buf.subarray(0, 8000).includes(0)) continue; // binary
  const lines = buf.toString("utf8").split("\n");
  lines.forEach((line, i) => {
    for (const r of rules) {
      const found = r.re.global ? [...line.matchAll(r.re)].map((m) => m[0]) : r.re.test(line) ? [line] : [];
      if (found.some((m) => !(r.allow && r.allow(m)))) hits.push(`${f}:${i + 1}  ${r.name}`);
    }
    if (deny.some((d) => d.test(line))) hits.push(`${f}:${i + 1}  denylist term`);
  });
}

if (hits.length) {
  process.stdout.write(`content-scan: ${hits.length} finding(s)\n${hits.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`content-scan: clean (${files.length} files, ${deny.length} denylist terms)\n`);
