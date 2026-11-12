import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, tempHome, rm } from "../helpers/index.mjs";

const homes = [];
after(() => homes.forEach(rm));
const cli = (args, env) => spawnSync(process.execPath, [join(ROOT, "dist/cli.js"), ...args], { env: { ...process.env, ...env }, encoding: "utf8" });

test("bridge install then uninstall with no --browser flag agree (default is Chrome) and uninstall reports what it removed", () => {
  const hostsHome = tempHome("wm-cli-hosts-"); const home = tempHome("wm-cli-home-");
  homes.push(hostsHome, home);
  const env = { HOME: hostsHome, WEBSITE_MCP_HOME: home };
  assert.equal(cli(["bridge", "install", "--browser", "chrome"], env).status, 0);
  const manifest = join(hostsHome, "Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.website_mcp.bridge.json");
  const linux = join(hostsHome, ".config/google-chrome/NativeMessagingHosts/dev.website_mcp.bridge.json");
  assert.ok(existsSync(manifest) || existsSync(linux));
  const out = JSON.parse(cli(["bridge", "uninstall"], env).stdout);
  assert.ok(out.removed.length >= 1, `removed list was empty: ${JSON.stringify(out)}`);
  assert.ok(!existsSync(manifest) && !existsSync(linux), "manifest actually deleted");
});
