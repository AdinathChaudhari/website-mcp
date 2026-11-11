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
  website-mcp publish <name>`;

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
