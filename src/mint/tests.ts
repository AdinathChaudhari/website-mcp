import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InvalidInput, WebsiteMcpError } from "../runtime/errors.js";
import { runTool } from "../runtime/run.js";

/** The publish bar. `website-mcp test` exits non-zero below it. */
export const MIN_CASES = 3;
export const MIN_PASS_RATE = 0.7;

export type Expect = "result" | "empty" | "invalid_input";
export interface TestCase {
  name: string;
  purpose: string;
  input: unknown;
  expect: Expect;
}
export interface CaseResult {
  name: string;
  pass: boolean;
  ms: number;
  error?: string;
}
export interface LastRun {
  ranAt: string;
  /** Published version, or null for a draft run. */
  version: number | null;
  /** Hash of tool.mjs + tool.json (minus name/version). A run only counts for the source it ran. */
  sourceHash: string;
  /** Hash of cases.json, so edited cases also force a re-run. */
  casesHash: string;
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
  return sha256(mjs + "\0" + JSON.stringify(stable(m)));
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
    if (o.expect !== "result" && o.expect !== "empty" && o.expect !== "invalid_input") {
      throw new InvalidInput(`${at}.expect must be "result", "empty" or "invalid_input"`);
    }
    return { name: o.name, purpose: o.purpose, input: o.input, expect: o.expect };
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

export async function runCase(name: string, c: TestCase, base: { draft: boolean; baseDir?: string }, resultsPath?: string): Promise<CaseResult> {
  const t0 = performance.now();
  const done = (pass: boolean, error?: string): CaseResult => ({
    name: c.name,
    pass,
    ms: Math.round(performance.now() - t0),
    ...(error ? { error } : {}),
  });
  try {
    const out = await runTool(name, c.input, { draft: base.draft, baseDir: base.baseDir });
    if (c.expect === "invalid_input") return done(false, "expected invalid_input but the tool returned a result");
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
    const code = e instanceof WebsiteMcpError ? e.code : "tool_failed";
    const msg = e instanceof Error ? e.message : String(e);
    if (c.expect === "invalid_input") return code === "invalid_input" ? done(true) : done(false, `expected invalid_input but got ${code}: ${msg}`);
    return done(false, `${code}: ${msg}`);
  }
}

/** Run every case in <dir>/tests/cases.json through the normal runtime and write tests/last-run.json. */
export async function runCases(name: string, dir: string, opts: { draft: boolean; version: number | null; resultsPath?: string; baseDir?: string }): Promise<LastRun> {
  const cases = readCases(dir);
  const results: CaseResult[] = [];
  for (const c of cases) results.push(await runCase(name, c, { draft: opts.draft, baseDir: opts.baseDir }, opts.resultsPath));
  const passRate = results.length ? results.filter((r) => r.pass).length / results.length : 0;
  const run: LastRun = {
    ranAt: new Date().toISOString(),
    version: opts.version,
    sourceHash: hashSource(dir),
    casesHash: hashCases(dir),
    results,
    passRate,
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
