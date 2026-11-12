import { bridgeRequest } from "../../bridge/client.js";
import { createHash } from "node:crypto";
import { readSignin } from "../../mint/signin.js";
import { BridgeError, ToolFailed, WebsiteMcpError } from "../errors.js";
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
    const signin = readSignin(ctx.dir); // throws (fail closed) on a malformed signin.json
    const world = page.world ?? "USER_SCRIPT";
    const source = ctx.fn.toString();
    const needsVisible = page.needsVisible ?? false;
    const hash = runHash({ source, world, urlPattern: page.urlPattern, origins, signin, needsVisible });
    try {
      return await bridgeRequest(
        {
          type: "run",
          toolName: manifest.name,
          version: manifest.version,
          hash,
          source,
          input: ctx.input,
          urlPattern: page.urlPattern,
          origins,
          world,
          tab: page.tab ?? "existing",
          timeoutMs,
          needsVisible,
          ...(signin ? { signin } : {}),
          ...(ctx.draft ? { draft: true } : {}),
        },
        // Slightly longer than the extension's own deadline so its structured TIMEOUT arrives first.
        { timeoutMs: timeoutMs + 2000 },
      );
    } catch (e) {
      if (e instanceof BridgeError) throw explain(e, manifest.name, manifest.version, hash, signin?.loginUrl);
      if (e instanceof WebsiteMcpError) throw e;
      throw new ToolFailed(`${manifest.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

const canon = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canon)}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon((v as Record<string, unknown>)[k]))}}` : JSON.stringify(v ?? null);

/** What the extension approves: sha256 of the code and scope that will run. Must match extension/lib.js runHash. */
export function runHash(m: { source: string; world: string; urlPattern?: unknown; origins: unknown; signin?: unknown; needsVisible: boolean }): string {
  return createHash("sha256")
    .update(canon({ source: m.source, world: m.world, urlPattern: m.urlPattern ?? null, origins: m.origins ?? [], signin: m.signin ?? null, needsVisible: !!m.needsVisible }))
    .digest("hex");
}

/** Turn the extension's terse approval / sign-in errors into messages that say what the user does next. */
export function explain(e: BridgeError, name: string, version: number | undefined, hash: string, loginUrl?: string): BridgeError {
  if (e.code === "NEEDS_APPROVAL") {
    const v = version === undefined ? "draft" : `v${version}`;
    return new BridgeError(
      "NEEDS_APPROVAL",
      `${name} ${v} (hash ${hash.slice(0, 12)}) has not been approved yet. Open the website-mcp extension popup in your browser, check the name, version, site and hash, click Approve, then run it again. Any edit to the tool changes the hash and asks again.`,
      { toolName: name, version: version ?? null, hash },
    );
  }
  if (e.code === "SIGNED_OUT") {
    return new BridgeError("SIGNED_OUT", `${name}: you are signed out in that tab. Sign in${loginUrl ? ` at ${loginUrl}` : ""}, then run it again.`, { ...(loginUrl ? { loginUrl } : {}) });
  }
  return e;
}
