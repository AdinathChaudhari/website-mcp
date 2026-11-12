import type { Locator, Page } from "playwright";

/** A selector string or an already-built Locator. */
export type Target = string | Locator;

const loc = (page: Page, t: Target): Locator => (typeof t === "string" ? page.locator(t) : t);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A transient error while the page navigates under us (context destroyed, frame detached). Retry those. */
const transient = (e: unknown) => /context was destroyed|navigation|detached|Target closed|Frame was/i.test(e instanceof Error ? e.message : String(e));

export interface WaitOptions {
  /** Give up after this many ms. Default 10000. */
  timeoutMs?: number;
  /** Poll interval in ms. Default 50. */
  pollMs?: number;
}

/**
 * Wait until one of several possible answers is on the page, and say which one.
 *
 * `outcomes` names EVERY answer a step can lead to, e.g. `{ results: "ul.results li", empty: ".empty", error: ".error" }`.
 * An outcome counts once its selector has a visible match. Resolves with the outcome's name. If several are
 * visible at the same moment, the one listed first wins. Throws, naming all outcomes and their selectors, if none
 * appears in time: waiting on one answer alone would hang the full timeout on the other, perfectly valid, answers.
 */
export async function waitForOutcome(page: Page, outcomes: Record<string, Target>, opts: WaitOptions = {}): Promise<string> {
  const names = Object.keys(outcomes);
  if (names.length === 0) throw new Error("waitForOutcome needs at least one outcome");
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const name of names) {
      try {
        if (await loc(page, outcomes[name]).first().isVisible()) return name;
      } catch (e) {
        if (!transient(e)) throw e;
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }
  const listing = names.map((n) => `${n} (${typeof outcomes[n] === "string" ? outcomes[n] : String(outcomes[n])})`).join(", ");
  throw new Error(`none of the expected outcomes appeared within ${timeoutMs}ms: ${listing}; page is at ${page.url()}`);
}

export interface PaginateOptions<T> {
  /** The control that goes to the next page. Collection stops when it is missing, hidden or disabled. */
  next: Target;
  /** Selector for one row on a page. Use this (with optional `extract`) OR `extractPage`. */
  item?: string;
  /** Turns one row locator into a value. Default: the row's trimmed innerText. */
  extract?: (row: Locator, index: number) => T | Promise<T>;
  /** Alternative to `item`: read a whole page at once. */
  extractPage?: (page: Page) => T[] | Promise<T[]>;
  /** Stop after this many pages (>= 1). Default 10. */
  maxPages?: number;
  /** Drop repeated rows. `true` compares rows as JSON; a function gives the row's own key (prefer a stable id). */
  dedupe?: boolean | ((row: T) => string);
  /**
   * Optional selector whose text marks "the page changed" when the URL does not (AJAX paging). With
   * `extractPage` the fingerprint is the URL only, so pass this (or the click throws "did not change the page").
   */
  changed?: string;
  /** How long to wait for a click on `next` to change the page. Default 10000. */
  timeoutMs?: number;
}

export interface PaginateResult<T> {
  rows: T[];
  /** Pages read. */
  pages: number;
  /** Why collection ended. */
  stopped: "no_next" | "max_pages" | "no_new_rows";
}

/** What a page "looks like", to notice that a click on next really moved on. */
async function fingerprint<T>(page: Page, o: PaginateOptions<T>): Promise<string> {
  let first = "";
  if (o.item) {
    const rows = page.locator(o.item);
    const n = await rows.count();
    first = `${n}|${n ? ((await rows.first().innerText()) ?? "").slice(0, 200) : ""}`;
  }
  let marker = "";
  if (o.changed) {
    const c = page.locator(o.changed).first();
    marker = (await c.count()) ? ((await c.innerText()) ?? "").slice(0, 200) : "";
  }
  return `${page.url()}|${first}|${marker}`;
}

/** After the page changed: let the document load and (with `item`) the row count stop moving, so extraction does not read half a page. */
async function settle<T>(page: Page, o: PaginateOptions<T>): Promise<void> {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 });
  } catch {
    /* proceed with what is there */
  }
  if (!o.item) return;
  const rows = page.locator(o.item);
  let last = -1;
  let stable = 0;
  const end = Date.now() + 2000;
  while (stable < 2 && Date.now() < end) {
    let n = -1;
    try {
      n = await rows.count();
    } catch (e) {
      if (!transient(e)) throw e;
    }
    stable = n === last && n >= 0 ? stable + 1 : 0;
    last = n;
    await sleep(80);
  }
}

async function isUsable(l: Locator): Promise<boolean> {
  const first = l.first();
  if ((await l.count()) === 0) return false;
  if (!(await first.isVisible())) return false;
  return await first.isEnabled();
}

/**
 * Collect rows across pages by clicking a "next" control. Stops when there is no usable next control, after
 * `maxPages`, or (with `dedupe`) when a page adds nothing new. The caller has already navigated to page 1.
 * After each click it waits until the URL, the first row or the `changed` marker changed, then for the document and row count to settle; if nothing changes it throws instead of
 * looping on the same page. For a result the caller returns to the model, keep `maxPages` small.
 */
export async function paginate<T = string>(page: Page, o: PaginateOptions<T>): Promise<PaginateResult<T>> {
  if (!!o.item === !!o.extractPage) throw new Error("paginate needs exactly one of `item` or `extractPage`");
  const maxPages = o.maxPages ?? 10;
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("paginate: maxPages must be an integer >= 1");
  const timeoutMs = o.timeoutMs ?? 10_000;
  const keyOf = o.dedupe === true ? (r: T) => JSON.stringify(r) : typeof o.dedupe === "function" ? o.dedupe : undefined;
  const seen = new Set<string>();
  const rows: T[] = [];
  const nextLoc = loc(page, o.next);

  for (let pages = 1; ; pages++) {
    let batch: T[];
    if (o.extractPage) batch = await o.extractPage(page);
    else {
      const list = page.locator(o.item as string);
      const n = await list.count();
      batch = [];
      for (let i = 0; i < n; i++) {
        const row = list.nth(i);
        batch.push(o.extract ? await o.extract(row, i) : (((await row.innerText()) ?? "").trim() as unknown as T));
      }
    }
    let added = 0;
    for (const r of batch) {
      if (keyOf) {
        const k = keyOf(r);
        if (seen.has(k)) continue;
        seen.add(k);
      }
      rows.push(r);
      added++;
    }
    if (keyOf && added === 0) return { rows, pages, stopped: "no_new_rows" };
    if (pages >= maxPages) return { rows, pages, stopped: "max_pages" };
    if (!(await isUsable(nextLoc))) return { rows, pages, stopped: "no_next" };

    const before = await fingerprint(page, o);
    await nextLoc.first().click({ timeout: timeoutMs });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let now = before;
      try {
        now = await fingerprint(page, o);
      } catch (e) {
        if (!transient(e)) throw e;
      }
      if (now !== before) {
        await settle(page, o);
        break;
      }
      if (Date.now() >= deadline) throw new Error(`paginate: clicking next on page ${pages} did not change the page within ${timeoutMs}ms (still ${page.url()}); wrong next control or a site that needs a different wait`);
      await sleep(50);
    }
  }
}
