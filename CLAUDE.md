# terminalshare

Persist and share terminal state as a tree. Each terminal session is a Durable Object holding an append-only tree of entries (data, snapshots, branches, labels). Viewers connect via WebSocket; the DO proxies between viewers and the sandbox PTY.

## Stack

- **Runtime**: Cloudflare Workers + Durable Objects (SQLite storage)
- **Framework**: Hono
- **Package manager**: bun (`bun.lock`)
- **Language**: TypeScript (strict)

## Architecture

- **Tree model** adapted from [pi-mono](~/code/github/pi-mono/) `SessionManager` — append-only entries with `id`/`parentId` forming a tree, branching by moving the leaf pointer
- **ghostty-web** is the intended browser renderer — raw VT100 over WebSocket, JSON for resize
- **space.cloudcompute.com** (workspaces project) provides the terminal and agents; terminalshare focuses purely on persistence and sharing
- One Durable Object per terminal tree — colocated state + WebSocket fanout

## Key Files

- `src/tree/types.ts` — Entry types: data, resize, snapshot, branch, label, sandbox_change
- `src/tree/tree.ts` — `SessionTree` class: append, branch, getTree, buildReplaySequence
- `src/terminal-tree-do.ts` — `TerminalTreeDO` Durable Object: WebSocket relay + tree storage
- `src/index.ts` — Hono routes: REST API + WebSocket upgrades

## Commands

```sh
bun run dev          # wrangler dev
bun run check        # tsc
bun run deploy:preview
bun run deploy:production
```

## Conventions

- Conventional commits
- Minimal comments — let types speak
- `NewEntry` type for appending (distributive Omit over the entry union)
