export type ErrorCode =
  | "tool_not_found"
  | "invalid_input"
  | "invalid_output"
  | "tool_failed"
  | "timeout"
  | "publish_refused"
  | "live_cap"
  // page-bridge codes (kept upper-case: they are the wire codes from src/bridge/protocol.ts)
  | "NO_BRIDGE"
  | "NO_TAB"
  | "SITE_NOT_GRANTED"
  | "USER_SCRIPTS_OFF"
  | "TAB_HIDDEN"
  | "TIMEOUT"
  | "SCRIPT_ERROR"
  | "PROTOCOL_MISMATCH"
  | "NEEDS_APPROVAL"
  | "SIGNED_OUT"
  | "EXPLORE_OFF"
  | "CHALLENGE"
  | "TOO_SOON";

export class WebsiteMcpError extends Error {
  readonly code: ErrorCode;
  /** Optional structured detail (e.g. publish refusal reasons), included in the JSON payload. */
  readonly details?: unknown;
  /** Write tools only: what is known about the change when the run failed. Set by runTool, never by a tool. */
  outcome?: { committed: boolean; possibleCommit: boolean };
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class ToolNotFound extends WebsiteMcpError {
  constructor(name: string) {
    super("tool_not_found", `Tool not found: ${name}`);
  }
}
export class InvalidInput extends WebsiteMcpError {
  constructor(message: string) {
    super("invalid_input", message);
  }
}
export class InvalidOutput extends WebsiteMcpError {
  constructor(message: string) {
    super("invalid_output", message);
  }
}
export class ToolFailed extends WebsiteMcpError {
  constructor(message: string) {
    super("tool_failed", message);
  }
}
export class Timeout extends WebsiteMcpError {
  constructor(seconds: number) {
    super("timeout", `Tool timed out after ${seconds}s`);
  }
}

export class PublishRefused extends WebsiteMcpError {
  constructor(message: string, reasons: unknown) {
    super("publish_refused", message, reasons);
  }
}

/** A minting session used up its live runs against the real site (4 per mint, 2 for a hard target). */
export class LiveCapReached extends WebsiteMcpError {
  constructor(message: string) {
    super("live_cap", message);
  }
}

/** minIntervalSec: the tool ran too recently. Refused before anything touches the site. */
export class TooSoon extends WebsiteMcpError {
  constructor(message: string, details: { remainingSec: number; minIntervalSec: number }) {
    super("TOO_SOON", message, details);
  }
}

export class BridgeError extends WebsiteMcpError {
  constructor(code: Extract<ErrorCode, Uppercase<ErrorCode>>, message: string, details?: unknown) {
    super(code, message, details);
  }
}

export function toErrorPayload(e: unknown): { error: { code: string; message: string; reasons?: unknown; committed?: boolean; possibleCommit?: boolean } } {
  if (e instanceof WebsiteMcpError) {
    return { error: { code: e.code, message: e.message, ...(e.details !== undefined ? { reasons: e.details } : {}), ...(e.outcome ?? {}) } };
  }
  return { error: { code: "tool_failed", message: e instanceof Error ? e.message : String(e) } };
}
