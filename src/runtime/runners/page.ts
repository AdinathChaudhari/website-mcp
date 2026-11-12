import { bridgeRequest } from "../../bridge/client.js";
import { hashSource } from "../../mint/tests.js";
import { ToolFailed, WebsiteMcpError } from "../errors.js";
import type { RunContext, Runner } from "./types.js";

/**
 * Runs a page tool in an already-open tab of the user's browser through the extension (no model, no Playwright).
 * The tool's default export is serialised with toString(); it must be self-contained (checked at load time).
 */
export class PageRunner implements Runner {
  readonly kind = "page";

  async run(ctx: RunContext): Promise<unknown> {
    const { manifest } = ctx;
    const origins = manifest.site?.allowedOrigins;
    if (!Array.isArray(origins) || origins.length === 0) {
      throw new ToolFailed(`${manifest.name}: site.allowedOrigins is missing; refusing to run (fail closed)`);
    }
    const page = manifest.page ?? {};
    const timeoutMs = (manifest.timeoutSec ?? 60) * 1000;
    try {
      return await bridgeRequest(
        {
          type: "run",
          toolName: manifest.name,
          version: manifest.version,
          hash: hashSource(ctx.dir),
          source: ctx.fn.toString(),
          input: ctx.input,
          urlPattern: page.urlPattern,
          origins,
          world: page.world ?? "USER_SCRIPT",
          tab: page.tab ?? "existing",
          timeoutMs,
          needsVisible: page.needsVisible ?? false,
        },
        // Slightly longer than the extension's own deadline so its structured TIMEOUT arrives first.
        { timeoutMs: timeoutMs + 2000 },
      );
    } catch (e) {
      if (e instanceof WebsiteMcpError) throw e;
      throw new ToolFailed(`${manifest.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
