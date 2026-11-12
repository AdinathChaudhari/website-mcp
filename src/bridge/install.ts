import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeDir } from "../runtime/load.js";
import { EXTENSION_ID } from "./extension-id.js";
import { HOST_NAME } from "./protocol.js";

export const BROWSERS = ["brave", "chrome", "chromium", "edge"] as const;
/** Chrome, not Brave: Brave cannot find user-level native hosts (D-033). */
export const DEFAULT_BROWSER: BrowserName = "chrome";
export type BrowserName = (typeof BROWSERS)[number];

const MAC: Record<BrowserName, string[]> = {
  brave: ["BraveSoftware", "Brave-Browser"],
  chrome: ["Google", "Chrome"],
  chromium: ["Chromium"],
  edge: ["Microsoft Edge"],
};
const LINUX: Record<BrowserName, string[]> = {
  brave: [".config", "BraveSoftware", "Brave-Browser"],
  chrome: [".config", "google-chrome"],
  chromium: [".config", "chromium"],
  edge: [".config", "microsoft-edge"],
};

/** The browser's per-user NativeMessagingHosts folder (computed at run time, never hard-coded). */
export function nativeHostsDir(browser: BrowserName, home: string = homedir()): string {
  if (platform() === "darwin") return join(home, "Library", "Application Support", ...MAC[browser], "NativeMessagingHosts");
  if (platform() === "linux") return join(home, ...LINUX[browser], "NativeMessagingHosts");
  throw new Error(`bridge install: unsupported platform ${platform()}`);
}

export interface InstallOptions {
  browser?: BrowserName;
  /** Override the NativeMessagingHosts folder (tests). */
  nmhDir?: string;
  /** Override the tool home that holds bridge/run-host.sh (tests). */
  home?: string;
  /** Override the node binary and host entry (tests). */
  nodePath?: string;
  hostEntry?: string;
}
export interface InstallResult {
  manifestPath: string;
  wrapperPath: string;
  extensionId: string;
}

const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

export function wrapperPathFor(home: string = homeDir()): string {
  return join(home, "bridge", "run-host.sh");
}

export function manifestPathFor(opts: InstallOptions = {}): string {
  return join(opts.nmhDir ?? nativeHostsDir(opts.browser ?? DEFAULT_BROWSER), `${HOST_NAME}.json`);
}

/** A node path that survives `brew upgrade node` (Cellar paths do not): the first stable symlink resolving to the same binary. */
export function stableNodePath(execPath: string = process.execPath): string {
  try {
    const real = realpathSync(execPath);
    const dirs = [...(process.env.PATH ?? "").split(":"), "/opt/homebrew/opt/node/bin", "/usr/local/opt/node/bin"];
    for (const c of ["/opt/homebrew/opt/node/bin/node", "/usr/local/opt/node/bin/node", ...dirs.filter(Boolean).map((d) => join(d, "node"))]) {
      try {
        if (!c.includes("/Cellar/") && realpathSync(c) === real) return c;
      } catch {
        /* candidate missing */
      }
    }
  } catch {
    /* fall through */
  }
  return execPath;
}

/** The node path a wrapper script execs, or undefined if it cannot be read. */
export function wrapperNodePath(wrapper: string): string | undefined {
  try {
    return /^exec '((?:[^']|'\\'')*)'/m.exec(readFileSync(wrapper, "utf8"))?.[1]?.replaceAll(`'\\''`, "'");
  } catch {
    return undefined;
  }
}

/** Copy the host (dist/bridge/*.js it needs) outside ~/Documents etc. so the browser can spawn it without extra file access. */
function copyHost(home: string): string {
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const dest = join(home, "bridge", "host");
  mkdirSync(dest, { recursive: true });
  for (const f of ["host-main.js", "host.js", "protocol.js"]) copyFileSync(join(srcDir, f), join(dest, f));
  writeFileSync(join(dest, "package.json"), '{"type":"module"}\n');
  return join(dest, "host-main.js");
}

export function installBridge(opts: InstallOptions = {}): InstallResult {
  const home = opts.home ?? homeDir();
  const node = opts.nodePath ?? stableNodePath();
  const entry = opts.hostEntry ?? copyHost(home);
  const wrapperPath = wrapperPathFor(home);
  mkdirSync(dirname(wrapperPath), { recursive: true });
  // Browsers spawn native hosts with a minimal PATH, so the wrapper pins the absolute node binary and WEBSITE_MCP_HOME.
  const script = `#!/bin/sh\nexport WEBSITE_MCP_HOME=${shq(home)}\nexec ${shq(node)} ${shq(entry)} "$@"\n`;
  writeFileSync(wrapperPath, script);
  chmodSync(wrapperPath, 0o755);

  const manifestPath = manifestPathFor(opts);
  mkdirSync(dirname(manifestPath), { recursive: true });
  const manifest = {
    name: HOST_NAME,
    description: "website-mcp page bridge",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { manifestPath, wrapperPath, extensionId: EXTENSION_ID };
}

export function uninstallBridge(opts: InstallOptions = {}): { removed: string[] } {
  const removed: string[] = [];
  const drop = (f: string): void => {
    if (existsSync(f)) {
      unlinkSync(f);
      removed.push(f);
    }
  };
  drop(manifestPathFor(opts));
  // The wrapper is shared by every browser: keep it while any browser's manifest still exists.
  const others = opts.nmhDir ? [] : BROWSERS.map((b) => manifestPathFor({ browser: b }));
  if (!others.some((m) => existsSync(m))) {
    drop(wrapperPathFor(opts.home));
    rmSync(join(opts.home ?? homeDir(), "bridge", "host"), { recursive: true, force: true });
  }
  return { removed };
}
