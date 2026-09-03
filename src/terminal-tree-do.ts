import { DurableObject } from "cloudflare:workers";
import { SessionTree, generateId } from "./tree/tree.ts";
import type { TreeHeader, ViewerInfo } from "./tree/types.ts";

/** How many data entries between automatic snapshots */
const SNAPSHOT_INTERVAL = 500;

const WS_OPEN = 1;

interface WebSocketAttachment {
  id: string;
  role: "viewer" | "sandbox";
  connectedAt: string;
  /** Viewers are read-only unless they presented the sandbox token. */
  canWrite: boolean;
}

export class TerminalTreeDO extends DurableObject {
  private tree: SessionTree;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.tree = new SessionTree(ctx.storage.sql);
  }

  /**
   * The attached sandbox, read from the socket tags rather than a field so it
   * survives hibernation and stays true after an eviction.
   */
  private get sandbox(): WebSocket | null {
    for (const ws of this.ctx.getWebSockets("sandbox")) {
      if (ws.readyState === WS_OPEN) return ws;
    }
    return null;
  }

  // --- HTTP dispatch ---

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/ws/sandbox") return this.handleSandboxUpgrade(request);
    if (path === "/ws/view") return this.handleViewerUpgrade(request);
    if (path === "/info") return this.handleInfo();
    if (path === "/tree") return this.handleGetTree();
    if (path === "/node" && url.searchParams.has("id"))
      return this.handleGetNode(url.searchParams.get("id")!);
    if (path === "/replay" && url.searchParams.has("id"))
      return this.handleReplay(url.searchParams.get("id")!);
    if (path === "/branch" && request.method === "POST")
      return this.handleBranch(request);
    if (path === "/label" && request.method === "POST")
      return this.handleLabel(request);
    if (path === "/init" && request.method === "POST")
      return this.handleInit(request);

    return new Response("not found", { status: 404 });
  }

  // --- Initialization ---

  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      sandboxUrl: string;
      cols: number;
      rows: number;
      name?: string;
    };

    const existing = this.tree.getHeader();
    if (existing) return Response.json(existing);

    const header: TreeHeader = {
      type: "tree",
      id: generateId(),
      timestamp: new Date().toISOString(),
      sandboxUrl: body.sandboxUrl,
      cols: body.cols,
      rows: body.rows,
      name: body.name,
    };
    this.tree.setHeader(header);
    return Response.json(header, { status: 201 });
  }

  // --- WebSocket: sandbox connection ---

  private handleSandboxUpgrade(_request: Request): Response {
    if (this.sandbox) {
      return new Response("sandbox already attached", { status: 409 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    const attachment: WebSocketAttachment = {
      id: generateId(),
      role: "sandbox",
      connectedAt: new Date().toISOString(),
      canWrite: true,
    };
    this.ctx.acceptWebSocket(server, ["sandbox"]);
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  // --- WebSocket: viewer connection ---

  private handleViewerUpgrade(request: Request): Response {
    const url = new URL(request.url);
    const canWrite = url.searchParams.get("write") === "1";
    const subprotocol = url.searchParams.get("protocol");

    const [client, server] = Object.values(new WebSocketPair());
    const attachment: WebSocketAttachment = {
      id: generateId(),
      role: "viewer",
      connectedAt: new Date().toISOString(),
      canWrite,
    };
    this.ctx.acceptWebSocket(server, ["viewer"]);
    server.serializeAttachment(attachment);

    server.send(JSON.stringify({ control: "access", write: canWrite }));

    // Send current tree info on connect
    const header = this.tree.getHeader();
    if (header) {
      server.send(JSON.stringify({ control: "header", ...header }));
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
      // A browser aborts the handshake unless the server echoes a subprotocol
      // it offered, so echo the carrier whether or not the token was good.
      headers: subprotocol ? { "Sec-WebSocket-Protocol": subprotocol } : undefined,
    });
  }

  // --- WebSocket message handling (hibernation-compatible) ---

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachment = ws.deserializeAttachment() as WebSocketAttachment;
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);

    if (attachment.role === "sandbox") {
      this.handleSandboxMessage(raw);
    } else {
      this.handleViewerMessage(attachment, raw);
    }
  }

  /** Data arriving from the sandbox (terminal output) */
  private handleSandboxMessage(raw: string) {
    // Record in tree
    this.tree.append({
      type: "data",
      direction: "out",
      data: btoa(raw),
    });

    // Fan out to all viewers
    for (const viewer of this.ctx.getWebSockets("viewer")) {
      viewer.send(raw);
    }

    this.maybeSnapshot();
  }

  /**
   * Input from a viewer (keystrokes, resize). A viewer that did not present
   * the sandbox token is read-only: its messages are dropped here, so they
   * reach neither the PTY nor the tree. Resize counts as a write — it changes
   * the terminal every other viewer sees.
   */
  private handleViewerMessage(attachment: WebSocketAttachment, raw: string) {
    if (!attachment.canWrite) return;

    // Check for control messages (JSON)
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "resize") {
        this.tree.append({ type: "resize", cols: msg.cols, rows: msg.rows });
        // Forward resize to sandbox
        this.sandbox?.send(raw);
        return;
      }
    } catch {
      // Not JSON — raw terminal input
    }

    // Record user input
    this.tree.append({
      type: "data",
      direction: "in",
      data: btoa(raw),
    });

    // Forward to sandbox
    this.sandbox?.send(raw);
  }

  private maybeSnapshot() {
    const since = this.tree.entriesSinceLastSnapshot();
    if (since >= SNAPSHOT_INTERVAL) {
      // TODO: request buffer state from sandbox via control message
      // For now, just record a marker
    }
  }

  // --- REST handlers ---

  private handleInfo(): Response {
    const header = this.tree.getHeader();
    if (!header) return new Response("not initialized", { status: 404 });

    const viewers: ViewerInfo[] = this.ctx.getWebSockets("viewer").map((ws) => {
      const att = ws.deserializeAttachment() as WebSocketAttachment;
      return {
        id: att.id,
        connectedAt: att.connectedAt,
        mode: "live",
        write: att.canWrite === true,
      };
    });

    return Response.json({
      ...header,
      entryCount: this.tree.entryCount(),
      leafId: this.tree.leafId,
      viewers,
      sandboxConnected: this.sandbox !== null,
    });
  }

  private handleGetTree(): Response {
    return Response.json(this.tree.getTree());
  }

  private handleGetNode(id: string): Response {
    const entry = this.tree.getEntry(id);
    if (!entry) return new Response("not found", { status: 404 });
    return Response.json(entry);
  }

  private handleReplay(id: string): Response {
    const seq = this.tree.buildReplaySequence(id);
    return Response.json(seq);
  }

  private async handleBranch(request: Request): Promise<Response> {
    const { toId, summary } = (await request.json()) as {
      toId: string;
      summary?: string;
    };
    const entry = this.tree.branch(toId, summary);
    if (entry === null && this.tree.leafId !== toId) {
      return new Response("entry not found", { status: 404 });
    }
    return Response.json({ leafId: this.tree.leafId, branchEntry: entry });
  }

  private async handleLabel(request: Request): Promise<Response> {
    const { targetId, label } = (await request.json()) as {
      targetId: string;
      label: string;
    };
    const entry = this.tree.append({ type: "label", targetId, label });
    return Response.json(entry, { status: 201 });
  }
}
