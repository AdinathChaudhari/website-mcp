import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InvalidInput } from "../runtime/errors.js";
import { NAME_RE, draftsDir, readManifest, toolsDir } from "../runtime/load.js";
import { runTool } from "../runtime/run.js";
import { saveReview, type Review } from "./review.js";
import { liveCapFor, liveRunsUsed, reserveLiveRun } from "./live.js";
import { publishDraft, staticChecks, type PublishResult } from "./publish.js";
import { hashCases, hashSource, parseCases, readLastRun, runCases, type LastRun } from "./tests.js";

/** Names the MCP server uses for its own tools; a minted tool may not take them. */
export const RESERVED_NAMES = ["open", "snapshot", "explore", "save_tool", "save_cases", "test_tool", "publish_tool", "list_tools", "run_tool", "guide", "submit_review", "page_tabs", "page_snapshot", "page_explore", "page_capture"];

export interface MintSessionOptions {
  /** Called after a successful publish (the server uses it to send tools/list_changed). */
  onPublished?: (name: string, version: number) => void;
}

/** Owns the draft folders in <home>/drafts/<name>/ and the draft -> test -> publish loop. No model involved. */
export class MintSession {
  /** Runs this session recorded itself (in memory only). publish trusts these, never a last-run.json on disk. */
  private readonly ownRuns = new Map<string, LastRun>();
  /** Page tools: source hashes that passed a live run in this session (memory only, like ownRuns). */
  private readonly livePasses = new Map<string, string>();

  constructor(private readonly opts: MintSessionOptions = {}) {}

  draftDir(name: string): string {
    this.assertName(name);
    return join(draftsDir(), name);
  }

  private assertName(name: unknown): asserts name is string {
    if (typeof name !== "string" || !NAME_RE.test(name) || RESERVED_NAMES.includes(name)) {
      throw new InvalidInput("name must match ^[a-z][a-z0-9_]{1,62}$ and not clash with a built-in tool");
    }
  }

  /** Validate and write tool.json + tool.mjs into the draft folder. Draft manifests carry no version. */
  saveDraft(name: unknown, tool: unknown, source: unknown, signin?: unknown) {
    this.assertName(name);
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw new InvalidInput("tool must be an object");
    if (typeof source !== "string" || !/export\s+default/.test(source)) throw new InvalidInput("source must be tool.mjs text with a default export");
    const dir = this.draftDir(name);
    const manifest = { ...(tool as Record<string, unknown>), name, kind: (tool as { kind?: unknown }).kind ?? "browser" };
    delete (manifest as { version?: unknown }).version;
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "tool.json"), JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(join(dir, "tool.mjs"), source);
    // signin.json belongs to the draft exactly as given: saving without it removes a stale one.
    if (signin !== undefined && signin !== null) writeFileSync(join(dir, "signin.json"), JSON.stringify(signin, null, 2) + "\n");
    else rmSync(join(dir, "signin.json"), { force: true });
    // Static checks give instant feedback, but a draft is still saved so it can be fixed in place.
    const problems = staticChecks(dir).filter((r) => r.code !== "no_draft");
    const published = existsSync(join(toolsDir(), name, "tool.json")) ? readManifest(name).version : undefined;
    return {
      saved: name,
      draft: dir,
      publishedVersion: published ?? null,
      problems: problems.map((p) => p.message),
      /** Hash of tool.mjs + tool.json. The reviewer reports it back; submit_review and publish compare it. */
      sourceHash: hashSource(dir),
      next:
        manifest.kind === "page"
          ? 'page tool: save_cases (>=3 capture cases naming a capture from page_capture), test_tool, ONE live run (run_tool draft:true with the explore window open), review, submit_review, publish_tool, then the user approves it in the extension popup'
          : "save_cases (>=3, include an empty and an invalid_input case), test_tool, review with the website-mcp-reviewer subagent, submit_review, publish_tool",
    };
  }

  saveCases(name: unknown, cases: unknown) {
    this.assertName(name);
    const parsed = parseCases(cases);
    const dir = this.draftDir(name);
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "tests", "cases.json"), JSON.stringify(parsed, null, 2) + "\n");
    return { saved: name, cases: parsed.length };
  }

  async testDraft(name: string): Promise<LastRun> {
    const dir = this.draftDir(name);
    if (!existsSync(join(dir, "tool.json"))) throw new InvalidInput(`no draft named ${name}`);
    const m = JSON.parse(readFileSync(join(dir, "tool.json"), "utf8")) as { resultsPath?: string };
    const run = await runCases(name, dir, { draft: true, version: null, resultsPath: m.resultsPath, reserveLive: () => this.reserveLive(name) });
    this.ownRuns.set(name, run);
    if (run.results.some((r) => r.mode === "live" && r.pass)) this.livePasses.set(name, run.sourceHash);
    return run;
  }

  async testPublished(name: string): Promise<LastRun> {
    this.assertName(name);
    const m = readManifest(name);
    return runCases(name, join(toolsDir(), name), { draft: false, version: Number(m.version) || 1, resultsPath: m.resultsPath });
  }

  /** Count one live run against this draft's budget (throws LiveCapReached). */
  private reserveLive(name: string): void {
    const dir = this.draftDir(name);
    let m: { hardTarget?: unknown } | undefined;
    try {
      m = JSON.parse(readFileSync(join(dir, "tool.json"), "utf8"));
    } catch {
      /* default cap */
    }
    reserveLiveRun(dir, liveCapFor(m));
  }

  /** Live runs used / allowed for a page-tool draft. */
  liveBudget(name: string): { used: number; cap: number } {
    const dir = this.draftDir(name);
    let m: { hardTarget?: unknown } | undefined;
    try {
      m = JSON.parse(readFileSync(join(dir, "tool.json"), "utf8"));
    } catch {
      /* default cap */
    }
    return { used: liveRunsUsed(dir), cap: liveCapFor(m) };
  }

  async runDraft(name: string, input: unknown): Promise<unknown> {
    this.assertName(name);
    const dir = this.draftDir(name);
    let kind = "browser";
    try {
      kind = (JSON.parse(readFileSync(join(dir, "tool.json"), "utf8")) as { kind?: string }).kind ?? "browser";
    } catch {
      /* runTool reports the missing draft */
    }
    if (kind !== "page") return runTool(name, input, { draft: true });
    // A page-tool draft run is a LIVE run in the user's tab: capped, and a pass is recorded for publish.
    this.reserveLive(name);
    const before = hashSource(dir);
    const out = await runTool(name, input, { draft: true });
    if (hashSource(dir) === before) this.livePasses.set(name, before); // an edit during the run is not live-proven
    return out;
  }

  /** Last run state for a draft, and whether it is current for the draft's source and cases. */
  draftStatus(name: string) {
    const dir = this.draftDir(name);
    const run = readLastRun(dir);
    const fresh = !!run && run.sourceHash === hashSource(dir) && run.casesHash === hashCases(dir);
    return { run, fresh };
  }

  /** Record a reviewer's verdict for the draft. It counts only while the draft's source hash still equals `sourceHash`. */
  submitReview(name: unknown, verdict: unknown, findings: unknown, sourceHash: unknown): { saved: string; review: Review; currentHash: string; current: boolean } {
    this.assertName(name);
    const dir = this.draftDir(name);
    const review = saveReview(dir, verdict, findings, sourceHash, name);
    const currentHash = hashSource(dir);
    return { saved: name, review, currentHash, current: review.sourceHash === currentHash };
  }

  async publish(name: unknown): Promise<PublishResult> {
    this.assertName(name);
    if (!existsSync(join(this.draftDir(name), "tool.json"))) throw new InvalidInput(`no draft named ${name}`);
    const result = await publishDraft(name, this.draftDir(name), { trustedRun: this.ownRuns.get(name), ...(this.livePasses.has(name) ? { liveProof: { sourceHash: this.livePasses.get(name) as string } } : {}) });
    this.opts.onPublished?.(name, result.version);
    return result;
  }
}
