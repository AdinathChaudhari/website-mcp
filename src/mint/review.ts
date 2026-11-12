import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InvalidInput } from "../runtime/errors.js";
import { hashCases, hashSource } from "./tests.js";

export type Verdict = "allow" | "deny";
export interface Finding {
  severity: "info" | "warn" | "block";
  message: string;
}
export interface Review {
  verdict: Verdict;
  findings: Finding[];
  /** hashSource() of the draft the reviewer read. A review only counts for exactly that source + manifest. */
  sourceHash: string;
  reviewedAt: string;
  /** Tool name the review was written for; a review copied from another draft does not count. */
  name: string;
  /** hashCases() of tests/cases.json at review time ("" when there are none); editing the cases makes the review stale. */
  casesHash: string;
}

const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_FINDINGS = 100;
const MAX_MESSAGE = 2000;

/** Accepts strings or { severity?, message }. Strings become "info". */
export function parseFindings(raw: unknown): Finding[] {
  if (!Array.isArray(raw)) throw new InvalidInput("findings must be an array");
  if (raw.length > MAX_FINDINGS) throw new InvalidInput(`findings: at most ${MAX_FINDINGS} entries`);
  return raw.map((f, i) => {
    if (typeof f === "string") return { severity: "info" as const, message: f.slice(0, MAX_MESSAGE) };
    const o = f as { severity?: unknown; message?: unknown } | null;
    if (!o || typeof o !== "object" || typeof o.message !== "string" || !o.message) throw new InvalidInput(`findings[${i}] must be a string or { severity, message }`);
    const severity = o.severity ?? "info";
    if (severity !== "info" && severity !== "warn" && severity !== "block") throw new InvalidInput(`findings[${i}].severity must be "info", "warn" or "block"`);
    return { severity, message: o.message.slice(0, MAX_MESSAGE) };
  });
}

/** Validate and write <draftDir>/review.json. */
export function saveReview(draftDir: string, verdict: unknown, findings: unknown, sourceHash: unknown, name: string): Review {
  if (verdict !== "allow" && verdict !== "deny") throw new InvalidInput('verdict must be "allow" or "deny"');
  if (typeof sourceHash !== "string" || !HASH_RE.test(sourceHash)) throw new InvalidInput("sourceHash must be the 64-character hex hash of the draft you reviewed");
  const parsed = parseFindings(findings ?? []);
  if (!existsSync(join(draftDir, "tool.json")) || !existsSync(join(draftDir, "tool.mjs"))) throw new InvalidInput("no draft to review; save_tool first");
  const review: Review = { verdict, findings: parsed, sourceHash, reviewedAt: new Date().toISOString(), name, casesHash: hashCases(draftDir) };
  mkdirSync(draftDir, { recursive: true });
  writeFileSync(join(draftDir, "review.json"), JSON.stringify(review, null, 2) + "\n");
  return review;
}

export function readReview(dir: string): Review | undefined {
  const f = join(dir, "review.json");
  try {
    if (!statSync(f).isFile()) return undefined; // a directory or other non-file named review.json is "no review"
    const r = JSON.parse(readFileSync(f, "utf8")) as Partial<Review>;
    if (r && (r.verdict === "allow" || r.verdict === "deny") && typeof r.sourceHash === "string") {
      return { ...r, findings: Array.isArray(r.findings) ? r.findings : [] } as Review;
    }
  } catch {
    /* fall through: unreadable counts as no review */
  }
  return undefined;
}

/**
 * Why `dir` (a draft or a staged copy that includes review.json) may not be published, or undefined if the
 * review gate is satisfied. Needs: a review, verdict "allow", and a sourceHash equal to the hash of THIS source, the same tool name, and the same cases.
 */
export function reviewProblem(dir: string, name: string): string | undefined {
  const r = readReview(dir);
  if (!r) return "no review: run the website-mcp-reviewer subagent on the draft, then submit_review (or `website-mcp review <name>`)";
  if (r.verdict !== "allow") {
    const blocking = r.findings.filter((f) => f.severity === "block").map((f) => f.message);
    return `review verdict is "${r.verdict}"${blocking.length ? `: ${blocking.join("; ")}` : ""}; fix the draft and review it again`;
  }
  if (r.name !== name) return `review is for a different tool (${typeof r.name === "string" ? `"${r.name}"` : "no name recorded"}), not "${name}"; review this draft and submit_review again`;
  let current = "";
  try {
    current = hashSource(dir);
  } catch {
    return "the draft cannot be hashed (tool.json unreadable); fix it first";
  }
  if (r.sourceHash !== current) return "review is stale: tool.mjs or tool.json changed after it was reviewed; review the current draft and submit_review again";
  if (r.casesHash !== hashCases(dir)) return "review is stale: tests/cases.json changed after it was reviewed; review the current draft and submit_review again";
  return undefined;
}
