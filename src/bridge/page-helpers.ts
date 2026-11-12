import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Text of extension/page-helpers.js (a single expression evaluating to the in-page `wm` helper object). */
export function readPageHelpers(): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extension", "page-helpers.js"), "utf8");
}
