import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
  const prev = locked(() => {
    checkInterval(key, minIntervalSec, now);
    const p = read()[key];
    write({ ...read(), [key]: now });
    return p;
  });
  return () =>
    locked(() => {
      const data = read();
      if (data[key] !== now) return; // another run has claimed it since
      if (prev === undefined) delete data[key];
      else data[key] = prev;
      write(data);
    });
}

/** Cross-process mutex (O_EXCL lock file, short sync retry; a lock older than 5s is treated as stale). Runs fn under it. */
function locked<T>(fn: () => T): T {
  mkdirSync(join(homeDir(), "state"), { recursive: true, mode: 0o700 });
  const lock = `${file()}.lock`;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let acquired = false;
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      acquired = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5000) unlinkSync(lock);
      } catch {
        /* released meanwhile */
      }
      if (i > 400) break; // give up waiting: best-effort guard, never wedge a run
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        unlinkSync(lock);
      } catch {
        /* already gone */
      }
    }
  }
}

function write(data: Record<string, number>): void {
  mkdirSync(join(homeDir(), "state"), { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data) + "\n", { mode: 0o600 });
  renameSync(tmp, file());
}

/** Remember that `key` just ran (a visit: success, failure or a challenge). */
export function recordRun(key: string, now = Date.now()): void {
  locked(() => {
    let cur: Record<string, number> = {};
    try {
      cur = read();
    } catch {
      /* an unreadable record is overwritten here: this is the write path */
    }
    write({ ...cur, [key]: now });
  });
}
