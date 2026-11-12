import { chromium } from "playwright";
import { paginate, waitForOutcome } from "../../browser/waits.js";
import { InvalidInput, ToolFailed } from "../errors.js";
import type { Runner, RunContext } from "./types.js";

/** The helper object handed to every tool as `wm`. Kept tiny; later phases extend it. */
export function makeHelper() {
  return {
    InvalidInput,
    /** Wait for whichever of several named outcomes appears first; resolves with its name. */
    waitForOutcome,
    /** Collect rows across pages by clicking next. See src/browser/waits.ts. */
    paginate,
    log: (...args: unknown[]) => {
      // stderr only: stdout is reserved for results and the MCP transport.
      process.stderr.write(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n");
    },
  };
}

export class PlaywrightRunner implements Runner {
  readonly kind = "browser";

  async run(ctx: RunContext): Promise<unknown> {
    const origins = ctx.manifest.site?.allowedOrigins;
    if (!Array.isArray(origins) || origins.length === 0) {
      throw new ToolFailed(`${ctx.manifest.name}: site.allowedOrigins is missing; refusing to run (fail closed)`);
    }
    const headed = process.env.WEBSITE_MCP_HEADED === "1";
    const browser = await chromium.launch({ headless: !headed });
    const onAbort = () => void browser.close().catch(() => {});
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      {
        await context.route("**/*", (route) => {
          const url = route.request().url();
          if (!/^https?:/i.test(url)) return route.continue();
          let origin = "";
          try {
            origin = new URL(url).origin;
          } catch {
            return route.abort();
          }
          return origins.includes(origin) ? route.continue() : route.abort("blockedbyclient");
        });
      }
      return await ctx.fn({ page, input: ctx.input, wm: makeHelper() });
    } catch (e) {
      if (e instanceof InvalidInput) throw e;
      if (e instanceof ToolFailed) throw e;
      throw new ToolFailed(e instanceof Error ? e.message : String(e));
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }
}
