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
  effect: "read";
  input: object;
  output: object;
  site?: { allowedOrigins?: string[] };
  timeoutSec?: number;
  version?: number;
  /** Dot path to the output's main list (used by "empty" test cases). Default: first array property. */
  resultsPath?: string;
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
  if (m.effect !== "read") throw new Error(`${name}: only effect "read" is supported`);
  if (m.kind !== undefined && m.kind !== "browser" && m.kind !== "page") {
    throw new Error(`${name}: unknown kind "${String(m.kind)}"`);
  }
  assertManifestShape(m, name);
  assertSchema(m.input, `${name} input`);
  assertSchema(m.output, `${name} output`);
  return { ...(m as ToolManifest), name };
}

export async function loadTool(name: string, base: string = toolsDir()): Promise<LoadedTool> {
  const manifest = readManifest(name, base);
  const dir = join(base, name);
  const file = join(dir, "tool.mjs");
  if (!existsSync(file)) throw new ToolNotFound(name);
  // Cache-busting query so a re-saved tool is re-imported in a long-lived server.
  const mod = (await import(`${pathToFileURL(file).href}?v=${statSync(file).mtimeMs}-${statSync(file).size}`)) as {
    default?: ToolFn;
  };
  if (typeof mod.default !== "function") throw new Error(`${name}: tool.mjs must export default an async function`);
  return { manifest, fn: mod.default, dir };
}
