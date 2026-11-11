import type { ToolManifest } from "../load.js";

export type ToolFn = (args: {
  page: unknown;
  input: unknown;
  wm: unknown;
}) => Promise<unknown>;

export interface RunContext {
  manifest: ToolManifest;
  fn: ToolFn;
  input: unknown;
  signal: AbortSignal;
}

/** A Runner executes a tool function somewhere (a fresh browser, a user page, ...). */
export interface Runner {
  readonly kind: string;
  run(ctx: RunContext): Promise<unknown>;
}
