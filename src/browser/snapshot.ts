import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "../runtime/load.js";

export const CAP_BYTES = 16 * 1024;

export interface SnapshotPage {
  locator(selector: string): { ariaSnapshot(): Promise<string> };
}

export async function ariaSnapshot(page: SnapshotPage): Promise<string> {
  return page.locator("body").ariaSnapshot();
}

/** Returns text at most CAP_BYTES; otherwise spills the full text to <home>/spill and returns a head + pointer. */
export function capResult(text: string, label: string): string {
  const size = Buffer.byteLength(text, "utf8");
  if (size <= CAP_BYTES) return text;
  const dir = join(homeDir(), "spill");
  mkdirSync(dir, { recursive: true });
  const safe = label.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40) || "result";
  const n = readdirSync(dir).filter((f) => f.startsWith(`${safe}-`)).length + 1;
  const path = join(dir, `${safe}-${n}.txt`);
  writeFileSync(path, text);
  const note = `\n…[truncated: ${size} bytes total; full text saved to ${path}]`;
  const room = CAP_BYTES - Buffer.byteLength(note, "utf8");
  let head = Buffer.from(text, "utf8").subarray(0, Math.max(0, room)).toString("utf8");
  head = head.replace(/�$/, "");
  return head + note;
}
