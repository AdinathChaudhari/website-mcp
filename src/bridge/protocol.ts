/**
 * Page-bridge wire protocol (versioned JSON). Same messages on both hops:
 *   CLI/MCP client <-(newline-delimited JSON, Unix socket)-> host <-(4-byte-length native messaging)-> extension.
 * Every request carries an `id`; the matching `result` echoes it.
 */
export const PROTOCOL_VERSION = 2;
/**
 * Protocol history.
 *  1: hello, status, tabs{origins}, run.
 *  2 (Phase 5): per-version approval (`run` is answered NEEDS_APPROVAL until the user approves the hash), `signin`
 *     marker on `run`, `draft` flag on `run`, tabs list every http(s) tab with title/granted/explore, and the
 *     minting requests `snapshot`, `explore`, `capture`. An extension that speaks 1 can still list tabs, but
 *     every other request is refused with PROTOCOL_MISMATCH (see PROTOCOL_V2_ONLY): a v1 extension has no
 *     approval gate, so it must never run a page tool.
 */
export const PROTOCOL_V2_ONLY: readonly string[] = ["run", "snapshot", "explore", "capture"];
export const HOST_NAME = "dev.website_mcp.bridge";
/** Chrome's limit for a message sent host -> browser. */
export const MAX_HOST_TO_BROWSER = 1024 * 1024;
/** Chrome's limit for a message sent browser -> host. */
export const MAX_BROWSER_TO_HOST = 64 * 1024 * 1024;

export const BRIDGE_ERROR_CODES = [
  "NO_BRIDGE",
  "NO_TAB",
  "SITE_NOT_GRANTED",
  "USER_SCRIPTS_OFF",
  "TAB_HIDDEN",
  "TIMEOUT",
  "SCRIPT_ERROR",
  "PROTOCOL_MISMATCH",
  /** The user has not approved this exact tool version/hash in the extension popup. */
  "NEEDS_APPROVAL",
  /** The signin.json marker was not found in the tab. */
  "SIGNED_OUT",
  /** The popup's explore window for this site is closed (the user opens it in the popup for 1 hour, 1 day, or until the browser closes). */
  "EXPLORE_OFF",
  /** The page showed a captcha, a checkpoint or a block. The run stops at once and is never retried. */
  "CHALLENGE",
] as const;
export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

export interface RunRequest {
  id: string;
  type: "run";
  toolName: string;
  version?: number;
  /** Source hash of the tool; the extension's approval (Phase 5) keys on it. */
  hash: string;
  /** A function expression, e.g. `async ({ input, wm }) => ...`. */
  source: string;
  /** Page tools: signed-in marker, checked in the tab before the script runs (SIGNED_OUT when absent). */
  signin?: { marker: string; loginUrl: string };
  /** True for a draft (not yet published): no approval; the extension allows it only while the explore window is open. */
  draft?: boolean;
  input: unknown;
  urlPattern?: string;
  origins: string[];
  world: "USER_SCRIPT" | "MAIN";
  tab: "existing";
  timeoutMs: number;
  needsVisible?: boolean;
  /** Write tools: the extension wraps the value as { value, committed }, arms the helpers with dryRun and shows a badge while waiting. */
  effect?: "write";
  dryRun?: boolean;
}
/** Result of `tabs`: every open http(s) tab the extension can see. `granted` = the user allowed the tab's site; `explore` = the explore window is open for it. */
export interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
  granted: boolean;
  explore: boolean;
}
export type Request =
  | RunRequest
  /** `origins` (v1) filters to granted tabs of those origins; omitted = all tabs, as TabInfo[]. */
  | { id: string; type: "tabs"; origins?: string[] }
  /** DOM outline of a tab (roles, accessible names, trimmed text). Value: string. Needs the explore window. */
  | { id: string; type: "snapshot"; tabId: number }
  /** Run model-written code (a function body, `return` the result) in the tab. Needs the explore window. Value: JSON. */
  | { id: string; type: "explore"; tabId: number; code: string; timeoutMs: number }
  /** outerHTML of the tab. Value: { url, title, html }. Needs the explore window. */
  | { id: string; type: "capture"; tabId: number }
  | { id: string; type: "status" }
  | { id: string; type: "hello"; version: number; extVersion?: string };

export interface ErrorBody {
  code: BridgeErrorCode;
  message: string;
  details?: unknown;
}
export type Result = { id: string; type: "result"; ok: true; value: unknown } | { id: string; type: "result"; ok: false; error: ErrorBody };

export const okResult = (id: string, value: unknown): Result => ({ id, type: "result", ok: true, value });
export const errResult = (id: string, code: BridgeErrorCode, message: string, details?: unknown): Result => ({
  id,
  type: "result",
  ok: false,
  error: { code, message, ...(details !== undefined ? { details } : {}) },
});

/** Native messaging framing: 4-byte little-endian length, then UTF-8 JSON. */
export function encodeFrame(msg: unknown, max = MAX_HOST_TO_BROWSER): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  if (body.length > max) throw new RangeError(`message is ${body.length} bytes, over the ${max}-byte native messaging limit`);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Chunk-safe decoder: push arbitrary byte chunks, get whole messages back. Throws on an oversize frame. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly max = MAX_BROWSER_TO_HOST) {}
  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > this.max) throw new RangeError(`incoming frame of ${len} bytes exceeds ${this.max}`);
      if (this.buf.length < 4 + len) break;
      out.push(JSON.parse(this.buf.subarray(4, 4 + len).toString("utf8")));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}
