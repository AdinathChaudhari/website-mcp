import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ToolNotFound } from "./errors.js";
import { assertSchema } from "./schema.js";
import type { ToolFn } from "./runners/types.js";

export interface ToolManifest {
  name: string;
  description?: string;
  kind?: "browser" | "page";
  effect: "read" | "write";
  /** effect "write", kind "browser": the names of the wm.commit(mark, fn) calls the tool makes. */
  commitMarks?: string[];
  input: object;
  output: object;
  site?: { allowedOrigins?: string[] };
  timeoutSec?: number;
  /** Minimum seconds between runs of this tool (page tools; enforced by the runner/extension). */
  minIntervalSec?: number;
  /** kind "page" only: how the tool is delivered to the user's open tab. */
  page?: PageBlock;
  /** kind "page" only: a bot-sensitive site. A mint gets 2 live runs instead of 4. */
  hardTarget?: boolean;
  version?: number;
  /** Dot path to the output's main list (used by "empty" test cases). Default: first array property. */
  resultsPath?: string;
}

export interface PageBlock {
  /** Path glob matched against tab URLs within site.allowedOrigins, e.g. "/account/*". */
  urlPattern?: string;
  world?: "USER_SCRIPT" | "MAIN";
  tab?: "existing";
  needsVisible?: boolean;
}

export interface LoadedTool {
  manifest: ToolManifest;
  fn: ToolFn;
  dir: string;
}

export function homeDir(): string {
  return process.env.WEBSITE_MCP_HOME || join(homedir(), ".website-mcp");
}

export function toolsDir(): string {
  return join(homeDir(), "tools");
}

export function draftsDir(): string {
  return join(homeDir(), "drafts");
}

export const NAME_RE = /^[a-z][a-z0-9_]{1,62}$/;

/** Shared tool.json checks used by both save_tool and the loader. Throws on a bad manifest. */
export function assertManifestShape(m: { input?: unknown; output?: unknown; site?: { allowedOrigins?: unknown } }, label: string): void {
  if (!m.input || !m.output) throw new Error(`${label}: tool.json needs "input" and "output" schemas`);
  if ((m.input as { type?: unknown }).type !== "object") throw new Error(`${label}: input schema must have type "object"`);
  const o = m.site?.allowedOrigins;
  if (!Array.isArray(o) || o.length === 0) throw new Error(`${label}: site.allowedOrigins must be a non-empty array of origins`);
  for (const x of o) {
    let ok = false;
    try {
      const u = new URL(String(x));
      ok = (u.protocol === "http:" || u.protocol === "https:") && u.origin === x;
    } catch {
      /* invalid */
    }
    if (!ok) throw new Error(`${label}: invalid origin ${JSON.stringify(x)} (use e.g. "https://example.com")`);
  }
}

/** Validates the optional "page" block and minIntervalSec. A "page" block is only legal on kind "page". */
export function assertPageBlock(m: { kind?: unknown; page?: unknown; minIntervalSec?: unknown }, label: string): void {
  if (m.minIntervalSec !== undefined && !(typeof m.minIntervalSec === "number" && m.minIntervalSec >= 0)) {
    throw new Error(`${label}: minIntervalSec must be a number >= 0`);
  }
  if (m.page === undefined) return;
  if (m.kind !== "page") throw new Error(`${label}: a "page" block is only allowed with kind "page"`);
  const p = m.page as Record<string, unknown>;
  if (p === null || typeof p !== "object" || Array.isArray(p)) throw new Error(`${label}: "page" must be an object`);
  for (const k of Object.keys(p)) {
    if (!["urlPattern", "world", "tab", "needsVisible"].includes(k)) throw new Error(`${label}: unknown page.${k}`);
  }
  if (p.urlPattern !== undefined && (typeof p.urlPattern !== "string" || !p.urlPattern.startsWith("/"))) {
    throw new Error(`${label}: page.urlPattern must be a path glob starting with "/"`);
  }
  if (p.world !== undefined && p.world !== "USER_SCRIPT" && p.world !== "MAIN") throw new Error(`${label}: page.world must be "USER_SCRIPT" or "MAIN"`);
  if (p.tab !== undefined && p.tab !== "existing") throw new Error(`${label}: page.tab must be "existing"`);
  if (p.needsVisible !== undefined && typeof p.needsVisible !== "boolean") throw new Error(`${label}: page.needsVisible must be a boolean`);
}

/** Page tools are serialised and run inside a tab, so they cannot import anything. Fails closed on any import. */
export function assertPageSource(source: string, label: string): void {
  if (/\bimport\b\s*(\(|[\w{*"'])/.test(source)) throw new Error(`${label}: a page tool must not import anything (it runs inside the page)`);
}

export const MARK_RE = /^[a-z][a-z0-9_-]{0,40}$/;

/** A write tool always has a `dryRun` boolean input, default true. A tool may not declare its own. */
export function withDryRun(input: object, label: string): object {
  const i = input as { properties?: Record<string, unknown> };
  if (i.properties && "dryRun" in i.properties) throw new Error(`${label}: "dryRun" is added automatically to write tools; remove it from input`);
  return { ...i, properties: { ...(i.properties ?? {}), dryRun: { type: "boolean", default: true, description: "true (default): rehearse without saving anything. false: really make the change, once." } } };
}

/** Write-only manifest fields. Shared by save_tool, the publish gate and the loader. */
export function assertWriteBlock(m: { effect?: unknown; kind?: unknown; commitMarks?: unknown; hardTarget?: unknown; input?: unknown }, label: string): void {
  const marks = m.commitMarks;
  if (m.effect !== "write") {
    if (marks !== undefined) throw new Error(`${label}: commitMarks is for effect "write" only`);
    return;
  }
  if (m.hardTarget === true) throw new Error(`${label}: write tools are not allowed on a hardTarget site`);
  if (m.input && typeof m.input === "object" && "dryRun" in ((m.input as { properties?: object }).properties ?? {})) throw new Error(`${label}: "dryRun" is added automatically to write tools; remove it from input`);
  if (m.kind === "page") {
    if (marks !== undefined) throw new Error(`${label}: a page write tool hands the final click to the user (wm.handOff); it has no commitMarks`);
    return;
  }
  if (!Array.isArray(marks) || marks.length === 0 || !marks.every((x) => typeof x === "string" && MARK_RE.test(x)) || new Set(marks).size !== marks.length) {
    throw new Error(`${label}: a browser write tool needs commitMarks: a non-empty list of distinct names (lowercase, e.g. "save_profile") for its wm.commit calls`);
  }
}

export function listToolNames(): string[] {
  const dir = toolsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => NAME_RE.test(n) && statSync(join(dir, n)).isDirectory())
    .filter((n) => existsSync(join(dir, n, "tool.json")) && existsSync(join(dir, n, "tool.mjs")))
    .sort();
}

export function readManifest(name: string, base: string = toolsDir()): ToolManifest {
  if (!NAME_RE.test(name)) throw new ToolNotFound(name);
  const file = join(base, name, "tool.json");
  if (!existsSync(file)) throw new ToolNotFound(name);
  const m = JSON.parse(readFileSync(file, "utf8")) as Partial<ToolManifest>;
  if (m.effect !== "read" && m.effect !== "write") throw new Error(`${name}: effect must be "read" or "write"`);
  if (m.kind !== undefined && m.kind !== "browser" && m.kind !== "page") {
    throw new Error(`${name}: unknown kind "${String(m.kind)}"`);
  }
  assertManifestShape(m, name);
  assertPageBlock(m, name);
  assertWriteBlock(m, name);
  assertSchema(m.input, `${name} input`);
  assertSchema(m.output, `${name} output`);
  if (m.effect === "write") m.input = withDryRun(m.input as ToolManifest["input"], name);
  return { ...(m as ToolManifest), name };
}

export async function loadTool(name: string, base: string = toolsDir()): Promise<LoadedTool> {
  const manifest = readManifest(name, base);
  const dir = join(base, name);
  const file = join(dir, "tool.mjs");
  if (!existsSync(file)) throw new ToolNotFound(name);
  if (manifest.kind === "page") assertPageSource(readFileSync(file, "utf8"), name);
  // Cache-busting query so a re-saved tool is re-imported in a long-lived server.
  const mod = (await import(`${pathToFileURL(file).href}?v=${statSync(file).mtimeMs}-${statSync(file).size}`)) as {
    default?: ToolFn;
  };
  if (typeof mod.default !== "function") throw new Error(`${name}: tool.mjs must export default an async function`);
  return { manifest, fn: mod.default, dir };
}
