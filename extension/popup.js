import { EXPLORE_HOUR_MS, EXPLORE_DAY_MS } from "./lib.js";
export const originOf = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; } };

/** Draw the popup. `chrome` and `doc` are injected so tests can mock them. */
export async function render(chrome, doc) {
  const $ = (id) => doc.getElementById(id);
  const again = () => render(chrome, doc);
  const { enabled, explore = {}, exploreMode = {}, pending = {}, approved = {} } = await chrome.storage.local.get(["enabled", "explore", "exploreMode", "pending", "approved"]);
  $("enabled").checked = enabled !== false;
  const st = await chrome.runtime.sendMessage({ type: "popup-status" }).catch(() => null);
  $("status").textContent = st?.connected ? "Bridge connected" : "Bridge not connected (run: website-mcp bridge install)";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const origin = tab?.url && originOf(tab.url);
  $("origin").textContent = origin ?? "(no web page)";
  $("allow").disabled = !origin;
  $("allow").onclick = async () => { await chrome.permissions.request({ origins: [`${origin}/*`] }); again(); };
  const { origins = [] } = await chrome.permissions.getAll();
  $("sites").replaceChildren(...origins.filter((o) => /^https?:/.test(o) && !/^https?:\/\/\*\//.test(o)).map((o) => {
    const li = doc.createElement("li");
    const b = doc.createElement("button");
    li.append(o, b);
    b.textContent = "Remove";
    b.onclick = async () => { await chrome.permissions.remove({ origins: [o] }); again(); };
    return li;
  }));
  const sess = (await chrome.storage.session?.get("exploreSession").catch(() => null))?.exploreSession ?? {};
  const end = explore[origin] ?? 0, live = end > Date.now(), at = new Date(end);
  const hhmm = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  // Show the duration the user chose (stored beside the expiry, display only); older entries fall back to the time left.
  const mode = live ? (["hour", "day"].includes(exploreMode[origin]) ? exploreMode[origin] : end - Date.now() > EXPLORE_HOUR_MS ? "day" : "hour") : sess[origin] ? "session" : "off";
  $("explore").value = mode;
  $("explore").disabled = !origin;
  $("exploreNote").textContent = mode === "session" ? "until the browser closes" : live ? `until ${at.toDateString() === new Date().toDateString() ? "" : "tomorrow "}${hhmm}` : "off";
  $("explore").onchange = async (e) => {
    const v = e.target.value, { [origin]: _a, ...loc } = explore, { [origin]: _b, ...ses } = sess, { [origin]: _c, ...modes } = exploreMode;
    if (v === "hour" || v === "day") { loc[origin] = Date.now() + (v === "day" ? EXPLORE_DAY_MS : EXPLORE_HOUR_MS); modes[origin] = v; }
    if (v === "session") ses[origin] = true;
    await chrome.storage.local.set({ explore: loc, exploreMode: modes });
    try { await chrome.storage.session.set({ exploreSession: ses }); } catch { /* no session storage: stays off */ }
    again();
  };
  const rows = (id, map, label, act) => $(id).replaceChildren(...Object.entries(map).map(([key, t]) => {
    const li = doc.createElement("li");
    const b = doc.createElement("button");
    li.append(`${t.toolName} v${t.version ?? "draft"} on ${t.site ?? "?"} #${t.hash.slice(0, 12)}`, b);
    b.textContent = label;
    b.onclick = async () => { await act(key, t); again(); };
    return li;
  }));
  rows("pending", pending, "Approve", async (k, t) => {
    const { [k]: _, ...rest } = pending;
    await chrome.storage.local.set({ approved: { ...approved, [k]: t }, pending: rest });
  });
  rows("approved", approved, "Revoke", (k) => { const { [k]: _, ...rest } = approved; return chrome.storage.local.set({ approved: rest }); });
  $("enabled").onchange = (e) => chrome.storage.local.set({ enabled: e.target.checked });
}
if (typeof chrome !== "undefined" && chrome.runtime?.id && typeof document !== "undefined") render(chrome, document);
