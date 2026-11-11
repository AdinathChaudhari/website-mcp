import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublishRefused } from "../runtime/errors.js";
import { NAME_RE, assertManifestShape, homeDir, toolsDir } from "../runtime/load.js";
import { assertSchema } from "../runtime/schema.js";
import { MIN_CASES, MIN_PASS_RATE, hashCases, hashSource, readCases, runCases, type LastRun } from "./tests.js";

export interface Reason {
  code: "no_draft" | "too_few_cases" | "bad_cases" | "pass_rate" | "bad_manifest" | "bad_schema" | "bad_source" | "origin" | "secret";
  message: string;
  /** Failing case names, for pass_rate refusals. */
  cases?: string[];
}

/** Provider-shaped secrets. Intentionally simple; a heuristic, not a guarantee. */
const SECRET_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "API key (sk-…)", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { label: "AWS access key (AKIA…)", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "GitHub token (ghp_…)", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { label: "Slack token (xox…)", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { label: "Google API key (AIza…)", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

function entropy(s: string): number {
  const f = new Map<string, number>();
  for (const ch of s) f.set(ch, (f.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of f.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/**
 * Scan source text for secret-shaped literals: the provider patterns above, plus any quoted string of
 * 32+ token characters (no spaces, not a URL) that mixes letters and digits with Shannon entropy >= 4.2.
 */
export function scanSecrets(source: string): string[] {
  const found: string[] = [];
  for (const { label, re } of SECRET_PATTERNS) if (re.test(source)) found.push(label);
  for (const m of source.matchAll(/(["'`])([A-Za-z0-9+/_=-]{32,})\1/g)) {
    const s = m[2];
    if (/^(?:https?:|\/)/.test(s) || !/[A-Za-z]/.test(s) || !/\d/.test(s)) continue;
    if (entropy(s) >= 4.2) {
      found.push("high-entropy token literal");
      break;
    }
  }
  return [...new Set(found)];
}

/**
 * URL literals in the source whose origin is not in allowedOrigins. A literal-text HEURISTIC: a URL built
 * from parts (\"https:\" + \"//host\") is not seen. The runtime route guard is the real enforcement.
 */
export function offOriginUrls(source: string, allowed: string[]): string[] {
  const bad = new Set<string>();
  for (const m of source.matchAll(/https?:\/\/[^\s"'`)<>\\]+/gi)) {
    let origin = "";
    try {
      origin = new URL(m[0].replace(/\$\{.*$/, "")).origin;
    } catch {
      continue;
    }
    if (!allowed.includes(origin)) bad.add(origin);
  }
  return [...bad];
}

function syntaxError(source: string): string | undefined {
  const tmp = mkdtempSync(join(tmpdir(), "wm-syntax-"));
  try {
    const f = join(tmp, "tool.mjs");
    writeFileSync(f, source);
    const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
    if (r.status === 0) return undefined;
    return (r.stderr || "").split("\n").find((l) => /Error/.test(l)) ?? "check failed";
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Static checks on a draft folder (no test run). Returns refusal reasons. */
export function staticChecks(dir: string): Reason[] {
  const reasons: Reason[] = [];
  if (!existsSync(join(dir, "tool.json")) || !existsSync(join(dir, "tool.mjs"))) {
    return [{ code: "no_draft", message: "draft is missing tool.json or tool.mjs; save_tool first" }];
  }
  let m: Record<string, unknown> = {};
  try {
    m = JSON.parse(readFileSync(join(dir, "tool.json"), "utf8"));
  } catch (e) {
    return [{ code: "bad_manifest", message: `tool.json is not valid JSON: ${(e as Error).message}` }];
  }
  if (m.effect !== "read") reasons.push({ code: "bad_manifest", message: 'effect must be "read" in this version' });
  if ((m.kind ?? "browser") !== "browser") reasons.push({ code: "bad_manifest", message: 'kind must be "browser" in this version' });
  try {
    assertManifestShape(m as { input?: unknown; output?: unknown; site?: { allowedOrigins?: unknown } }, "tool");
  } catch (e) {
    reasons.push({ code: "bad_manifest", message: (e as Error).message });
  }
  for (const k of ["input", "output"] as const) {
    try {
      assertSchema(m[k], k);
    } catch (e) {
      reasons.push({ code: "bad_schema", message: (e as Error).message });
    }
  }
  const source = readFileSync(join(dir, "tool.mjs"), "utf8");
  if (!/export\s+default/.test(source)) reasons.push({ code: "bad_source", message: "tool.mjs needs a default export" });
  else {
    const se = syntaxError(source);
    if (se) reasons.push({ code: "bad_source", message: `tool.mjs has a syntax error: ${se}` });
  }
  const origins = ((m.site as { allowedOrigins?: unknown } | undefined)?.allowedOrigins ?? []) as string[];
  if (!Array.isArray(origins) || origins.length === 0) {
    reasons.push({ code: "origin", message: "site.allowedOrigins is missing or empty" });
  } else {
    const bad = offOriginUrls(source, origins);
    if (bad.length) reasons.push({ code: "origin", message: `tool.mjs mentions origin(s) outside site.allowedOrigins: ${bad.join(", ")} (literal-URL heuristic; the runtime route guard blocks the rest)` });
  }
  const secrets = scanSecrets(source + "\n" + readFileSync(join(dir, "tool.json"), "utf8"));
  if (secrets.length) reasons.push({ code: "secret", message: `secret-shaped literal in the tool: ${secrets.join(", ")}` });
  return reasons;
}

export interface PublishResult {
  published: string;
  version: number;
  previous?: number;
  lastRun: LastRun;
}

export interface PublishOptions {
  /**
   * A run the caller recorded itself (MintSession keeps these in memory). Used only if its hashes match the
   * staged copy. A tests/last-run.json found on disk is never trusted: any file writer could forge one.
   */
  trustedRun?: LastRun;
}

/**
 * Publish a draft. Refuses (PublishRefused, with a `reasons` list) unless the draft has >= 3 cases,
 * passes static checks, and a test run on the CURRENT source+cases passes >= 70%.
 * The draft is first copied into a private stage directory; every check, the test run and the publish read
 * that one copy, so the draft cannot change between check and publish. Unless the caller passes a matching
 * in-memory `trustedRun`, the cases are run against the staged copy. On success the previous published
 * version moves to .history/<n>/.
 */
export async function publishDraft(name: string, draftDir: string, opts: PublishOptions = {}): Promise<PublishResult> {
  if (!NAME_RE.test(name)) throw new PublishRefused(`invalid tool name "${name}"`, [{ code: "no_draft", message: "invalid name" }]);
  mkdirSync(homeDir(), { recursive: true });
  const stageRoot = mkdtempSync(join(homeDir(), ".publish-"));
  try {
    return await publishFromStage(name, draftDir, stageRoot, opts);
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

async function publishFromStage(name: string, draftDir: string, stageRoot: string, opts: PublishOptions): Promise<PublishResult> {
  const snap = join(stageRoot, name);
  mkdirSync(join(snap, "tests"), { recursive: true });
  for (const f of ["tool.json", "tool.mjs", join("tests", "cases.json")]) {
    if (existsSync(join(draftDir, f))) copyFileSync(join(draftDir, f), join(snap, f));
  }
  const reasons = staticChecks(snap);
  let cases: ReturnType<typeof readCases> = [];
  if (!reasons.some((r) => r.code === "no_draft")) {
    try {
      cases = readCases(snap);
    } catch (e) {
      reasons.push({ code: "bad_cases", message: (e as Error).message });
    }
    if (cases.length < MIN_CASES) {
      reasons.push({ code: "too_few_cases", message: `need at least ${MIN_CASES} test cases, found ${cases.length}; save_cases first` });
    }
  }
  if (reasons.length) throw refusal(name, reasons);

  let run = opts.trustedRun;
  if (!run || run.sourceHash !== hashSource(snap) || run.casesHash !== hashCases(snap)) {
    const m = JSON.parse(readFileSync(join(snap, "tool.json"), "utf8")) as { resultsPath?: string };
    run = await runCases(name, snap, { draft: true, version: null, resultsPath: m.resultsPath, baseDir: stageRoot });
  }
  if (run.passRate < MIN_PASS_RATE) {
    const failing = run.results.filter((r) => !r.pass);
    reasons.push({
      code: "pass_rate",
      message: `pass rate ${Math.round(run.passRate * 100)}% is below ${MIN_PASS_RATE * 100}%; failing: ${failing.map((r) => `${r.name} (${r.error ?? "failed"})`).join("; ")}`,
      cases: failing.map((r) => r.name),
    });
    throw refusal(name, reasons);
  }

  const dir = join(toolsDir(), name);
  let previous: number | undefined;
  if (existsSync(join(dir, "tool.json"))) {
    try {
      previous = Number(JSON.parse(readFileSync(join(dir, "tool.json"), "utf8")).version) || 1;
    } catch {
      previous = 1;
    }
  }
  const version = (previous ?? 0) + 1;
  const draftManifest = JSON.parse(readFileSync(join(snap, "tool.json"), "utf8")) as Record<string, unknown>;
  const lastRun: LastRun = { ...run, version };

  mkdirSync(toolsDir(), { recursive: true });
  const stage = join(toolsDir(), `.stage-${name}-${process.pid}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "tests"), { recursive: true });
  try {
    writeFileSync(join(stage, "tool.json"), JSON.stringify({ ...draftManifest, name, version }, null, 2) + "\n");
    writeFileSync(join(stage, "tool.mjs"), readFileSync(join(snap, "tool.mjs")));
    writeFileSync(join(stage, "tests", "cases.json"), readFileSync(join(snap, "tests", "cases.json")));
    writeFileSync(join(stage, "tests", "last-run.json"), JSON.stringify(lastRun, null, 2) + "\n");
    const desc = typeof draftManifest.description === "string" ? draftManifest.description : "";
    writeFileSync(join(stage, "README.md"), `# ${name}\n\n${desc}\n\nRun: \`website-mcp run ${name} --input '{}'\`\nTest: \`website-mcp test ${name}\`\n`);
    if (existsSync(dir)) {
      if (existsSync(join(dir, ".history"))) cpSync(join(dir, ".history"), join(stage, ".history"), { recursive: true });
      const slot = join(stage, ".history", String(previous));
      mkdirSync(slot, { recursive: true });
      for (const f of readdirSync(dir)) {
        if (f === ".history") continue;
        cpSync(join(dir, f), join(slot, f), { recursive: true });
      }
      rmSync(dir, { recursive: true, force: true });
    }
    renameSync(stage, dir);
  } catch (e) {
    rmSync(stage, { recursive: true, force: true });
    throw e;
  }
  return { published: name, version, ...(previous !== undefined ? { previous } : {}), lastRun };
}

function refusal(name: string, reasons: Reason[]): PublishRefused {
  return new PublishRefused(`publish refused for ${name}: ${reasons.map((r) => r.message).join(" | ")}`, reasons);
}
