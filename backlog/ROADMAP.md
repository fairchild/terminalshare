# terminalshare roadmap

## Current state

The core is working: append-only tree model, Durable Object with SQLite storage, WebSocket fanout (sandbox to viewers), REST API (8 endpoints), and a ghostty-web viewer for live terminal watching. Sandbox connector bridges a local PTY to the Worker.

Writes are gated: a `SANDBOX_TOKEN` bearer is required to create a tree or attach a sandbox, only one sandbox may attach at a time, and viewers are read-only unless they present the same token. Reads stay gated by the tree UUID.

What's missing: snapshot capture is stubbed (TODO in `terminal-tree-do.ts`), no UI for branching/replay/labels, no tree discovery. **The nearest gap is lifecycle** — a tree lives forever and there is no way to delete one, so a token holder who creates trees is creating permanent storage. TTL and delete are the next auth-adjacent work (Phase 4).

---

## Phase 1: Foundation

Get the basics solid before building features on top.

- [ ] **Snapshot capture protocol** — define control message from DO to sandbox requesting buffer state; sandbox responds with screen buffer; DO stores as SnapshotEntry. Unblocks replay and fast seek.
- [x] **Auth** — `SANDBOX_TOKEN` bearer on `POST /trees` and the sandbox WebSocket upgrade (401 on miss, constant-time compare, 503 if the secret is unset). Second sandbox attach gets 409 instead of evicting the first. Viewers connect anonymously and read-only; the same token upgrades them to write, carried as `Authorization`, a `ts-token.` subprotocol, or `?token=`. Reads stay link-gated by the tree UUID. See README, "Auth".
- [ ] **Error handling** — handle sandbox-not-connected gracefully in viewer (show "waiting for terminal..." instead of blank screen). Handle tree-not-found on viewer page with a proper error UI.
- [ ] **Serve static files from public/** — move LANDING_HTML and VIEWER_HTML out of index.ts into public/ served via Workers static assets instead of inline template strings.

## Phase 2: Tree navigation

The tree model supports branching and replay but the viewer is live-only.

- [ ] **Replay mode** — viewer can navigate to any node in the tree and replay terminal state from that point. Toggle between live and replay modes.
- [ ] **Branch UI** — button or command to branch at current point. Shows existing branches as a tree sidebar or overlay.
- [ ] **Label UI** — add bookmarks to moments in the session. Jump to labeled points.
- [ ] **Tree visualization** — sidebar or overlay showing the tree structure, branches, labels. Click to navigate.

## Phase 3: Sharing & discovery

Make it useful for others to find and watch sessions.

- [ ] **Tree listing** — index page showing active/recent trees. Requires a registry (KV namespace or D1) since each tree is a separate DO.
- [ ] **Share links** — `/t/:shortId` or similar short URLs for sharing. Optional expiry.
- [x] **Read-only mode** — now the default rather than a flag. Unauthenticated viewer input and resizes are dropped in the DO before they touch the PTY or the tree.
- [ ] **Embed widget** — iframe-friendly viewer with configurable dimensions for embedding in docs or blogs.

## Phase 4: Session management

Lifecycle features for long-running or completed sessions.

- [ ] **Session end** — explicit close event when sandbox disconnects. Mark tree as "ended" vs "live".
- [ ] **Compaction** — collapse long runs of data entries between snapshots. Keep snapshots + labels + branches, discard intermediate data for old sessions.
- [ ] **Export** — download a session as asciicast (asciinema format) or raw log. Enables portability.
- [ ] **TTL / cleanup** — auto-expire trees after a configurable duration, and a `DELETE /trees/:id` behind the bearer. **Next gap:** with writes gated but no lifecycle, every tree ever created is permanent, and a leaked link is permanent read access to a whole session.

## Phase 5: Multi-user & collaboration

Beyond single-sandbox-to-viewers.

- [ ] **Multiple viewers with cursors** — show who else is watching. Presence indicators.
- [ ] **Collaborative input** — multiple viewers can type, with turn-taking or free-for-all modes.
- [ ] **Annotations** — viewers can add notes at points in the tree without affecting terminal state.
- [ ] **Notifications** — webhook or push when a tree becomes active or reaches a labeled point.

---

## Non-goals (for now)

- **Terminal emulation** — terminalshare doesn't run terminals; that's the sandbox (workspaces/waterworks)
- **Recording playback speed control** — replay is structural (tree navigation), not time-based
- **Multi-sandbox per tree** — one sandbox per tree for simplicity; branching handles divergent paths
