import type { ToolManifest } from "../load.js";

export type ToolFn = (args: {
  /** Playwright Page for kind "browser"; absent for page tools (they run in the user's tab). */
  page?: unknown;
  input: unknown;
  wm: unknown;
}) => Promise<unknown>;

export interface RunContext {
  manifest: ToolManifest;
  fn: ToolFn;
  /** Directory of the loaded tool (page tools read their source + hash from it). */
  dir: string;
  input: unknown;
  signal: AbortSignal;
}

/** A Runner executes a tool function somewhere (a fresh browser, a user page, ...). */
export interface Runner {
  readonly kind: string;
  run(ctx: RunContext): Promise<unknown>;
}
