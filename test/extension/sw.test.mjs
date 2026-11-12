import test from "node:test";
import assert from "node:assert/strict";

// Load sw.js against a mocked chrome; returns the fake native port and a way to ask the popup-status question.
async function loadSw() {
  const port = { handlers: [], posted: [], onMessage: { addListener(f) { port.msg = f; } }, onDisconnect: { addListener(f) { port.disc = f; } }, postMessage(m) { port.posted.push(m); } };
  let statusListener;
  const noop = { addListener() {} };
  globalThis.chrome = {
    runtime: {
      connectNative: () => port,
      getURL: (p) => p,
      getManifest: () => ({ version: "0.1.0" }),
      onStartup: noop,
      onInstalled: noop,
      onMessage: { addListener(f) { statusListener = f; } },
      lastError: undefined,
    },
    alarms: { create() {}, onAlarm: noop },
    userScripts: { configureWorld: async (o) => { (globalThis.__worldCfg ??= []).push(o); } },
  };
  await import(`../../extension/sw.js?${Math.random()}`);
  const status = () => new Promise((res) => statusListener({ type: "popup-status" }, {}, res));
  return { port, status };
}

test("popup-status: connected only after the host's hello, not a bare port", async () => {
  const { port, status } = await loadSw();
  assert.equal((await status()).connected, false, "port opened but no hello yet");
  await port.msg({ type: "hello", id: "host", version: 2 });
  assert.equal((await status()).connected, true, "hello seen");
  port.disc();
  assert.equal((await status()).connected, false, "disconnect resets");
});

test("sw sets a no-network CSP on the USER_SCRIPT world at startup", async () => {
  globalThis.__worldCfg = [];
  await loadSw();
  assert.match(globalThis.__worldCfg[0].csp, /connect-src 'none'/);
});
