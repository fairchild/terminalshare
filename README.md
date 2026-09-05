# terminalshare

Persist and share terminal sessions as trees. Branch, label, replay. Every keystroke preserved.

## How it works

Each terminal session is stored as an append-only tree of entries in a Cloudflare Durable Object. Viewers connect via WebSocket and see the terminal rendered by [ghostty-web](https://github.com/ghostty-org/ghostty). The tree structure lets you branch at any point — try something, rewind, try something else.

### Entry types

- **data** — raw VT100 terminal data (input and output)
- **resize** — terminal dimension changes
- **snapshot** — full screen buffer capture for fast replay
- **branch** — fork point with optional summary
- **label** — user-defined bookmark
- **sandbox_change** — environment switch

## Stack

- **Runtime**: Cloudflare Workers + Durable Objects (SQLite storage)
- **Framework**: Hono
- **Terminal renderer**: ghostty-web
- **Package manager**: bun

## Auth

One shared secret, the `SANDBOX_TOKEN` Worker secret, gates everything that can
change a session. Reads are gated by the tree UUID alone — an unguessable link
is the sharing product.

| Operation | Gate |
|-----------|------|
| `POST /trees` | `Authorization: Bearer <token>` — 401 otherwise |
| `DELETE /trees/:id` | same bearer — the link alone must not destroy a tree |
| `WS /trees/:id/ws/sandbox` | same bearer — 401 otherwise, 409 if a sandbox is already attached |
| `WS /trees/:id/ws` (viewer) | open to anyone; **read-only** unless it presents the token |
| `GET /trees/:id`, `/tree`, `/node/:id`, `/replay/:id`, `/view` | the tree UUID |

A read-only viewer still connects and still renders live output. Its keystrokes
and its resizes are dropped in the Durable Object, so they reach neither the PTY
nor the tree. On connect every viewer receives `{"control":"access","write":…}`
saying which side of that line it is on, and `GET /trees/:id` reports a `write`
flag per connected viewer.

Comparison is constant-time (SHA-256 digests through `crypto.subtle.timingSafeEqual`),
so neither the value nor its length leaks through timing. If `SANDBOX_TOKEN` is
unset the Worker fails closed with 503 rather than opening the door.

### Presenting the token

Three carriers, in the order the Worker prefers them:

1. `Authorization: Bearer <token>` — the sandbox connector and any other Node or
   CLI client. The token never appears in a URL.
2. `Sec-WebSocket-Protocol: ts-token.<base64url(token)>` — browsers, which
   cannot set request headers on a WebSocket. The viewer page builds this from a
   `#token=…` fragment, which browsers never send to the server, so the token
   stays out of request logs:
   `https://terminalshare.com/trees/<id>/view#token=<token>`
3. `?token=<token>` — works, but **lands in request logs** at Cloudflare and in
   any intermediary. Prefer the fragment.

## Lifetime

A share is a capability handed out as a URL, and URLs leak — into scrollback,
into chat logs, into browser history. Every tree therefore has a deadline.

`POST /trees` takes an optional `ttlSeconds`; it defaults to **24 hours**, and
must be a whole number between 1 second and 30 days. Out-of-range values are
rejected with 400 rather than clamped, so a caller never gets a lifetime it did
not ask for. The resolved deadline comes back as `expiresAt` and is reported by
`GET /trees/:id`.

Once the deadline passes, the tree and every entry in it are purged, and
readers get 404. Two things drive that:

- **On access.** Any request touching an expired tree purges it first, so the
  answer is correct the instant the deadline passes, whatever the alarm is
  doing.
- **A Durable Object alarm**, armed at creation, reclaims the storage for a
  tree nobody comes back to. There is no index of trees to sweep — a tree is
  reachable only by naming its Durable Object — so an alarm the object holds
  against itself is the only mechanism that reaches every tree.

Purging calls `deleteAlarm()` then `deleteAll()`. `deleteAll()` is the only
call that clears SQLite's internal metadata as well as the rows, and it is what
lets the object cease to exist; the explicit `deleteAlarm()` is needed because
this Worker's compatibility date (`2025-04-01`) predates the 2026-02-24 change
that made `deleteAll()` clear the alarm too.

Trees created before TTL shipped carry no `expiresAt` and never expire — no
existing share was withdrawn by deploying this.

### Withdrawing a share early

```sh
curl -X DELETE -H "Authorization: Bearer $TERMINALSHARE_TOKEN" \
  https://terminalshare.com/trees/<id>
```

204 on success, and again on a repeat — deletion is idempotent, so a retry is
safe and the response does not reveal which tree ids exist. Connected viewers
are hung up on rather than left watching a tree that no longer exists.

## CORS

Cross-origin browser access is an allowlist keyed on `ENVIRONMENT`, not `*`.
An unlisted origin gets no `Access-Control-Allow-Origin` header at all.

Set `ALLOWED_ORIGINS` (comma-separated) to override the built-in set for an
environment whose hostname is not known at build time — `preview` ships empty
for exactly that reason. Same-origin requests never consult CORS, so an empty
set does not affect the viewer page, which is served from this origin.

Worth being straight about what this does and does not buy. Nothing here is
authorised by ambient browser state: there is no cookie and no session, the
write side wants an `Authorization` header the caller attaches deliberately,
and the read side is gated by the unguessable tree UUID. A wildcard therefore
handed a hostile page nothing it could not already fetch from its own server.
The allowlist matters because the wildcard was a loaded footgun — the day
someone adds a cookie session, `*` would silently become an open door in a
change that looks unrelated to CORS. `Access-Control-Allow-Credentials` stays
off, because there is nothing to send.

### Running a sandbox

```sh
source ~/.config/cloudcompute/terminalshare.env   # the file exports TERMINALSHARE_TOKEN
cd sandbox && npm install
npm start -- https://terminalshare.com
```

## Development

```sh
bun install
bun run dev          # wrangler dev on localhost:8789
bun run check        # typecheck
bun run test         # node --test against a real workerd via unstable_dev
```

`wrangler dev` needs the secret locally too — put `SANDBOX_TOKEN=…` in
`.dev.vars` (gitignored). The test suite supplies its own.

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/trees` | Create a new tree — **bearer**; optional `ttlSeconds` |
| `DELETE` | `/trees/:id` | Withdraw a share — **bearer**; idempotent 204 |
| `GET` | `/trees/:id` | Tree info, including `expiresAt` |
| `GET` | `/trees/:id/tree` | Full tree structure |
| `GET` | `/trees/:id/replay/:nodeId` | Replay sequence to a node |
| `POST` | `/trees/:id/branch` | Branch from a point |
| `POST` | `/trees/:id/label` | Add a bookmark |
| `WS` | `/trees/:id/ws` | Viewer WebSocket — read-only unless it presents the bearer |
| `WS` | `/trees/:id/ws/sandbox` | Sandbox WebSocket — **bearer**, one at a time |

## Deploy

The wrangler OAuth login covers more than one Cloudflare account, so set
`CLOUDFLARE_ACCOUNT_ID` before any non-interactive wrangler command or it will
refuse to pick one. (Deliberately not in `wrangler.jsonc` — this repo is public.)

```sh
export CLOUDFLARE_ACCOUNT_ID=...

# once per environment
openssl rand -base64 32 | ./node_modules/.bin/wrangler secret put SANDBOX_TOKEN --env production

bun run deploy:production
```

Set the secret *before* deploying the code that reads it; otherwise every write
returns 503 until the secret lands. Only `terminalshare` (production) exists on
the account today — `terminalshare-preview` is configured in `wrangler.jsonc`
but has never been deployed.

Keep the value in `~/.config/cloudcompute/terminalshare.env` (mode 600) as
`export TERMINALSHARE_TOKEN=…` (with the `export`, so sourcing the file puts the
value in the environment the connector inherits; a plain assignment would not).

To roll back a deploy: `./node_modules/.bin/wrangler rollback --env production`.
To revoke every outstanding token: put a fresh secret.

## License

Apache 2.0 — see [LICENSE](LICENSE).
