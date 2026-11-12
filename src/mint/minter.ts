// The model seam: interfaces only, no implementation, no provider import.
// Claude Code is one minter (it drives MintSession through the MCP tools). Any other minter,
// such as a local model or a hosted API, drives the same MintSession methods through these types.
// See docs/model-seam.md.

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** One model turn: free text plus any tool calls it wants made. */
export interface ChatModel {
  complete(req: { system: string; messages: ChatMessage[]; tools: ToolSpec[] }): Promise<{ text: string; toolCalls: ToolCall[] }>;
}

export interface ReviewFinding {
  severity: "block" | "warn" | "info";
  message: string;
}

/** A second reader of a draft before publish. The verdict is stored against the source hash it reviewed. */
export interface Reviewer {
  review(bundle: { name: string; manifest: unknown; source: string; cases: unknown }): Promise<{ verdict: "allow" | "deny"; findings: ReviewFinding[] }>;
}
