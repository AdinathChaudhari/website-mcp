import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InvalidInput, LiveCapReached, WebsiteMcpError } from "../runtime/errors.js";
import { draftsDir } from "../runtime/load.js";
import { runTool } from "../runtime/run.js";

/** The publish bar. `website-mcp test` exits non-zero below it. */
export const MIN_CASES = 3;
export const MIN_PASS_RATE = 0.7;

export type Expect = "result" | "empty" | "invalid_input" | "signed_out";
/** "capture": run against a saved page capture (offline, JS off). "live": run for real (browser tools: a fresh browser; page tools: the user's tab). */
export type CaseMode = "capture" | "live";
export interface TestCase {
  name: string;
  purpose: string;
  input: unknown;
  expect: Expect;
  /** Default by tool kind: browser -> live, page -> capture. */
  mode?: CaseMode;
  /** Capture cases: file name inside the captures folder, e.g. "1.html". */
  capture?: string;
}
export interface CaseResult {
  name: string;
  pass: boolean;
  ms: number;
  error?: string;
  /** Present for page tools. */
  mode?: CaseMode;
}

export const CAPTURE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.html$/;
export interface LastRun {
  ranAt: string;
  /** Published version, or null for a draft run. */
  version: number | null;
  /** Hash of tool.mjs + tool.json (minus name/version). A run only counts for the source it ran. */
  sourceHash: string;
  /** Hash of cases.json, so edited cases also force a re-run. */
  casesHash: string;
  /** Live cases attempted in this run (page tools). They count against the per-mint live cap. */
  liveRuns?: number;
  results: CaseResult[];
  passRate: number;
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, stable(x)]),
    );
  }
  return v;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Hash of what a test run exercised: the script plus the manifest (ignoring name and version). */
export function hashSource(dir: string): string {
  const mjs = readFileSync(join(dir, "tool.mjs"), "utf8");
  const m = JSON.parse(readFileSync(join(dir, "tool.json"), "utf8")) as Record<string, unknown>;
  delete m.name;
  delete m.version;
  // signin.json decides what the extension checks in the tab, so it is part of what a reviewer/approver sees.
  // Absent (every browser tool) it adds nothing, so existing hashes are unchanged.
  const si = join(dir, "signin.json");
  const signin = existsSync(si) ? "\0" + sha256(readFileSync(si, "utf8")) : "";
  return sha256(mjs + "\0" + JSON.stringify(stable(m)) + signin);
}

export function hashCases(dir: string): string {
  const f = join(dir, "tests", "cases.json");
  return existsSync(f) ? sha256(readFileSync(f, "utf8")) : "";
}

/** Throws a readable error unless `raw` is a valid cases array. */
export function parseCases(raw: unknown): TestCase[] {
  if (!Array.isArray(raw)) throw new InvalidInput("cases must be an array");
  const seen = new Set<string>();
  return raw.map((c, i) => {
    const o = c as Partial<TestCase> | null;
    const at = `cases[${i}]`;
    if (!o || typeof o !== "object") throw new InvalidInput(`${at} must be an object`);
    if (typeof o.name !== "string" || !o.name) throw new InvalidInput(`${at}.name must be a non-empty string`);
    if (seen.has(o.name)) throw new InvalidInput(`${at}.name "${o.name}" is duplicated`);
    seen.add(o.name);
    if (typeof o.purpose !== "string" || !o.purpose) throw new InvalidInput(`${at}.purpose must be a non-empty string`);
    if (!("input" in o)) throw new InvalidInput(`${at}.input is required`);
    if (o.expect !== "result" && o.expect !== "empty" && o.expect !== "invalid_input" && o.expect !== "signed_out") {
      throw new InvalidInput(`${at}.expect must be "result", "empty", "invalid_input" or "signed_out"`);
    }
    if (o.mode !== undefined && o.mode !== "capture" && o.mode !== "live") throw new InvalidInput(`${at}.mode must be "capture" or "live"`);
    if (o.capture !== undefined && (typeof o.capture !== "string" || !CAPTURE_FILE_RE.test(o.capture))) {
      throw new InvalidInput(`${at}.capture must be a capture file name like "1.html" (letters, digits, . _ -; no folders)`);
    }
    if (o.mode === "live" && o.capture !== undefined) throw new InvalidInput(`${at}: a live case cannot name a capture`);
    return {
      name: o.name,
      purpose: o.purpose,
      input: o.input,
      expect: o.expect,
      ...(o.mode !== undefined ? { mode: o.mode } : {}),
      ...(o.capture !== undefined ? { capture: o.capture } : {}),
    };
  });
}

export function readCases(dir: string): TestCase[] {
  const f = join(dir, "tests", "cases.json");
  if (!existsSync(f)) return [];
  return parseCases(JSON.parse(readFileSync(f, "utf8")));
}

/**
 * The "main list" of an output, used by `expect: "empty"` (and as a sanity check for "result").
 * Rule: if tool.json sets `resultsPath` (dot path, e.g. "data.items"), that value; otherwise the
 * first property of the output object whose value is an array; an array output is its own list.
 */
export function mainList(output: unknown, resultsPath?: string): { list?: unknown[]; error?: string } {
  if (resultsPath) {
    let cur: unknown = output;
    for (const k of resultsPath.split(".")) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined;
    return Array.isArray(cur) ? { list: cur } : { error: `resultsPath "${resultsPath}" does not point to an array in the output` };
  }
  if (Array.isArray(output)) return { list: output };
  if (output && typeof output === "object") {
    for (const v of Object.values(output as Record<string, unknown>)) if (Array.isArray(v)) return { list: v };
  }
  return {};
}

/** The effective mode of a case for a tool kind. */
export function caseMode(c: TestCase, kind: string): CaseMode {
  return c.mode ?? (kind === "page" ? "capture" : "live");
}

/** Kind-specific case rules, as messages. Browser tools have no captures; page capture cases must name one. */
export function caseProblems(cases: TestCase[], kind: string): string[] {
  const out: string[] = [];
  for (const c of cases) {
    const mode = caseMode(c, kind);
    if (kind !== "page") {
      if (c.mode === "capture" || c.capture) out.push(`case "${c.name}": captures only exist for page tools (kind "page")`);
      if (c.expect === "signed_out") out.push(`case "${c.name}": expect "signed_out" is for page tools`);
    } else if (mode === "capture" && !c.capture) out.push(`case "${c.name}": a capture case must name its capture file ("capture": "1.html"); save one with page_capture`);
    else if (mode === "live" && c.capture) out.push(`case "${c.name}": a live case cannot name a capture`);
  }
  return out;
}

/** Where a capture file lives: the tool's own tests/captures (fixtures), else the mint draft's captures folder. */
export function resolveCapture(name: string, dir: string, file: string): string | undefined {
  if (!CAPTURE_FILE_RE.test(file)) return undefined;
  for (const base of [join(dir, "tests", "captures"), join(draftsDir(), name, "captures")]) {
    const p = join(base, file);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export interface CaseEnv {
  draft: boolean;
  baseDir?: string;
  /** Tool folder (for tests/captures and signin.json). */
  dir: string;
  kind: string;
  /** Called before every live case of a page tool; throws LiveCapReached when the mint's live runs are used up. */
  reserveLive?: () => void;
  /** Do not run live cases of a page tool (publish re-runs only the offline ones). */
  skipLive?: boolean;
}

export async function runCase(name: string, c: TestCase, env: CaseEnv, resultsPath?: string): Promise<CaseResult> {
  const t0 = performance.now();
  const mode = env.kind === "page" ? caseMode(c, env.kind) : undefined;
  const done = (pass: boolean, error?: string): CaseResult => ({
    name: c.name,
    pass,
    ms: Math.round(performance.now() - t0),
    ...(mode ? { mode } : {}),
    ...(error ? { error } : {}),
  });
  try {
    let capture: string | undefined;
    if (mode === "capture") {
      if (!c.capture) return done(false, 'a capture case must name its capture file ("capture": "1.html")');
      capture = resolveCapture(name, env.dir, c.capture);
      // invalid_input is decided before any page is touched, so it does not need the file to exist.
      if (!capture && c.expect !== "invalid_input") return done(false, `capture file ${c.capture} not found (page_capture saves it under drafts/${name}/captures/)`);
    } else if (mode === "live") {
      env.reserveLive?.();
    }
    const out = await runTool(name, c.input, { draft: env.draft, baseDir: env.baseDir, ...(capture ? { capture } : {}) });
    if (c.expect === "invalid_input") return done(false, "expected invalid_input but the tool returned a result");
    if (c.expect === "signed_out") return done(false, "expected SIGNED_OUT but the tool returned a result");
    const { list, error } = mainList(out, resultsPath);
    if (c.expect === "empty") {
      if (error) return done(false, error);
      if (!list) return done(false, "expected empty but the output has no list (set resultsPath in tool.json)");
      return list.length === 0 ? done(true) : done(false, `expected an empty list but got ${list.length} item(s)`);
    }
    if (error) return done(false, error);
    if (list && list.length === 0) return done(false, "expected a non-empty result but the main list is empty");
    return done(true);
  } catch (e) {
    if (e instanceof LiveCapReached) return done(false, `${e.code}: ${e.message}`);
    const code = e instanceof WebsiteMcpError ? e.code : "tool_failed";
    const msg = e instanceof Error ? e.message : String(e);
    if (c.expect === "invalid_input") return code === "invalid_input" ? done(true) : done(false, `expected invalid_input but got ${code}: ${msg}`);
    if (c.expect === "signed_out") return code === "SIGNED_OUT" ? done(true) : done(false, `expected SIGNED_OUT but got ${code}: ${msg}`);
    return done(false, `${code}: ${msg}`);
  }
}

export interface RunCasesOptions {
  draft: boolean;
  version: number | null;
  resultsPath?: string;
  baseDir?: string;
  reserveLive?: () => void;
  skipLive?: boolean;
}

function kindOf(dir: string): string {
  try {
    return (JSON.parse(readFileSync(join(dir, "tool.json"), "utf8")) as { kind?: string }).kind ?? "browser";
  } catch {
    return "browser";
  }
}

/** Run every case in <dir>/tests/cases.json through the normal runtime and write tests/last-run.json. */
export async function runCases(name: string, dir: string, opts: RunCasesOptions): Promise<LastRun> {
  const cases = readCases(dir);
  const kind = kindOf(dir);
  const results: CaseResult[] = [];
  let liveRuns = 0;
  const env: CaseEnv = {
    draft: opts.draft,
    baseDir: opts.baseDir,
    dir,
    kind,
    reserveLive: () => {
      opts.reserveLive?.();
      liveRuns++;
    },
  };
  for (const c of cases) {
    if (kind === "page" && opts.skipLive && caseMode(c, kind) === "live") continue;
    results.push(await runCase(name, c, env, opts.resultsPath));
  }
  const passRate = results.length ? results.filter((r) => r.pass).length / results.length : 0;
  const run: LastRun = {
    ranAt: new Date().toISOString(),
    version: opts.version,
    sourceHash: hashSource(dir),
    casesHash: hashCases(dir),
    results,
    passRate,
    ...(kind === "page" ? { liveRuns } : {}),
  };
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "tests", "last-run.json"), JSON.stringify(run, null, 2) + "\n");
  return run;
}

export function readLastRun(dir: string): LastRun | undefined {
  const f = join(dir, "tests", "last-run.json");
  if (!existsSync(f)) return undefined;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as LastRun;
  } catch {
    return undefined;
  }
}

export function meetsBar(run: LastRun): boolean {
  return run.results.length >= MIN_CASES && run.passRate >= MIN_PASS_RATE;
}
