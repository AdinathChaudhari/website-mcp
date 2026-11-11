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

function route(url) {
  const p = url.pathname;
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
  const m = /^\/item\/(\d+)$/.exec(p);
  if (m) {
    const it = ITEMS.find((x) => x.id === Number(m[1]));
    if (it) return [200, layout(it.title, `<article><h1 class="name">${esc(it.title)}</h1><p class="tag">${it.tag}</p></article>`)];
  }
  return [404, layout("Not found", "<h1>Not found</h1>")];
}

export async function start() {
  const server = http.createServer((req, res) => {
    const [status, html] = route(new URL(req.url, "http://127.0.0.1"));
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
