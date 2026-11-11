export type ErrorCode =
  | "tool_not_found"
  | "invalid_input"
  | "invalid_output"
  | "tool_failed"
  | "timeout"
  | "publish_refused";

export class WebsiteMcpError extends Error {
  readonly code: ErrorCode;
  /** Optional structured detail (e.g. publish refusal reasons), included in the JSON payload. */
  readonly details?: unknown;
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

export function toErrorPayload(e: unknown): { error: { code: string; message: string; reasons?: unknown } } {
  if (e instanceof WebsiteMcpError) {
    return { error: { code: e.code, message: e.message, ...(e.details !== undefined ? { reasons: e.details } : {}) } };
  }
  return { error: { code: "tool_failed", message: e instanceof Error ? e.message : String(e) } };
}
