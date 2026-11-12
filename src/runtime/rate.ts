import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "./load.js";
import { TooSoon } from "./errors.js";

/**
 * minIntervalSec: when each tool last ran for real, kept in <home>/state/last-run.json so it survives restarts and
 * is shared by the CLI and the MCP server. One key per tool name: a draft run in the user's tab and the published tool share it. Offline capture runs never touch it. Not tamper-proof (it is the user's own folder); it stops
 * a loop, a retry or a hurried model from hammering a site.
 */
const file = (): string => join(homeDir(), "state", "last-run.json");

function read(): Record<string, number> {
  if (!existsSync(file())) return {};
  try {
    const v = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(v).filter(([, t]) => typeof t === "number" && Number.isFinite(t))) as Record<string, number>;
  } catch {
    // Unreadable: fail closed rather than forget when the last run was.
    throw new TooSoon(`the run-time record (${file()}) is unreadable, so the minimum interval cannot be checked; fix or delete that file`, { remainingSec: 0, minIntervalSec: 0 });
  }
}

/** Throws TOO_SOON (with the seconds left) when `key` ran less than minIntervalSec ago. No-op without an interval. */
export function checkInterval(key: string, minIntervalSec: number | undefined, now = Date.now()): void {
  if (!minIntervalSec || minIntervalSec <= 0) return;
  const last = read()[key];
  if (last === undefined) return;
  const remaining = Math.ceil(minIntervalSec - (now - last) / 1000);
  if (remaining > 0) {
    throw new TooSoon(`${key.replace(/^draft:/, "")} ran ${Math.round((now - last) / 1000)}s ago and may run once every ${minIntervalSec}s. Try again in ${remaining}s. Nothing was sent to the site.`, {
      remainingSec: remaining,
      minIntervalSec,
    });
  }
}

/**
 * Check and claim the slot in one synchronous step (no await between them), so parallel runs cannot all pass.
 * Returns a function that gives the slot back (for a failure that never reached the page). No-op without an interval.
 */
export function reserveInterval(key: string, minIntervalSec: number | undefined, now = Date.now()): () => void {
  if (!minIntervalSec || minIntervalSec <= 0) return () => {};
  checkInterval(key, minIntervalSec, now);
  const prev = read()[key];
  recordRun(key, now);
  return () => {
    const data = read();
    if (data[key] !== now) return; // another run has claimed it since
    if (prev === undefined) delete data[key];
    else data[key] = prev;
    write(data);
  };
}

function write(data: Record<string, number>): void {
  mkdirSync(join(homeDir(), "state"), { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data) + "\n", { mode: 0o600 });
  renameSync(tmp, file());
}

/** Remember that `key` just ran (a visit: success, failure or a challenge). */
export function recordRun(key: string, now = Date.now()): void {
  write({ ...read(), [key]: now });
}
