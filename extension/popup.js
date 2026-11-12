const $ = (id) => document.getElementById(id);
const originOf = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; } };

async function render() {
  const { enabled } = await chrome.storage.local.get("enabled");
  $("enabled").checked = enabled !== false;
  const st = await chrome.runtime.sendMessage({ type: "popup-status" }).catch(() => null);
  $("status").textContent = st?.connected ? "Bridge connected" : "Bridge not connected (run: website-mcp bridge install)";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const origin = tab?.url && originOf(tab.url);
  $("origin").textContent = origin ?? "(no web page)";
  $("allow").disabled = !origin;
  $("allow").onclick = async () => { await chrome.permissions.request({ origins: [`${origin}/*`] }); render(); };
  const { origins = [] } = await chrome.permissions.getAll();
  $("sites").replaceChildren(...origins.filter((o) => /^https?:/.test(o) && !/^https?:\/\/\*\//.test(o)).map((o) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    li.append(o, b);
    b.textContent = "Remove";
    b.onclick = async () => { await chrome.permissions.remove({ origins: [o] }); render(); };
    return li;
  }));
}
$("enabled").onchange = (e) => chrome.storage.local.set({ enabled: e.target.checked });
render();
