import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LiveCapReached } from "../runtime/errors.js";

/** Live runs a mint may spend on the real site: attempts, not passes. A hard target (bot-sensitive) gets fewer. */
export const LIVE_CAP = 4;
export const LIVE_CAP_HARD = 2;

export const liveCapFor = (manifest: { hardTarget?: unknown } | undefined): number => (manifest?.hardTarget === true ? LIVE_CAP_HARD : LIVE_CAP);

const file = (draftDir: string): string => join(draftDir, "live-runs.json");

/** Live runs already spent by this draft. Lives on disk so a server restart does not hand out a fresh budget. */
export function liveRunsUsed(draftDir: string): number {
  try {
    if (!existsSync(file(draftDir))) return 0;
    const n = Number((JSON.parse(readFileSync(file(draftDir), "utf8")) as { count?: unknown }).count);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    // Unreadable counter: fail closed (treat the budget as spent), never hand out a fresh one.
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Count one live run, or throw LiveCapReached when the budget is used up. Call before touching the site. */
export function reserveLiveRun(draftDir: string, cap: number): number {
  const used = liveRunsUsed(draftDir);
  if (used >= cap) {
    throw new LiveCapReached(
      `live-run budget used up (${cap} per mint${cap === LIVE_CAP_HARD ? ", the hard-target limit" : ""}). Rely on capture cases from here: capture the page again with page_capture and test against it.`,
    );
  }
  mkdirSync(draftDir, { recursive: true });
  writeFileSync(file(draftDir), JSON.stringify({ count: used + 1, cap, updatedAt: new Date().toISOString() }) + "\n");
  return used + 1;
}
