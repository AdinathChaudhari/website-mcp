/**
 * Page-bridge wire protocol (versioned JSON). Same messages on both hops:
 *   CLI/MCP client <-(newline-delimited JSON, Unix socket)-> host <-(4-byte-length native messaging)-> extension.
 * Every request carries an `id`; the matching `result` echoes it.
 */
export const PROTOCOL_VERSION = 1;
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
  input: unknown;
  urlPattern?: string;
  origins: string[];
  world: "USER_SCRIPT" | "MAIN";
  tab: "existing";
  timeoutMs: number;
  needsVisible?: boolean;
}
export type Request =
  | RunRequest
  | { id: string; type: "tabs"; origins?: string[] }
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
