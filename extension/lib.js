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

export function composeCode(source, input, helpersText, signin, write) {
  // Write tools: arm the helper with the dryRun the runtime chose (once), and report whether the user saved.
  const arm = write ? `wm._arm(${write.dryRun !== false});` : "";
  const ret = write ? "{ok:true,value:{value:v,committed:wm.committed()}}" : "{ok:true,value:v}";
  const gate = signin ? `if(!document.querySelector(${JSON.stringify(signin.marker)}))return {ok:false,signedOut:true};` : "";
  // A challenge is checked before the tool (it never runs on one), after it (the result is discarded) and when it throws; ahead of the sign-in marker.
  return `(async()=>{const wm=${helpersText};${arm}const ch=()=>{try{const c=wm.challenge();return c?{ok:false,challenge:c${write ? ",committed:wm.committed()" : ""}}:null}catch(e){return null}};` +
    `try{const c=ch();if(c)return c;${gate}const v=await (${source})({input:${JSON.stringify(input ?? null)},wm});return ch()||${ret};}` +
    `catch(e){return ch()||{ok:false,message:String((e&&e.message)||e)};}})()`;
}

export const EXPLORE_HOUR_MS = 60 * 60 * 1000;
export const EXPLORE_DAY_MS = 24 * EXPLORE_HOUR_MS;
export const EXPLORE_OFF = (o) => `The explore window for ${o} is closed; ask the user to open it in the popup (1 hour, 1 day, or until the browser closes)`;
export const CAPS = { snapshot: 256 * 1024, explore: 256 * 1024, capture: 8 * 1024 * 1024 };
export const approvalKey = (m, hash) => `${m.toolName}|${m.version ?? "draft"}|${hash}`;
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon)}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k]))}}` : JSON.stringify(v ?? null));
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
/** Approval binds to the code and scope that will run, computed here: never trust a hash the requester sends. Node mirrors this in runners/page.ts. */
export async function runHash(m, helpersText) {
  // Write tools also bind to the helper text (fill / handOff). Read tools hash exactly as before.
  const w = m.effect === "write" ? { effect: "write", helpers: await sha(helpersText ?? "") } : {};
  const text = canon({ source: m.source, world: m.world ?? "USER_SCRIPT", urlPattern: m.urlPattern ?? null, origins: m.origins ?? [], signin: m.signin ?? null, needsVisible: !!m.needsVisible, ...w });
  return sha(text);
}
const originOfUrl = (u) => { try { return new URL(u).origin; } catch { return null; } };
/** Open = unexpired local expiry (1 hour / 1 day) or a session flag (until the browser closes). Checked at use time; no session storage = closed. */
export async function exploreOpen(chrome, origin) {
  const { explore = {} } = await chrome.storage.local.get("explore");
  if ((explore[origin] ?? 0) > Date.now()) return true;
  try { return (await chrome.storage.session.get("exploreSession")).exploreSession?.[origin] === true; } catch { return false; }
}

// Model-written outline of the page: roles, accessible names, trimmed text.
const SNAPSHOT_JS = `(()=>{const o=[];const w=(e,d)=>{if(o.length>4000||d>30)return;const t=e.tagName.toLowerCase();if(/^(script|style|noscript|svg|template)$/.test(t))return;` +
  `const r=e.getAttribute("role")||({a:"link",button:"button",input:"textbox",select:"combobox",textarea:"textbox",h1:"heading",h2:"heading",h3:"heading",ul:"list",li:"listitem",table:"table",form:"form",nav:"navigation",main:"main"})[t];` +
  `const n=(e.getAttribute("aria-label")||e.getAttribute("alt")||e.getAttribute("placeholder")||"").slice(0,80);` +
  `const own=[...e.childNodes].filter(c=>c.nodeType===3).map(c=>c.textContent.trim()).join(" ").slice(0,120);` +
  `if(r||n||own)o.push("  ".repeat(d)+(r||t)+(n?' "'+n+'"':"")+(own?": "+own:""));for(const c of e.children)w(c,d+1)};w(document.body,0);return o.join("\\n")})()`;

const execIn = (chrome, tabId, code, world, timeoutMs, errCode = "SCRIPT_ERROR") => {
  let timer;
  const timeout = new Promise((r) => { timer = setTimeout(() => r(err("TIMEOUT", `Page script did not finish within ${timeoutMs} ms`)), timeoutMs); });
  const exec = chrome.userScripts
    .execute({ target: { tabId }, js: [{ code }], world, injectImmediately: true })
    .then((res) => {
      const r = res?.[0]?.result;
      if (res?.[0]?.error || !r) return err(errCode, String(res?.[0]?.error ?? "script returned nothing"));
      if (r.challenge) return err("CHALLENGE", `The page shows a challenge or block (${r.challenge}); the run stopped and will not retry`, r.committed === true ? { committed: true } : undefined);
      if (r.signedOut) return err("SIGNED_OUT", "signed-in marker not found in the tab");
      return r.ok ? { ok: true, value: r.value } : err(errCode, r.message);
    })
    .catch((e) => err(errCode, String(e?.message ?? e)));
  return Promise.race([exec, timeout]).finally(() => clearTimeout(timer));
};

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

async function gate(chrome) {
  if (!(await isEnabled(chrome))) return err("NO_BRIDGE", "website-mcp is switched off in the extension popup");
  if (!chrome.userScripts || !(await userScriptsOn(chrome)))
    return err("USER_SCRIPTS_OFF", "Enable 'Allow User Scripts' on the extension's details page (chrome://extensions), then retry");
}

/** True when the tab's window has focus (an active tab in a background window is not visible). Unreadable = no. */
const focused = (chrome, tab) => chrome.windows.get(tab.windowId).then((w) => !!w.focused, () => false);

/** Handle one `run` request; returns {ok:true,value} or {ok:false,error}. Never creates or navigates tabs. */
export async function handleRun(chrome, msg, helpersText) {
  const bad = await gate(chrome);
  if (bad) return bad;
  const granted = [];
  for (const o of msg.origins ?? []) if (await chrome.permissions.contains({ origins: [`${o}/*`] })) granted.push(o);
  if (!granted.length)
    return err("SITE_NOT_GRANTED", `Open ${msg.origins?.[0]} and click 'Allow this site' in the website-mcp extension popup`, { origins: msg.origins });
  if (msg.draft) {
    const open = [];
    for (const o of granted) if (await exploreOpen(chrome, o)) open.push(o);
    granted.splice(0, granted.length, ...open); // a draft only runs in tabs of origins whose explore window is open
    if (!granted.length) return err("EXPLORE_OFF", "Draft runs need the popup's explore window open for this site");
  } else {
    const { approved = {}, pending = {} } = await chrome.storage.local.get(["approved", "pending"]);
    const hash = await runHash(msg, helpersText);
    const key = approvalKey(msg, hash);
    if (!approved[key]) {
      pending[key] = { toolName: msg.toolName, version: msg.version ?? null, hash, site: msg.origins?.[0] };
      await chrome.storage.local.set({ pending });
      return err("NEEDS_APPROVAL", "Approve this tool version in the extension popup", { toolName: msg.toolName, hash });
    }
  }
  const tabs = (await chrome.tabs.query({ url: granted.map((o) => `${o}/*`) })).filter((t) => t.url && matchesPath(msg.urlPattern, t.url));
  const tab = pickTab(tabs);
  if (!tab) return err("NO_TAB", `No open tab matches ${granted[0]}${msg.urlPattern ?? "/*"}; open it in your browser (${granted[0]}) and retry`);
  if (msg.needsVisible && !(tab.active && (await focused(chrome, tab)))) return err("TAB_HIDDEN", "This tool needs the tab visible; switch to it and retry");
  const write = msg.effect === "write" ? { dryRun: msg.dryRun } : undefined;
  // Badge "waiting for you" while a real (not dry) write run may be waiting for the user's Save; always cleared afterwards.
  const badge = (t) => { try { chrome.action?.setBadgeText({ text: t }); } catch { /* no action api */ } };
  if (write && write.dryRun === false) badge("WAIT");
  const r = await execIn(chrome, tab.id, composeCode(msg.source, msg.input, helpersText, msg.signin, write), msg.world ?? "USER_SCRIPT", msg.timeoutMs).finally(() => write?.dryRun === false && badge(""));
  if (r.error?.code === "SIGNED_OUT" && msg.signin) r.error.message = `signed-in marker not found; sign in at ${msg.signin.loginUrl}`;
  return r;
}

/** snapshot / explore / capture: only on a granted tab whose explore window is open. */
export async function handleExplore(chrome, msg, helpersText) {
  const bad = await gate(chrome);
  if (bad) return bad;
  const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
  const origin = tab?.url && originOfUrl(tab.url);
  if (!origin || !/^https?:/.test(origin)) return err("NO_TAB", `No http(s) tab with id ${msg.tabId}`);
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) return err("SITE_NOT_GRANTED", `Click 'Allow this site' in the website-mcp popup on ${origin}`);
  if (!(await exploreOpen(chrome, origin))) return err("EXPLORE_OFF", EXPLORE_OFF(origin));
  const body = msg.type === "snapshot" ? SNAPSHOT_JS : msg.type === "capture" ? `({url:location.href,title:document.title,html:document.documentElement.outerHTML})` : `(async()=>{${msg.code}\n})()`;
  // Same challenge guard as a run: nothing runs on a checkpoint page, and a result or error from one is replaced by CHALLENGE.
  const code = `(async()=>{const wm=${helpersText};const ch=()=>{try{const c=wm.challenge();return c?{ok:false,challenge:c}:null}catch(e){return null}};` +
    `const c0=ch();if(c0)return c0;try{const v=await ${body};return ch()||{ok:true,value:JSON.stringify(v===undefined?null:v)};}catch(e){return ch()||{ok:false,message:String((e&&e.message)||e)};}})()`;
  const r = await execIn(chrome, tab.id, code, "USER_SCRIPT", msg.type === "explore" ? msg.timeoutMs : 15000);
  if (!r.ok) return r;
  if (r.value.length > CAPS[msg.type]) return err("SCRIPT_ERROR", `${msg.type} result is ${r.value.length} chars, over the ${CAPS[msg.type]} cap; narrow it`);
  return { ok: true, value: JSON.parse(r.value) };
}

export async function handleTabs(chrome, msg) {
  if (!(await isEnabled(chrome))) return err("NO_BRIDGE", "website-mcp is switched off in the extension popup");
  const out = [];
  const all = msg.origins ? await chrome.tabs.query({ url: msg.origins.map((o) => `${o}/*`) }) : await chrome.tabs.query({});
  for (const t of all) {
    const origin = t.url && originOfUrl(t.url);
    if (!origin || !/^https?:/.test(origin)) continue;
    const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
    if (msg.origins && !granted) continue;
    out.push({ id: t.id, url: t.url, title: t.title ?? "", active: !!t.active, granted, explore: granted && (await exploreOpen(chrome, origin)) });
  }
  return { ok: true, value: out };
}

/** Dispatch a host message; returns the wire reply or undefined when none is due. */
export async function handleMessage(chrome, msg, helpersText, extVersion) {
  if (msg.type === "hello") return { type: "hello", version: 2, extVersion };
  const h = { run: handleRun, tabs: handleTabs, snapshot: handleExplore, explore: handleExplore, capture: handleExplore }[msg.type];
  if (!h) return undefined;
  const r = await h(chrome, msg, helpersText);
  return { type: "result", id: msg.id, ...r };
}
