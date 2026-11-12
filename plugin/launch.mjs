// Starts the website-mcp stdio server for the plugin.
//
// Why a launcher: when a plugin is loaded in place from a local marketplace, ${CLAUDE_PLUGIN_ROOT} is
// <repo>/plugin and the built server is at <repo>/dist. A plugin that is COPIED into Claude Code's cache (git or
// remote marketplaces) gets only this folder, so dist/ is not there. Rather than fail with an opaque
// "server failed to start", this script finds the build or says exactly what to do.
//
// Resolution order: $WEBSITE_MCP_ROOT/dist/cli.js, then ../dist/cli.js next to this plugin folder, then (ONLY when
// WEBSITE_MCP_ALLOW_NPX=1) `npx -y website-mcp@<this plugin's version> serve`. The npx fallback downloads and runs
// code from the npm registry, so it is opt-in; without the flag the loud error below stays.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const roots = [process.env.WEBSITE_MCP_ROOT, resolve(here, "..")].filter(Boolean);
const cli = roots.map((r) => join(r, "dist", "cli.js")).find((f) => existsSync(f));

if (!cli && process.env.WEBSITE_MCP_ALLOW_NPX === "1") {
  const { version } = JSON.parse(readFileSync(join(here, ".claude-plugin", "plugin.json"), "utf8"));
  const child = spawn("npx", ["-y", `website-mcp@${version}`, "serve"], { stdio: "inherit" });
  child.on("error", (e) => {
    process.stderr.write(`website-mcp: npx fallback failed to start: ${e.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else if (!cli) {
  process.stderr.write(
    "website-mcp: cannot find the built server (dist/cli.js).\n" +
      `  looked in: ${roots.map((r) => join(r, "dist")).join(", ")}\n` +
      "  fix: in the website-mcp checkout run `npm install && npm run build`, install the plugin from that checkout's\n" +
      "  local marketplace, or set WEBSITE_MCP_ROOT to the checkout,\n" +
      "  or opt in to fetching the published package: set WEBSITE_MCP_ALLOW_NPX=1 (runs `npx -y website-mcp@<version> serve`).\n",
  );
  process.exit(1);
}

if (cli) {
  process.argv = [process.argv[0], cli, "serve"];
  await import(pathToFileURL(cli).href);
}
