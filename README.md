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

## Development

```sh
bun install
bun run dev          # wrangler dev on localhost:8789
bun run check        # typecheck
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/trees` | Create a new tree |
| `GET` | `/trees/:id` | Tree info |
| `GET` | `/trees/:id/tree` | Full tree structure |
| `GET` | `/trees/:id/replay/:nodeId` | Replay sequence to a node |
| `POST` | `/trees/:id/branch` | Branch from a point |
| `POST` | `/trees/:id/label` | Add a bookmark |
| `WS` | `/trees/:id/ws` | Viewer WebSocket |
| `WS` | `/trees/:id/ws/sandbox` | Sandbox WebSocket |

## Deploy

```sh
bun run deploy:preview
bun run deploy:production
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
