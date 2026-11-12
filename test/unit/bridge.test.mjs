import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { ROOT, FIXTURE_TOOLS, tempHome, rm, installFixtureTool } from "../helpers/index.mjs";

const proto = await import("../../dist/bridge/protocol.js");
const { startHost } = await import("../../dist/bridge/host.js");
const { bridgeRequest } = await import("../../dist/bridge/client.js");
const { installBridge, uninstallBridge, nativeHostsDir } = await import("../../dist/bridge/install.js");
const { EXTENSION_ID } = await import("../../dist/bridge/extension-id.js");
const { assertPageBlock, assertPageSource } = await import("../../dist/runtime/load.js");

const homes = [];
const mk = (p) => {
  const h = tempHome(p);
  homes.push(h);
  return h;
};
after(() => homes.forEach(rm));

/** A fake browser: feed `peer.toHost` frames, read `peer.fromHost` frames. */
function fakeExtension(onMsg, { hello = true, version = proto.PROTOCOL_VERSION } = {}) {
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  const dec = new proto.FrameDecoder();
  const send = (m) => toHost.write(proto.encodeFrame(m));
  fromHost.on("data", (c) => {
    for (const m of dec.push(c)) {
      if (m.type === "hello") continue;
      onMsg(m, send);
    }
  });
  if (hello) send({ type: "hello", version, extVersion: "9.9.9" });
  return { toHost, fromHost, send };
}

test("framing round-trips, survives byte-by-byte chunks, refuses >1 MB host->browser", () => {
  const msgs = [{ a: 1 }, { s: "héllo ✓" }, { big: "x".repeat(70000) }];
  const wire = Buffer.concat(msgs.map((m) => proto.encodeFrame(m)));
  const d = new proto.FrameDecoder();
  const got = [];
  for (let i = 0; i < wire.length; i += 3) got.push(...d.push(wire.subarray(i, i + 3)));
  assert.deepEqual(got, msgs);
  assert.throws(() => proto.encodeFrame({ s: "x".repeat(proto.MAX_HOST_TO_BROWSER) }), RangeError);
  const small = new proto.FrameDecoder(10);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(11, 0);
  assert.throws(() => small.push(head), RangeError);
});

test("extension ID is recomputed from manifest.json key", () => {
  const key = JSON.parse(readFileSync(join(ROOT, "extension", "manifest.json"), "utf8")).key;
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
  assert.equal(id, EXTENSION_ID);
  assert.match(id, /^[a-p]{32}$/);
});

test("host relays 2 concurrent clients through a fake extension, routing by id", async () => {
  const home = mk("wm-unit-bridge-");
  const held = [];
  const peer = fakeExtension((m, send) => {
    // Hold the first request until the second arrives, then answer in reverse order.
    held.push(m);
    if (held.length === 2) for (const r of held.reverse()) send(proto.okResult(r.id, { echo: r.toolName }));
  });
  const host = await startHost({ input: peer.toHost, output: peer.fromHost, sock: join(home, "bridge.sock"), logFile: join(home, "bridge", "host.log") });
  assert.equal(statSync(host.sock).mode & 0o777, 0o600);
  const run = (toolName) => bridgeRequest({ type: "run", toolName }, { sock: host.sock, timeoutMs: 5000 });
  const [a, b] = await Promise.all([run("alpha"), run("beta")]);
  assert.deepEqual(a, { echo: "alpha" });
  assert.deepEqual(b, { echo: "beta" });
  const st = await bridgeRequest({ type: "status" }, { sock: host.sock });
  assert.equal(st.connected, true);
  assert.equal(st.extension.extVersion, "9.9.9");
  assert.ok(existsSync(join(home, "bridge", "host.log")));
  peer.toHost.end(); // browser closes stdin -> clean exit
  await host.closed;
  assert.equal(existsSync(host.sock), false, "socket removed on exit");
});

test("host maps extension errors, cleans a stale socket, rejects protocol mismatch, reports NO_BRIDGE when absent", async () => {
  const home = mk("wm-unit-bridge-");
  const sock = join(home, "bridge.sock");
  writeFileSync(sock, "stale"); // leftover from a crashed host
  const peer = fakeExtension((m, send) => send(proto.errResult(m.id, "NO_TAB", "open https://x.test/")));
  const host = await startHost({ input: peer.toHost, output: peer.fromHost, sock, logFile: null });
  await assert.rejects(bridgeRequest({ type: "run", toolName: "t" }, { sock, timeoutMs: 5000 }), (e) => e.code === "NO_TAB" && /x\.test/.test(e.message));
  await host.close();
  await assert.rejects(bridgeRequest({ type: "status" }, { sock }), (e) => e.code === "NO_BRIDGE" && /bridge status/.test(e.message));

  const peer2 = fakeExtension(() => {}, { version: 99 });
  const h2 = await startHost({ input: peer2.toHost, output: peer2.fromHost, sock, logFile: null });
  await new Promise((r) => setTimeout(r, 30)); // let hello arrive
  await assert.rejects(bridgeRequest({ type: "run", toolName: "t" }, { sock }), (e) => e.code === "PROTOCOL_MISMATCH");
  await h2.close();
});

test("a request with no answer times out with TIMEOUT", async () => {
  const home = mk("wm-unit-bridge-");
  const sock = join(home, "bridge.sock");
  const peer = fakeExtension(() => {});
  const host = await startHost({ input: peer.toHost, output: peer.fromHost, sock, logFile: null });
  await assert.rejects(bridgeRequest({ type: "run", toolName: "t" }, { sock, timeoutMs: 100 }), (e) => e.code === "TIMEOUT");
  await host.close();
});

test("installer writes a correct host manifest and wrapper into an injected dir", () => {
  const home = mk("wm-unit-bridge-");
  const nmh = join(home, "NativeMessagingHosts");
  const r = installBridge({ nmhDir: nmh, home, nodePath: "/opt/x y/node", hostEntry: "/srv/host-main.js" });
  const m = JSON.parse(readFileSync(r.manifestPath, "utf8"));
  assert.equal(m.name, "dev.website_mcp.bridge");
  assert.equal(m.type, "stdio");
  assert.deepEqual(m.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
  assert.equal(m.path, join(home, "bridge", "run-host.sh"));
  const sh = readFileSync(m.path, "utf8");
  assert.match(sh, /exec '\/opt\/x y\/node' '\/srv\/host-main\.js'/);
  assert.ok(statSync(m.path).mode & 0o100, "wrapper executable");
  assert.equal(uninstallBridge({ nmhDir: nmh, home }).removed.length, 2);
  assert.match(nativeHostsDir("brave", "/h"), /BraveSoftware.*Brave-Browser.*NativeMessagingHosts$|\.config.*Brave/);
});

test("page block and import validation", () => {
  assert.doesNotThrow(() => assertPageBlock({ kind: "page", page: { urlPattern: "/a/*", world: "USER_SCRIPT", tab: "existing", needsVisible: false } }, "t"));
  for (const bad of [{ world: "ISOLATED" }, { urlPattern: "a" }, { tab: "new" }, { needsVisible: "yes" }, { extra: 1 }]) {
    assert.throws(() => assertPageBlock({ kind: "page", page: bad }, "t"), undefined, JSON.stringify(bad));
  }
  assert.throws(() => assertPageBlock({ kind: "browser", page: {} }, "t"));
  assert.throws(() => assertPageSource('import fs from "fs";\nexport default async()=>1', "t"));
  assert.throws(() => assertPageSource("export default async()=>(await import('x'))", "t"));
  assert.doesNotThrow(() => assertPageSource("export default async ({input})=>document.title", "t"));
});

test("PageRunner sends the tool through the bridge and maps results and errors", async () => {
  const home = mk("wm-unit-bridge-");
  const prev = process.env.WEBSITE_MCP_HOME;
  process.env.WEBSITE_MCP_HOME = home;
  try {
    installFixtureTool(home, "quotes_page", "https://quotes.toscrape.com");
    const { runTool } = await import("../../dist/runtime/run.js");
    await assert.rejects(runTool("quotes_page", {}), (e) => e.code === "NO_BRIDGE");

    let seen;
    let mode = "ok";
    const peer = fakeExtension((m, send) => {
      seen = m;
      if (mode === "ok") send(proto.okResult(m.id, { quotes: [{ text: "t", author: "a" }] }));
      else if (mode === "bad") send(proto.okResult(m.id, { nope: 1 }));
      else send(proto.errResult(m.id, mode, `msg ${mode}`));
    });
    const host = await startHost({ input: peer.toHost, output: peer.fromHost, logFile: null });
    assert.deepEqual(await runTool("quotes_page", {}), { quotes: [{ text: "t", author: "a" }] });
    assert.equal(seen.world, "USER_SCRIPT");
    assert.deepEqual(seen.origins, ["https://quotes.toscrape.com"]);
    assert.equal(seen.urlPattern, "/*");
    assert.match(seen.source, /^async \(\{ input, wm \}\) =>/);
    assert.match(seen.hash, /^[0-9a-f]{64}$/);
    mode = "bad";
    await assert.rejects(runTool("quotes_page", {}), (e) => e.code === "invalid_output");
    for (const code of ["NO_TAB", "SITE_NOT_GRANTED", "USER_SCRIPTS_OFF", "TAB_HIDDEN", "SCRIPT_ERROR"]) {
      mode = code;
      await assert.rejects(runTool("quotes_page", {}), (e) => e.code === code && e.message === `msg ${code}`);
    }
    await host.close();
  } finally {
    if (prev === undefined) delete process.env.WEBSITE_MCP_HOME;
    else process.env.WEBSITE_MCP_HOME = prev;
  }
});

test("the real host process (via installed wrapper) speaks framed stdio and exits when stdin closes", async () => {
  const { spawn } = await import("node:child_process");
  const home = mk("wm-unit-bridge-");
  const r = installBridge({ nmhDir: join(home, "nmh"), home });
  const child = spawn(r.wrapperPath, [`chrome-extension://${EXTENSION_ID}/`], { env: { PATH: "/usr/bin:/bin" } });
  const dec = new proto.FrameDecoder();
  const frames = [];
  child.stdout.on("data", (c) => frames.push(...dec.push(c)));
  const exited = new Promise((res) => child.on("exit", res));
  const sock = join(home, "bridge.sock");
  for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r2) => setTimeout(r2, 50));
  child.stdin.write(proto.encodeFrame({ type: "hello", version: proto.PROTOCOL_VERSION, extVersion: "1.2.3" }));
  const run = bridgeRequest({ type: "run", toolName: "x" }, { sock, timeoutMs: 5000 });
  for (let i = 0; i < 100 && !frames.some((f) => f.type === "run"); i++) await new Promise((r2) => setTimeout(r2, 20));
  const req = frames.find((f) => f.type === "run");
  child.stdin.write(proto.encodeFrame(proto.okResult(req.id, { hi: 1 })));
  assert.deepEqual(await run, { hi: 1 });
  child.stdin.end();
  await exited;
  assert.equal(existsSync(sock), false);
});

test("a closing host does not unlink a socket that a newer host replaced", async () => {
  const home = mk("wm-unit-bridge-");
  const sock = join(home, "bridge.sock");
  const p1 = fakeExtension(() => {});
  const p2 = fakeExtension((m, send) => send(proto.okResult(m.id, {})));
  const h1 = await startHost({ input: p1.toHost, output: p1.fromHost, sock, logFile: null });
  const h2 = await startHost({ input: p2.toHost, output: p2.fromHost, sock, logFile: null });
  await h1.close();
  assert.equal(existsSync(sock), true, "host 2's socket survives");
  assert.equal((await bridgeRequest({ type: "status" }, { sock, timeoutMs: 2000 })).connected, true);
  await h2.close();
  assert.equal(existsSync(sock), false);
});

test("uninstall keeps the shared wrapper while another browser's manifest remains; install copies the host", async () => {
  const home = mk("wm-unit-bridge-");
  const hostsHome = mk("wm-unit-bridge-");
  const prev = process.env.HOME;
  process.env.HOME = hostsHome; // nativeHostsDir() resolves under HOME via os.homedir()
  try {
    const r = installBridge({ browser: "brave", home });
    installBridge({ browser: "chromium", home });
    assert.ok(existsSync(join(home, "bridge", "host", "host-main.js")));
    assert.ok(!existsSync(join(home, "bridge", "host", "node_modules")));
    assert.match(readFileSync(r.wrapperPath, "utf8"), /bridge\/host\/host-main\.js/);
    uninstallBridge({ browser: "chromium", home });
    assert.ok(existsSync(r.wrapperPath), "wrapper kept for brave");
    uninstallBridge({ browser: "brave", home });
    assert.ok(!existsSync(r.wrapperPath));
  } finally {
    process.env.HOME = prev;
  }
});
