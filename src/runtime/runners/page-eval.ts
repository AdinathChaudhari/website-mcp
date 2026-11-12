import { existsSync, readFileSync } from "node:fs";
import { chromium } from "playwright";
import { readPageHelpers } from "../../bridge/page-helpers.js";
import { readSignin } from "../../mint/signin.js";
import { BridgeError, ToolFailed, WebsiteMcpError } from "../errors.js";
import type { RunContext, Runner } from "./types.js";

const DEFAULT_URL = "https://capture.invalid/";

/**
 * The same code the extension injects (extension/lib.js composeCode): the helpers text as `wm`, the tool's default
 * export called with { input, wm }. Kept textually parallel on purpose, so a capture run exercises what the tab runs.
 */
export function composeEval(source: string, input: unknown, helpersText: string): string {
  return (
    `(async()=>{const wm=${helpersText};const ch=()=>{try{const c=wm.challenge();return c?{ok:false,challenge:c}:null}catch(e){return null}};` +
    `try{const c=ch();if(c)return c;const v=await (${source})({input:${JSON.stringify(input ?? null)},wm});return ch()||{ok:true,value:v};}` +
    `catch(e){return ch()||{ok:false,message:String((e&&e.message)||e)};}})()`
  );
}

/** <name>.json next to <name>.html (written by page_capture): the page's URL, so location.* matches the live page. */
function captureUrl(htmlPath: string): string {
  const meta = htmlPath.replace(/\.html$/, ".json");
  try {
    if (existsSync(meta)) {
      const u = new URL(String((JSON.parse(readFileSync(meta, "utf8")) as { url?: unknown }).url));
      if (u.protocol === "https:" || u.protocol === "http:") return u.href;
    }
  } catch {
    /* fall back to the placeholder URL */
  }
  return DEFAULT_URL;
}

/**
 * Runs a page tool against a saved capture, offline: a Chromium context with JavaScript DISABLED (the capture's own
 * scripts never run) and every request aborted except the single document load, which is fulfilled from the capture.
 * The tool's code still runs through page.evaluate (which is exempt from the page's script switch), so the
 * tool is isolated from the network: a stray fetch fails, exactly like it would be a bug in the tab.
 */
export class PageEvalRunner implements Runner {
  readonly kind = "page-eval";

  async run(ctx: RunContext): Promise<unknown> {
    const { manifest } = ctx;
    if (manifest.kind !== "page") throw new ToolFailed(`${manifest.name}: only page tools run against a capture`);
    if (!ctx.capture || !existsSync(ctx.capture)) throw new ToolFailed(`${manifest.name}: capture file not found`);
    const html = readFileSync(ctx.capture, "utf8");
    const url = captureUrl(ctx.capture);
    const signin = readSignin(ctx.dir);

    const browser = await chromium.launch({ headless: true });
    const onAbort = () => void browser.close().catch(() => {});
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();
    try {
      const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block", offline: false });
      let served = false;
      await context.route("**/*", (route) => {
        const req = route.request();
        if (!served && req.isNavigationRequest() && req.url() === url) {
          served = true;
          return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
        }
        return route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded" });
      if (signin && (await page.locator(signin.marker).count()) === 0) {
        throw new BridgeError("SIGNED_OUT", `${manifest.name}: the signed-in marker (${signin.marker}) is not in the capture; sign in at ${signin.loginUrl}`);
      }
      const r = (await page.evaluate(composeEval(ctx.fn.toString(), ctx.input, readPageHelpers()))) as { ok: boolean; value?: unknown; message?: string; challenge?: string };
      if (r?.challenge) throw new BridgeError("CHALLENGE", `${manifest.name}: the capture shows a challenge or block (${r.challenge})`);
      if (!r?.ok) throw new ToolFailed(`${manifest.name}: ${r?.message ?? "script returned nothing"}`);
      return r.value;
    } catch (e) {
      if (e instanceof WebsiteMcpError) throw e;
      throw new ToolFailed(e instanceof Error ? e.message : String(e));
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
      await browser.close().catch(() => {});
    }
  }
}
