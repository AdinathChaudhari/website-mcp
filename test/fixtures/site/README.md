# test/fixtures/site/

`server.mjs`: deterministic `node:http` site. `/items?page=N` (25 items, 10 per page, "next" link),
`/search?q=` (results or `p.empty` state), `/item/<id>`. `start()` returns `{ url, close }` on an ephemeral port.

Write fixture: `/form` (a name field and Save; Save posts to `/submit?delay=<ms>`), `/count` (the server-side counter), `start()` also returns `count()`.
