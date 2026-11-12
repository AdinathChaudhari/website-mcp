import { handleMessage } from "./lib.js";

const HOST = "dev.website_mcp.bridge";
let port = null;
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
  });
}

chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m?.type === "popup-status") {
    connect();
    send({ connected: !!port });
  }
});
connect();
