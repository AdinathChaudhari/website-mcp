import { handleMessage } from "./lib.js";

const HOST = "dev.website_mcp.bridge";
let port = null;
let helloSeen = false; // true only once the host has spoken, so a dead host behind an open port is not "connected"
let helpers = null;

async function helpersText() {
  helpers ??= await (await fetch(chrome.runtime.getURL("page-helpers.js"))).text();
  return helpers;
}

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    port = null;
    return;
  }
  const p = port;
  p.onMessage.addListener(async (msg) => {
    if (msg?.type === "hello") helloSeen = true;
    try {
      const reply = await handleMessage(chrome, msg, await helpersText(), chrome.runtime.getManifest().version);
      if (reply) p.postMessage(reply);
    } catch (e) {
      if (msg?.id) p.postMessage({ type: "result", id: msg.id, ok: false, error: { code: "SCRIPT_ERROR", message: String(e?.message ?? e) } });
    }
  });
  p.onDisconnect.addListener(() => {
    void chrome.runtime.lastError; // host missing or exited; the alarm retries
    port = null;
    helloSeen = false;
  });
}

// Block network from the USER_SCRIPT world (DOM-only page tools). Verified in Chrome for Testing: applies to documents created AFTER the call, so set it first, on every worker start.
try { chrome.userScripts?.configureWorld({ csp: "connect-src 'none'; script-src 'self'" })?.catch?.(() => {}); } catch { /* userScripts off */ }

chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m?.type === "popup-status") {
    connect();
    send({ connected: !!port && helloSeen });
  }
});
connect();
