import { EXPLORE_MS } from "./lib.js";
export const originOf = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; } };

/** Draw the popup. `chrome` and `doc` are injected so tests can mock them. */
export async function render(chrome, doc) {
  const $ = (id) => doc.getElementById(id);
  const again = () => render(chrome, doc);
  const { enabled, explore = {}, pending = {}, approved = {} } = await chrome.storage.local.get(["enabled", "explore", "pending", "approved"]);
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
  const left = Math.ceil(((explore[origin] ?? 0) - Date.now()) / 60000);
  $("explore").checked = left > 0;
  $("explore").disabled = !origin;
  $("exploreNote").textContent = left > 0 ? `open, ${left} min left` : "closed";
  $("explore").onchange = async (e) => {
    await chrome.storage.local.set({ explore: { ...explore, [origin]: e.target.checked ? Date.now() + EXPLORE_MS : 0 } });
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
