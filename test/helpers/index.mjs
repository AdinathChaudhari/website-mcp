import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FIXTURE_TOOLS = join(ROOT, "test", "fixtures", "tools");

export function tempHome(prefix = "wm-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}
export const rm = (p) => rmSync(p, { recursive: true, force: true });

/** Copy test/fixtures/tools/<tool> into <home>/<kind>/<tool>, replacing __ORIGIN__ in text files. kind: "tools" | "drafts". */
export function installFixtureTool(home, tool, origin, kind = "tools", { as = tool, sourceTransform, manifestTransform } = {}) {
  const src = join(FIXTURE_TOOLS, tool);
  const dest = join(home, kind, as);
  const walk = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const f of readdirSync(from)) {
      const a = join(from, f);
      const b = join(to, f);
      if (statSync(a).isDirectory()) walk(a, b);
      else {
        let t = readFileSync(a, "utf8").replaceAll("__ORIGIN__", origin);
        if (f === "tool.mjs" && sourceTransform) t = sourceTransform(t);
        if (f === "tool.json") {
          const m = JSON.parse(t);
          m.name = as;
          t = JSON.stringify(manifestTransform ? manifestTransform(m) : m, null, 2);
        }
        writeFileSync(b, t);
      }
    }
  };
  walk(src, dest);
  if (kind === "tools") {
    const m = JSON.parse(readFileSync(join(dest, "tool.json"), "utf8"));
    m.version = 1;
    writeFileSync(join(dest, "tool.json"), JSON.stringify(m, null, 2));
  }
  return dest;
}

/** Start `website-mcp serve` over stdio against a temp home. Counts tools/list_changed notifications. */
export async function startMcp(home) {
  const client = new Client({ name: "test", version: "0" });
  const state = { changed: 0 };
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => void state.changed++);
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "dist", "cli.js"), "serve"], env: { ...process.env, WEBSITE_MCP_HOME: home } }),
  );
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const t = r.content[0].text;
    let v = t;
    try { v = JSON.parse(t); } catch { /* plain text */ }
    return { isError: !!r.isError, v };
  };
  return { client, call, state, close: () => client.close() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

/** Write an allow review for the draft's CURRENT source, as a reviewer + submit_review would. */
export async function approve(draftDir, verdict = "allow", findings = []) {
  const { hashSource, hashCases } = await import("../../dist/mint/tests.js");
  const review = { verdict, findings, sourceHash: hashSource(draftDir), name: draftDir.split("/").pop(), casesHash: hashCases(draftDir), reviewedAt: new Date().toISOString() };
  writeFileSync(join(draftDir, "review.json"), JSON.stringify(review, null, 2) + "\n");
  return review;
}
