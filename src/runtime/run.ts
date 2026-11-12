import { InvalidInput, InvalidOutput, Timeout, ToolFailed, WebsiteMcpError } from "./errors.js";
import { join } from "node:path";
import { markChallenged } from "../mint/live.js";
import { draftsDir, loadTool, toolsDir } from "./load.js";
import { recordRun, reserveInterval } from "./rate.js";
import { PlaywrightRunner } from "./runners/playwright.js";
import { PageRunner } from "./runners/page.js";
import { PageEvalRunner } from "./runners/page-eval.js";
import type { Runner } from "./runners/types.js";
import { WriteState } from "./write.js";
import { validate } from "./schema.js";

const runners: Record<string, Runner> = {
  browser: new PlaywrightRunner(),
  page: new PageRunner(),
  "page-eval": new PageEvalRunner(),
};

const NEVER_REACHED_PAGE = new Set(["NO_TAB", "TAB_HIDDEN", "NEEDS_APPROVAL", "SITE_NOT_GRANTED", "NO_BRIDGE", "USER_SCRIPTS_OFF", "EXPLORE_OFF", "PROTOCOL_MISMATCH", "SIGNED_OUT"]);

export interface RunOptions {
  /** Run the draft in <home>/drafts instead of the published tool. */
  draft?: boolean;
  /** Load <baseDir>/<name>/ instead (publish gate: a private staged copy of a draft). Wins over `draft`. */
  baseDir?: string;
  /** Page tools only: absolute path of a saved capture (.html). Runs the tool offline against it (page-eval) instead of in the user's tab. */
  capture?: string;
}

export async function runTool(name: string, input: unknown, opts: RunOptions = {}): Promise<unknown> {
  const tool = await loadTool(name, opts.baseDir ?? (opts.draft ? draftsDir() : toolsDir()));
  const { manifest } = tool;

  const vin = validate(manifest.input, input);
  if (!vin.ok) throw new InvalidInput(`${name}: ${vin.errors}`);

  if (opts.capture && manifest.kind !== "page") throw new InvalidInput(`${name}: only page tools run against a capture`);
  const runner = runners[opts.capture ? "page-eval" : (manifest.kind ?? "browser")];
  if (!runner) throw new ToolFailed(`${name}: no runner for kind "${manifest.kind}" in this build`);

  // Real visits (published, or a draft in the user's tab) honour minIntervalSec; capture runs and publish-gate copies never touch the site.
  const live = !opts.capture && !opts.baseDir;
  const rateKey = name; // one key per tool: a draft's live run and the published tool share the interval
  // Claim the slot now (check + write, no await between), so parallel and failing runs both count as visits.
  const release = live ? reserveInterval(rateKey, manifest.minIntervalSec) : () => {};

  // A write run is attempted exactly once: nothing below (or in a caller) re-invokes the tool, and a failure that reached the page keeps its slot.
  const isWrite = manifest.effect === "write";
  const dryRun = isWrite && (input as { dryRun?: unknown } | null)?.dryRun !== false;
  const write = isWrite ? new WriteState(dryRun, manifest.kind === "page" ? undefined : manifest.commitMarks) : undefined;
  const toolInput = isWrite ? { ...(input as object), dryRun } : input;

  const seconds = manifest.timeoutSec ?? 60;
  const ac = new AbortController();
  if (write) write.signal = ac.signal;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Timeout(seconds));
    }, seconds * 1000);
  });

  let result: unknown;
  try {
    result = await Promise.race([runner.run({ manifest, fn: tool.fn, dir: tool.dir, input: toolInput, signal: ac.signal, draft: !!(opts.draft || opts.baseDir), capture: opts.capture, write }), timeout]);
  } catch (e) {
    // Only failures that never reached the page give the slot back.
    const neverReached = (e instanceof WebsiteMcpError && NEVER_REACHED_PAGE.has(e.code)) || (e instanceof ToolFailed && e.preflight);
    if (neverReached) {
      try {
        release();
      } catch {
        /* an unreadable run-time record must not mask the original error */
      }
    }
    // A page write that reached the tab and then failed may have been saved by the user: say so rather than "not committed".
    if (write && manifest.kind === "page" && !neverReached && !(e instanceof InvalidInput) && !write.dryRun) write.pageUncertain = true;
    if (write && e instanceof WebsiteMcpError) e.outcome = write.outcome();
    if (e instanceof WebsiteMcpError && e.code === "CHALLENGE" && live) {
      // Stop for good: a blocked visit counts for the interval, and a mint may not spend more live runs.
      try {
        recordRun(rateKey);
      } catch (re) {
        // an unreadable run-time record must not mask the challenge or skip markChallenged
        process.stderr.write(`website-mcp: could not record the challenged visit: ${re instanceof Error ? re.message : String(re)}\n`);
      }
      if (opts.draft) markChallenged(join(draftsDir(), name), e.message);
    }
    if (e instanceof WebsiteMcpError) throw e;
    const failed = new ToolFailed(e instanceof Error ? e.message : String(e));
    if (write) failed.outcome = write.outcome();
    throw failed;
  } finally {
    clearTimeout(timer);
  }

  const vout = validate(manifest.output, result);
  if (!vout.ok) {
    const bad = new InvalidOutput(`${name}: ${vout.errors}`);
    if (write) bad.outcome = write.outcome(); // the write may already have committed: say so
    throw bad;
  }
  if (write) {
    // Write results always say what happened: the tool's own output sits under `result`.
    return { committed: write.committed, possibleCommit: write.possibleCommit, dryRun: write.dryRun, marksReached: [...write.reached].sort(), result };
  }
  return result;
}
