#!/usr/bin/env node
import { toErrorPayload } from "./runtime/errors.js";
import { listToolNames, readManifest } from "./runtime/load.js";
import { MIN_CASES, MIN_PASS_RATE, meetsBar } from "./mint/tests.js";
import { runTool } from "./runtime/run.js";

const USAGE = `Usage:
  website-mcp serve
  website-mcp run <name> --input '<json>'
  website-mcp list
  website-mcp test <name> [--draft]
  website-mcp review <name> allow|deny [--findings '<json array>']
  website-mcp publish <name>
  website-mcp bridge install [--browser brave|chrome|chromium|edge]
  website-mcp bridge status
  website-mcp bridge uninstall [--browser brave|chrome|chromium|edge]`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "serve": {
      const { startServer } = await import("./server/mcp.js");
      await startServer();
      return -1; // keep running
    }
    case "list": {
      const out = listToolNames().map((n) => {
        try {
          return { name: n, description: readManifest(n).description ?? "" };
        } catch (e) {
          return { name: n, error: (e as Error).message };
        }
      });
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }
    case "run": {
      const name = rest[0];
      const i = rest.indexOf("--input");
      if (!name || name.startsWith("--")) {
        console.error(USAGE);
        return 2;
      }
      let input: unknown = {};
      if (i >= 0) {
        try {
          input = JSON.parse(rest[i + 1] ?? "");
        } catch {
          console.log(JSON.stringify({ error: { code: "invalid_input", message: "--input is not valid JSON" } }));
          return 1;
        }
      }
      try {
        console.log(JSON.stringify(await runTool(name, input), null, 2));
        return 0;
      } catch (e) {
        console.log(JSON.stringify(toErrorPayload(e)));
        return 1;
      }
    }
    case "test": {
      const name = rest[0];
      if (!name || name.startsWith("--")) {
        console.error(USAGE);
        return 2;
      }
      const { MintSession } = await import("./mint/session.js");
      const session = new MintSession();
      try {
        const run = rest.includes("--draft") ? await session.testDraft(name) : await session.testPublished(name);
        const w = Math.max(4, ...run.results.map((r) => r.name.length));
        console.log(`${"case".padEnd(w)}  result  ms     error`);
        for (const r of run.results) console.log(`${r.name.padEnd(w)}  ${r.pass ? "PASS  " : "FAIL  "}  ${String(r.ms).padEnd(6)} ${r.error ?? ""}`);
        const ok = meetsBar(run);
        console.log(`\n${run.results.filter((r) => r.pass).length}/${run.results.length} passed (${Math.round(run.passRate * 100)}%); bar: >=${MIN_CASES} cases and >=${MIN_PASS_RATE * 100}% -> ${ok ? "OK" : "BELOW BAR"}`);
        return ok ? 0 : 1;
      } catch (e) {
        console.log(JSON.stringify(toErrorPayload(e)));
        return 1;
      }
    }
    case "review": {
      // A human review of the CURRENT draft (hash computed here). The MCP flow uses submit_review with the
      // reviewer subagent's hash instead.
      const [name, verdict] = rest;
      if (!name || !verdict || name.startsWith("--")) {
        console.error(USAGE);
        return 2;
      }
      const fi = rest.indexOf("--findings");
      let findings: unknown = [];
      if (fi >= 0) {
        try {
          findings = JSON.parse(rest[fi + 1] ?? "");
        } catch {
          console.log(JSON.stringify({ error: { code: "invalid_input", message: "--findings is not valid JSON" } }));
          return 1;
        }
      }
      const { MintSession } = await import("./mint/session.js");
      const { hashSource } = await import("./mint/tests.js");
      try {
        const s = new MintSession();
        console.log(JSON.stringify(s.submitReview(name, verdict, findings, hashSource(s.draftDir(name))), null, 2));
        return 0;
      } catch (e) {
        console.log(JSON.stringify(toErrorPayload(e), null, 2));
        return 1;
      }
    }
    case "publish": {
      const name = rest[0];
      if (!name || name.startsWith("--")) {
        console.error(USAGE);
        return 2;
      }
      const { MintSession } = await import("./mint/session.js");
      try {
        const r = await new MintSession().publish(name);
        console.log(JSON.stringify({ published: r.published, version: r.version, passRate: r.lastRun.passRate }, null, 2));
        return 0;
      } catch (e) {
        console.log(JSON.stringify(toErrorPayload(e), null, 2));
        return 1;
      }
    }
    case "bridge": {
      const [sub, ...brest] = rest;
      const bi = brest.indexOf("--browser");
      const browser = bi >= 0 ? brest[bi + 1] : "chrome";
      const { BROWSERS, installBridge, uninstallBridge, manifestPathFor } = await import("./bridge/install.js");
      if (!(BROWSERS as readonly string[]).includes(browser ?? "")) {
        console.error(USAGE);
        return 2;
      }
      const b = browser as (typeof BROWSERS)[number];
      if (sub === "install") {
        try {
          const r = installBridge({ browser: b });
          console.log(`Installed the native host for ${b}.\n  manifest: ${r.manifestPath}\n  wrapper:  ${r.wrapperPath}\n  extension ID: ${r.extensionId}`);
          console.log("Next: load extension/ unpacked, turn on \"Allow User Scripts\" for it, restart the browser, then run `website-mcp bridge status`.");
          return 0;
        } catch (e) {
          console.log(JSON.stringify(toErrorPayload(e)));
          return 1;
        }
      }
      if (sub === "uninstall") {
        console.log(JSON.stringify(uninstallBridge({ browser: b }), null, 2));
        return 0;
      }
      if (sub === "status") {
        const { bridgeRequest } = await import("./bridge/client.js");
        const { existsSync } = await import("node:fs");
        const { BROWSERS: ALL, wrapperPathFor, wrapperNodePath } = await import("./bridge/install.js");
        const have = ALL.filter((x) => existsSync(manifestPathFor({ browser: x })));
        console.log(`host manifest: ${have.length ? `installed for ${have.join(", ")}` : "none installed (run `website-mcp bridge install --browser <name>`)"}`);
        const wn = wrapperNodePath(wrapperPathFor());
        if (wn && !existsSync(wn)) console.log(`WARNING: node at ${wn} no longer exists (node upgraded?); re-run \`website-mcp bridge install\``);
        try {
          const r = (await bridgeRequest({ type: "status" }, { timeoutMs: 5000 })) as {
            protocolVersion: number;
            extension: { version: number; extVersion?: string } | null;
          };
          console.log(`connected\nhost protocol: ${r.protocolVersion}\nextension: ${r.extension ? `version ${r.extension.extVersion ?? "?"}, protocol ${r.extension.version}` : "no hello yet"}`);
          return 0;
        } catch (e) {
          console.log(`not connected: ${(e as Error).message}`);
          return 1;
        }
      }
      console.error(USAGE);
      return 2;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e) => {
    console.log(JSON.stringify(toErrorPayload(e)));
    process.exit(1);
  },
);
