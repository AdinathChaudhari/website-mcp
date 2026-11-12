import { ToolFailed } from "./errors.js";

/**
 * What a write run did, kept by the runtime (never by the tool). `committed` = a wm.commit callback ran to the end
 * (or, for a page tool, the page showed the user's Save). `possibleCommit` = a commit was entered and did not finish
 * (error, kill, timeout), so the change may or may not have happened. The runtime never retries a write.
 */
export class WriteState {
  /** Marks wm.commit was called with, including in a dry run (that is the proof a mark is reachable). */
  readonly reached = new Set<string>();
  private readonly done = new Set<string>();
  /** Marks whose commit started and has not finished OK (failed or still running); sticky, so a later commit cannot hide them. */
  private readonly entered = new Set<string>();
  /** Page tools: the extension reported the user's Save. */
  pageCommitted = false;
  /** Page tools: the run reached the tab and then failed, so a Save by the user cannot be ruled out. */
  pageUncertain = false;
  /** The run's abort signal: after a timeout the outcome was already reported, so a late wm.commit must not start. */
  signal?: AbortSignal;

  constructor(
    readonly dryRun: boolean,
    /** Declared commitMarks; undefined = any name (the minting `act` tool). */
    private readonly marks?: string[],
  ) {}

  /** wm.commit: the only place a browser write tool may save or submit. Skips fn in a dry run. */
  async commit<T>(mark: unknown, fn: unknown): Promise<T | undefined> {
    if (typeof mark !== "string" || typeof fn !== "function") throw new ToolFailed("wm.commit(mark, fn) needs a mark name and a function");
    if (this.marks && !this.marks.includes(mark)) throw new ToolFailed(`wm.commit("${mark}"): not listed in tool.json commitMarks (${this.marks.join(", ")})`);
    if (this.signal?.aborted) throw new ToolFailed("wm.commit refused: the run was aborted (timed out), so nothing is committed");
    this.reached.add(mark);
    if (this.dryRun) return undefined;
    this.entered.add(mark);
    const r = (await fn()) as T;
    this.done.add(mark);
    this.entered.delete(mark);
    return r;
  }

  get committed(): boolean {
    return this.done.size > 0 || this.pageCommitted;
  }
  get possibleCommit(): boolean {
    return this.entered.size > 0 || this.pageUncertain;
  }
  outcome(): { committed: boolean; possibleCommit: boolean } {
    return { committed: this.committed, possibleCommit: this.possibleCommit };
  }
}
