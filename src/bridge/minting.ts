import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BridgeError, InvalidInput } from "../runtime/errors.js";
import { NAME_RE, draftsDir } from "../runtime/load.js";
import { bridgeRequest } from "./client.js";
import type { TabInfo } from "./protocol.js";

/** Largest capture we accept (the native-messaging limit browser -> host is 64 MiB; a signed-in page rarely needs more than a few). */
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
export const EXPLORE_TIMEOUT_MS = 20_000;

export async function pageTabs(): Promise<TabInfo[]> {
  const v = (await bridgeRequest({ type: "tabs" })) as TabInfo[];
  if (!Array.isArray(v)) throw new BridgeError("PROTOCOL_MISMATCH", "the extension answered `tabs` in the old format; reload it at chrome://extensions");
  return v.map((t) => ({ id: t.id, url: t.url, title: t.title ?? "", active: !!t.active, granted: !!t.granted, explore: !!t.explore }));
}

function tabId(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new InvalidInput("tabId must be an integer from page_tabs");
  return v;
}

/**
 * Refuses (EXPLORE_OFF / NO_TAB / SITE_NOT_GRANTED) before anything is sent unless the extension reports the explore
 * window open for this tab's site. The extension enforces it again on its side.
 */
export async function requireExploreWindow(id: number): Promise<TabInfo> {
  const tab = (await pageTabs()).find((t) => t.id === id);
  if (!tab) throw new BridgeError("NO_TAB", `no open tab ${id} that the extension can see; call page_tabs for the current list`);
  if (!tab.granted) throw new BridgeError("SITE_NOT_GRANTED", `Open ${tab.url} and click 'Allow this site' in the website-mcp extension popup, then retry`);
  if (!tab.explore) {
    throw new BridgeError(
      "EXPLORE_OFF",
      `The explore window is closed for this site. Ask the user to open the website-mcp extension popup on that tab and switch on "Explore this site" (it turns itself off after 15 minutes), then retry.`,
      { tabId: id, url: tab.url },
    );
  }
  return tab;
}

export async function pageSnapshot(args: { tabId?: unknown }): Promise<string> {
  const id = tabId(args.tabId);
  await requireExploreWindow(id);
  const v = await bridgeRequest({ type: "snapshot", tabId: id });
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

export async function pageExplore(args: { tabId?: unknown; code?: unknown }): Promise<unknown> {
  const id = tabId(args.tabId);
  if (typeof args.code !== "string" || !args.code.trim()) throw new InvalidInput("code must be a non-empty string (a function body; `return` the result)");
  await requireExploreWindow(id);
  const v = await bridgeRequest({ type: "explore", tabId: id, code: args.code, timeoutMs: EXPLORE_TIMEOUT_MS }, { timeoutMs: EXPLORE_TIMEOUT_MS + 3000 });
  return v === undefined ? null : v;
}

/** Save the tab's outerHTML as drafts/<name>/captures/<n>.html (+ <n>.json with url/title). Dir mode 700, files 600. */
export async function pageCapture(args: { tabId?: unknown; name?: unknown }): Promise<{ capture: string; bytes: number; url: string; title: string }> {
  const id = tabId(args.tabId);
  if (typeof args.name !== "string" || !NAME_RE.test(args.name)) throw new InvalidInput("name must be the draft's tool name (^[a-z][a-z0-9_]{1,62}$)");
  await requireExploreWindow(id);
  const v = (await bridgeRequest({ type: "capture", tabId: id }, { timeoutMs: 30_000 })) as { url?: unknown; title?: unknown; html?: unknown };
  if (!v || typeof v.html !== "string" || typeof v.url !== "string") throw new BridgeError("SCRIPT_ERROR", "the extension returned no HTML for that tab");
  const bytes = Buffer.byteLength(v.html, "utf8");
  if (bytes > MAX_CAPTURE_BYTES) throw new InvalidInput(`the page is ${bytes} bytes; captures are limited to ${MAX_CAPTURE_BYTES}. Navigate to a smaller view of it.`);
  const dir = join(draftsDir(), args.name, "captures");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // mkdir's mode is masked by umask and ignored for an existing dir
  const n = readdirSync(dir).filter((f) => /^\d+\.html$/.test(f)).reduce((m, f) => Math.max(m, parseInt(f, 10)), 0) + 1;
  const file = `${n}.html`;
  writeFileSync(join(dir, file), v.html, { mode: 0o600 });
  writeFileSync(join(dir, `${n}.json`), JSON.stringify({ url: v.url, title: String(v.title ?? ""), capturedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  return { capture: file, bytes, url: v.url, title: String(v.title ?? "") };
}
