import { test, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ROOT, tempHome, rm } from "../helpers/index.mjs";

const json = (...p) => JSON.parse(readFileSync(join(ROOT, ...p), "utf8"));
const home = tempHome("wm-unit-plugin-");
after(() => rm(home));

test("plugin.json, marketplace.json and .mcp.json are consistent", () => {
  const plugin = json("plugin", ".claude-plugin", "plugin.json");
  const market = json(".claude-plugin", "marketplace.json");
  const mcp = json("plugin", ".mcp.json");
  assert.equal(plugin.name, "website-mcp");
  assert.equal(market.plugins[0].name, plugin.name, "entry name == manifest name");
  assert.equal(market.plugins[0].source, "./plugin");
  assert.equal(json("package.json").version, plugin.version);
  assert.deepEqual(mcp.mcpServers["website-mcp"].args, ["${CLAUDE_PLUGIN_ROOT}/launch.mjs"]);
});

test("the reviewer subagent is Sonnet with read-only tools only", () => {
  const md = readFileSync(join(ROOT, "plugin", "agents", "website-mcp-reviewer.md"), "utf8");
  const fm = /^---\n([\s\S]*?)\n---/.exec(md)[1];
  assert.match(fm, /^name: website-mcp-reviewer$/m);
  assert.match(fm, /^model: sonnet$/m);
  assert.match(fm, /^tools: Read, Grep, Glob$/m);
  for (const needle of ["scope", "read-only", "origins", "secrets", "locators", "empty", "invalid_input", "paging", "sourceHash", "allow", "deny"]) {
    assert.ok(md.toLowerCase().includes(needle.toLowerCase()), `reviewer prompt covers ${needle}`);
  }
});

test("project-level skill and agent are symlinks to the plugin's files (one source of truth)", () => {
  for (const [link, target] of [
    [join(".claude", "skills", "mint", "SKILL.md"), join("plugin", "skills", "mint", "SKILL.md")],
    [join(".claude", "agents", "website-mcp-reviewer.md"), join("plugin", "agents", "website-mcp-reviewer.md")],
  ]) {
    assert.ok(lstatSync(join(ROOT, link)).isSymbolicLink(), link);
    assert.equal(readFileSync(join(ROOT, link), "utf8"), readFileSync(join(ROOT, target), "utf8"));
    assert.ok(readlinkSync(join(ROOT, link)).startsWith(".."), "relative link, no absolute paths");
  }
});

test("tracked plugin and authoring text has no local absolute paths or personal data", () => {
  const files = ["plugin/.claude-plugin/plugin.json", "plugin/.mcp.json", "plugin/launch.mjs", "plugin/README.md", "plugin/skills/mint/SKILL.md", "plugin/agents/website-mcp-reviewer.md", ".claude-plugin/marketplace.json", "authoring/core.md", "authoring/testing.md", "authoring/pagination.md", "authoring/search.md", "authoring/publication.md", "authoring/hard-targets.md", "docs/safety.md"];
  for (const f of files) {
    const t = readFileSync(join(ROOT, f), "utf8");
    assert.doesNotMatch(t, /\/Users\/|\/home\/[a-z]|C:\\Users|@[a-z0-9-]+\.(com|org|io)\b/i, f);
  }
});

test("launch.mjs starts the real server (tools/list includes guide and submit_review)", async () => {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "plugin", "launch.mjs")], env: { ...process.env, WEBSITE_MCP_HOME: home } }));
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["guide", "submit_review", "save_tool", "publish_tool"]) assert.ok(names.includes(n), n);
  } finally {
    await client.close();
  }
});

test("launch.mjs without a build next to it exits non-zero with a message that says what to do", () => {
  const lonely = tempHome("wm-launch-");
  try {
    copyFileSync(join(ROOT, "plugin", "launch.mjs"), join(lonely, "launch.mjs"));
    const env = { ...process.env };
    delete env.WEBSITE_MCP_ROOT;
    const r = spawnSync(process.execPath, [join(lonely, "launch.mjs")], { encoding: "utf8", env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot find the built server/);
    assert.match(r.stderr, /npm run build/);
  } finally {
    rm(lonely);
  }
});
