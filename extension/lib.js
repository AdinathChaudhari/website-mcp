// Pure logic for the service worker (importable from node tests with a mocked `chrome`).
const err = (code, message, details) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } });

/** Path glob (`*` = anything) matched against pathname + search. Missing pattern matches everything. */
export function matchesPath(pattern, url) {
  if (!pattern) return true;
  const u = new URL(url);
  const re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return re.test(u.pathname) || re.test(u.pathname + u.search);
}

/** Active tab if it matches, else the most recently used matching tab, else undefined. */
export function pickTab(tabs) {
  // Every window has one active tab: prefer active tabs, then the most recently accessed (the focused window's is newest).
  return [...tabs].sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}

export function composeCode(source, input, helpersText) {
  return `(async()=>{try{const wm=${helpersText};const fn=(${source});` +
    `return {ok:true,value:await fn({input:${JSON.stringify(input ?? null)},wm})};}` +
    `catch(e){return {ok:false,message:String((e&&e.message)||e)};}})()`;
}

export async function isEnabled(chrome) {
  const { enabled } = await chrome.storage.local.get("enabled");
  return enabled !== false;
}

async function userScriptsOn(chrome) {
  try {
    await chrome.userScripts.getScripts(); // throws while the "Allow User Scripts" toggle is off
    return typeof chrome.userScripts.execute === "function";
  } catch {
    return false;
  }
}

/** Handle one `run` request; returns {ok:true,value} or {ok:false,error}. Never creates or navigates tabs. */
export async function handleRun(chrome, msg, helpersText) {
  if (!(await isEnabled(chrome))) return err("NO_BRIDGE", "website-mcp is switched off in the extension popup");
  if (!chrome.userScripts || !(await userScriptsOn(chrome)))
    return err("USER_SCRIPTS_OFF", "Enable 'Allow User Scripts' on the extension's details page (brave://extensions), then retry");
  const granted = [];
  for (const o of msg.origins ?? []) if (await chrome.permissions.contains({ origins: [`${o}/*`] })) granted.push(o);
  if (!granted.length)
    return err("SITE_NOT_GRANTED", `Open ${msg.origins?.[0]} and click 'Allow this site' in the website-mcp extension popup`, { origins: msg.origins });
  const tabs = (await chrome.tabs.query({ url: granted.map((o) => `${o}/*`) })).filter((t) => t.url && matchesPath(msg.urlPattern, t.url));
  const tab = pickTab(tabs);
  if (!tab) return err("NO_TAB", `No open tab matches ${granted[0]}${msg.urlPattern ?? "/*"}; open it in your browser (${granted[0]}) and retry`);
  if (msg.needsVisible && !tab.active) return err("TAB_HIDDEN", "This tool needs the tab visible; switch to it and retry");
  let timer;
  const timeout = new Promise((r) => {
    timer = setTimeout(() => r(err("TIMEOUT", `Page script did not finish within ${msg.timeoutMs} ms`)), msg.timeoutMs);
  });
  const exec = chrome.userScripts
    .execute({ target: { tabId: tab.id }, js: [{ code: composeCode(msg.source, msg.input, helpersText) }], world: msg.world ?? "USER_SCRIPT", injectImmediately: true })
    .then((res) => {
      const r = res?.[0]?.result;
      if (res?.[0]?.error || !r) return err("SCRIPT_ERROR", String(res?.[0]?.error ?? "script returned nothing"));
      return r.ok ? { ok: true, value: r.value } : err("SCRIPT_ERROR", r.message);
    })
    .catch((e) => err("SCRIPT_ERROR", String(e?.message ?? e)));
  try {
    return await Promise.race([exec, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function handleTabs(chrome, msg) {
  if (!(await isEnabled(chrome))) return err("NO_BRIDGE", "website-mcp is switched off in the extension popup");
  const origins = [];
  for (const o of msg.origins ?? []) if (await chrome.permissions.contains({ origins: [`${o}/*`] })) origins.push(`${o}/*`);
  const tabs = origins.length ? await chrome.tabs.query({ url: origins }) : [];
  return { ok: true, value: tabs.map((t) => ({ id: t.id, url: t.url, active: t.active })) };
}

/** Dispatch a host message; returns the wire reply or undefined when none is due. */
export async function handleMessage(chrome, msg, helpersText, extVersion) {
  if (msg.type === "hello") return { type: "hello", version: 1, extVersion };
  if (msg.type !== "run" && msg.type !== "tabs") return undefined;
  const r = msg.type === "run" ? await handleRun(chrome, msg, helpersText) : await handleTabs(chrome, msg);
  return { type: "result", id: msg.id, ...r };
}
