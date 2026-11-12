import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tempHome, rm } from "../helpers/index.mjs";

const home = tempHome("wm-unit-rate-");
process.env.WEBSITE_MCP_HOME = home;
const { checkInterval, recordRun } = await import("../../dist/runtime/rate.js");
const { TooSoon } = await import("../../dist/runtime/errors.js");
after(() => rm(home));

test("minIntervalSec: first run passes, a run inside the interval is TOO_SOON with the seconds left, after it passes", () => {
  checkInterval("t1", 60, 1_000_000); // never ran
  recordRun("t1", 1_000_000);
  assert.throws(() => checkInterval("t1", 60, 1_000_000 + 20_000), (e) => e instanceof TooSoon && e.code === "TOO_SOON" && e.details.remainingSec === 40 && /40s/.test(e.message));
  checkInterval("t1", 60, 1_000_000 + 60_000);
  checkInterval("t1", undefined, 1_000_001);
  checkInterval("t1", 0, 1_000_001);
  checkInterval("other", 60, 1_000_001); // per tool
});
test("the record is on disk (survives a restart), private, and an unreadable file fails closed", () => {
  const f = join(home, "state", "last-run.json");
  assert.ok(existsSync(f));
  assert.equal(statSync(f).mode & 0o077, 0);
  writeFileSync(f, "garbage");
  assert.throws(() => checkInterval("t1", 60), TooSoon);
});
