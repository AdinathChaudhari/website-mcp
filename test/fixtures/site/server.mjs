// Deterministic fixture site on node:http. No external assets, no network beyond 127.0.0.1.
// start() -> { url, close }. Port is ephemeral.
import http from "node:http";

export const ITEMS = Array.from({ length: 25 }, (_, i) => ({
  id: i + 1,
  title: `Fixture item ${String(i + 1).padStart(2, "0")}`,
  tag: i % 5 === 0 ? "alpha" : i % 2 === 0 ? "beta" : "gamma",
}));
export const PAGE_SIZE = 10;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const layout = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>` +
  `<header><nav><a href="/items">Items</a> <form action="/search" method="get"><input name="q" type="search" aria-label="Search"><button>Search</button></form></nav></header>` +
  `<main>${body}</main></body></html>`;
const card = (it) => `<li class="item" data-id="${it.id}"><a class="title" href="/item/${it.id}">${esc(it.title)}</a> <span class="tag">${it.tag}</span></li>`;

// Write fixture: a form whose Save posts to /submit, which bumps a server-side counter (GET /count reads it).
// /submit?delay=<ms> bumps FIRST and answers late, so a run killed mid-save leaves the counter honestly at +1.
let counter = 0;
const FORM = `<h1>Profile</h1><form id="f" onsubmit="return false"><input id="name" name="name" aria-label="Name"><button id="save" type="button">Save</button></form><p id="status"></p>` +
  `<script>document.getElementById("save").onclick=async()=>{const d=new URLSearchParams(location.search).get("delay")||"0";await fetch("/submit?delay="+d,{method:"POST",body:document.getElementById("name").value});const p=document.createElement("p");p.className="saved";p.textContent="Saved";document.body.appendChild(p)}</script>`;

function route(url) {
  const p = url.pathname;
  if (p === "/form") return [200, layout("Profile", FORM)];
  if (p === "/count") return [200, String(counter)];
  if (p === "/items") {
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const slice = ITEMS.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const more = page * PAGE_SIZE < ITEMS.length;
    return [200, layout("Items", `<h1>Items</h1><ul class="items">${slice.map(card).join("")}</ul><p class="pager">Page ${page}${more ? ` <a class="next" href="/items?page=${page + 1}">next</a>` : ""}</p>`)];
  }
  if (p === "/search") {
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const hits = q ? ITEMS.filter((it) => it.title.toLowerCase().includes(q) || it.tag === q) : [];
    const body = hits.length
      ? `<h1>Results for ${esc(q)}</h1><ul class="results">${hits.map(card).join("")}</ul>`
      : `<h1>Results for ${esc(q)}</h1><p class="empty">No results found.</p>`;
    return [200, layout("Search", body)];
  }
  if (p === "/checkpoint") return [200, layout("Security check", `<h1>Let's verify you are human</h1><iframe src="https://captcha.invalid/frame" title="captcha"></iframe>`)];
  const m = /^\/item\/(\d+)$/.exec(p);
  if (m) {
    const it = ITEMS.find((x) => x.id === Number(m[1]));
    if (it) return [200, layout(it.title, `<article><h1 class="name">${esc(it.title)}</h1><p class="tag">${it.tag}</p></article>`)];
  }
  return [404, layout("Not found", "<h1>Not found</h1>")];
}

export async function start() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/submit" && req.method === "POST") {
      req.resume();
      counter++;
      setTimeout(() => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); }, Number(u.searchParams.get("delay")) || 0);
      return;
    }
    const [status, html] = route(new URL(req.url, "http://127.0.0.1"));
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    count: () => counter,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
