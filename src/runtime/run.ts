import { InvalidInput, InvalidOutput, Timeout, ToolFailed, WebsiteMcpError } from "./errors.js";
import { draftsDir, loadTool, toolsDir } from "./load.js";
import { PlaywrightRunner } from "./runners/playwright.js";
import { PageRunner } from "./runners/page.js";
import type { Runner } from "./runners/types.js";
import { validate } from "./schema.js";

const runners: Record<string, Runner> = {
  browser: new PlaywrightRunner(),
  page: new PageRunner(),
};

export interface RunOptions {
  /** Run the draft in <home>/drafts instead of the published tool. */
  draft?: boolean;
  /** Load <baseDir>/<name>/ instead (publish gate: a private staged copy of a draft). Wins over `draft`. */
  baseDir?: string;
}

export async function runTool(name: string, input: unknown, opts: RunOptions = {}): Promise<unknown> {
  const tool = await loadTool(name, opts.baseDir ?? (opts.draft ? draftsDir() : toolsDir()));
  const { manifest } = tool;

  const vin = validate(manifest.input, input);
  if (!vin.ok) throw new InvalidInput(`${name}: ${vin.errors}`);

  const runner = runners[manifest.kind ?? "browser"];
  if (!runner) throw new ToolFailed(`${name}: no runner for kind "${manifest.kind}" in this build`);

  const seconds = manifest.timeoutSec ?? 60;
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Timeout(seconds));
    }, seconds * 1000);
  });

  let result: unknown;
  try {
    result = await Promise.race([runner.run({ manifest, fn: tool.fn, dir: tool.dir, input, signal: ac.signal }), timeout]);
  } catch (e) {
    if (e instanceof WebsiteMcpError) throw e;
    throw new ToolFailed(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }

  const vout = validate(manifest.output, result);
  if (!vout.ok) throw new InvalidOutput(`${name}: ${vout.errors}`);
  return result;
}
