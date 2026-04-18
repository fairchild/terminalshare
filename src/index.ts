import { Hono } from "hono";
import { cors } from "hono/cors";

export { TerminalTreeDO } from "./terminal-tree-do.ts";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors());

app.get("/", async (c) => {
  const accept = c.req.header("accept") ?? "";
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return c.json({
      name: "terminalshare",
      status: "ok",
      environment: c.env.ENVIRONMENT,
      endpoints: {
        createTree: "POST /trees",
        treeInfo: "GET /trees/:id",
        treeStructure: "GET /trees/:id/tree",
        node: "GET /trees/:id/node/:nodeId",
        replay: "GET /trees/:id/replay/:nodeId",
        branch: "POST /trees/:id/branch",
        label: "POST /trees/:id/label",
        viewerWebSocket: "GET /trees/:id/ws",
        sandboxWebSocket: "GET /trees/:id/ws/sandbox",
      },
    });
  }
  return c.html(LANDING_HTML);
});

app.get("/healthz", (c) => {
  return c.json({ status: "ok", environment: c.env.ENVIRONMENT });
});

// --- Tree lifecycle ---

/** Create a new terminal tree */
app.post("/trees", async (c) => {
  const body = await c.req.json<{
    sandboxUrl: string;
    cols?: number;
    rows?: number;
    name?: string;
  }>();

  const treeId = crypto.randomUUID();
  const stub = c.env.TERMINAL_TREE.get(
    c.env.TERMINAL_TREE.idFromName(treeId)
  );

  const res = await stub.fetch(new Request("http://do/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sandboxUrl: body.sandboxUrl,
      cols: body.cols ?? 80,
      rows: body.rows ?? 24,
      name: body.name,
    }),
  }));

  const header = await res.json() as Record<string, unknown>;
  return c.json({ treeId, ...header }, 201);
});

/** Get tree info */
app.get("/trees/:id", async (c) => {
  const stub = getStub(c);
  const res = await stub.fetch(new Request("http://do/info"));
  return c.json(await res.json());
});

/** Get full tree structure */
app.get("/trees/:id/tree", async (c) => {
  const stub = getStub(c);
  const res = await stub.fetch(new Request("http://do/tree"));
  return c.json(await res.json());
});

/** Get a specific node */
app.get("/trees/:id/node/:nodeId", async (c) => {
  const stub = getStub(c);
  const nodeId = c.req.param("nodeId");
  const res = await stub.fetch(new Request(`http://do/node?id=${nodeId}`));
  if (res.status === 404) return c.json({ error: "not found" }, 404);
  return c.json(await res.json());
});

/** Get replay sequence to reach a node */
app.get("/trees/:id/replay/:nodeId", async (c) => {
  const stub = getStub(c);
  const nodeId = c.req.param("nodeId");
  const res = await stub.fetch(new Request(`http://do/replay?id=${nodeId}`));
  return c.json(await res.json());
});

/** Branch from a point in the tree */
app.post("/trees/:id/branch", async (c) => {
  const stub = getStub(c);
  const body = await c.req.json();
  const res = await stub.fetch(new Request("http://do/branch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  if (res.status === 404) return c.json({ error: "entry not found" }, 404);
  return c.json(await res.json());
});

/** Add a label/bookmark */
app.post("/trees/:id/label", async (c) => {
  const stub = getStub(c);
  const body = await c.req.json();
  const res = await stub.fetch(new Request("http://do/label", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return c.json(await res.json(), 201);
});

// --- Viewer ---

/** Serve the ghostty-web viewer page */
app.get("/trees/:id/view", async (c) => {
  // Verify tree exists
  const stub = getStub(c);
  const res = await stub.fetch(new Request("http://do/info"));
  if (res.status === 404) return c.json({ error: "tree not found" }, 404);

  return c.html(VIEWER_HTML);
});

// --- WebSocket upgrades ---

/** Viewer connects to watch/interact with the terminal */
app.get("/trees/:id/ws", async (c) => {
  const stub = getStub(c);
  return stub.fetch(new Request("http://do/ws/view", {
    headers: c.req.raw.headers,
  }));
});

/** Sandbox connects to relay its PTY */
app.get("/trees/:id/ws/sandbox", async (c) => {
  const stub = getStub(c);
  return stub.fetch(new Request("http://do/ws/sandbox", {
    headers: c.req.raw.headers,
  }));
});

// --- Helpers ---

function getStub(c: { env: Env; req: { param: (k: string) => string } }) {
  const id = c.req.param("id");
  return c.env.TERMINAL_TREE.get(c.env.TERMINAL_TREE.idFromName(id));
}

// --- Landing HTML ---

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>terminalshare</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      height: 100%;
      background: #0d1117;
      color: #e6edf3;
      font-family: 'JetBrains Mono', 'Fira Code', 'SF Mono', Monaco, monospace;
    }
    .page { max-width: 720px; margin: 0 auto; padding: 80px 24px; }
    h1 { font-size: 32px; font-weight: 700; margin-bottom: 8px; letter-spacing: -0.5px; }
    .tagline { font-size: 16px; color: #8b949e; margin-bottom: 48px; line-height: 1.5; }
    .terminal-demo {
      background: #161b22; border: 1px solid #30363d;
      border-radius: 8px; overflow: hidden; margin-bottom: 48px;
    }
    .terminal-bar {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 16px; background: #1c2128; border-bottom: 1px solid #30363d;
    }
    .terminal-dot { width: 12px; height: 12px; border-radius: 50%; }
    .terminal-dot.r { background: #f85149; }
    .terminal-dot.y { background: #d29922; }
    .terminal-dot.g { background: #3fb950; }
    .terminal-bar .title { flex: 1; text-align: center; font-size: 12px; color: #8b949e; }
    .terminal-body {
      padding: 20px; font-size: 14px; line-height: 1.6; color: #8b949e; min-height: 200px;
    }
    .terminal-body .prompt { color: #3fb950; }
    .terminal-body .cmd { color: #e6edf3; }
    .terminal-body .out { color: #8b949e; }
    .terminal-body .url { color: #58a6ff; }
    .terminal-body .dim { color: #484f58; }
    .terminal-body .line { display: block; margin-bottom: 2px; }
    .tree-viz { margin: 12px 0; color: #58a6ff; }
    .tree-viz .branch { color: #d29922; }
    .tree-viz .label { color: #3fb950; }
    .tree-viz .node { color: #8b949e; }
    .features {
      display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 48px;
    }
    @media (max-width: 540px) { .features { grid-template-columns: 1fr; } }
    .feature {
      padding: 20px; background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    }
    .feature h3 { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
    .feature p { font-size: 13px; color: #8b949e; line-height: 1.5; }
    .api-section { margin-bottom: 48px; }
    .api-section h2 { font-size: 18px; font-weight: 600; margin-bottom: 16px; }
    .endpoint {
      display: flex; gap: 12px; align-items: baseline;
      padding: 8px 0; border-bottom: 1px solid #21262d; font-size: 13px;
    }
    .endpoint:last-child { border-bottom: none; }
    .method { font-weight: 600; min-width: 48px; }
    .method.get { color: #3fb950; }
    .method.post { color: #d29922; }
    .method.ws { color: #a371f7; }
    .path { color: #e6edf3; }
    .desc { color: #8b949e; margin-left: auto; }
    footer { padding-top: 32px; border-top: 1px solid #21262d; font-size: 12px; color: #484f58; }
  </style>
</head>
<body>
  <div class="page">
    <h1>terminalshare</h1>
    <p class="tagline">
      Persist and share terminal sessions as trees.<br>
      Branch, label, replay. Every keystroke preserved.
    </p>
    <div class="terminal-demo">
      <div class="terminal-bar">
        <span class="terminal-dot r"></span>
        <span class="terminal-dot y"></span>
        <span class="terminal-dot g"></span>
        <span class="title">session tree</span>
      </div>
      <div class="terminal-body">
        <span class="line"><span class="prompt">\$</span> <span class="cmd">curl -X POST /trees</span></span>
        <span class="line"><span class="out">{ "treeId": "a1b2c3d4" }</span></span>
        <span class="line">&nbsp;</span>
        <div class="tree-viz">
<span class="line"><span class="node">root</span></span>
<span class="line"><span class="dim">  |</span></span>
<span class="line"><span class="dim">  +--</span> <span class="node">setup</span> <span class="label">[init]</span></span>
<span class="line"><span class="dim">  |</span></span>
<span class="line"><span class="dim">  +--</span> <span class="node">debugging</span></span>
<span class="line"><span class="dim">  |    |</span></span>
<span class="line"><span class="dim">  |    +--</span> <span class="branch">branch: "try fix A"</span></span>
<span class="line"><span class="dim">  |    |</span></span>
<span class="line"><span class="dim">  |    +--</span> <span class="branch">branch: "try fix B"</span> <span class="label">[working]</span></span>
<span class="line"><span class="dim">  |</span></span>
<span class="line"><span class="dim">  +--</span> <span class="node">deploy</span> <span class="dim">&lt;live&gt;</span></span>
        </div>
        <span class="line">&nbsp;</span>
        <span class="line"><span class="prompt">\$</span> <span class="cmd">open /trees/a1b2c3d4/view</span></span>
        <span class="line"><span class="url">https://terminalshare.com/trees/a1b2c3d4/view</span></span>
      </div>
    </div>
    <div class="features">
      <div class="feature">
        <h3>Append-only trees</h3>
        <p>Every terminal event is an entry in a tree. Fork at any point to explore different paths.</p>
      </div>
      <div class="feature">
        <h3>Live sharing</h3>
        <p>Viewers connect via WebSocket and see the terminal in real time through ghostty-web.</p>
      </div>
      <div class="feature">
        <h3>Branching</h3>
        <p>Move the leaf pointer to branch. Try something, rewind, try something else.</p>
      </div>
      <div class="feature">
        <h3>Replay</h3>
        <p>Walk any path from root to leaf. Snapshots let you jump to any point without full replay.</p>
      </div>
    </div>
    <div class="api-section">
      <h2>API</h2>
      <div class="endpoint">
        <span class="method post">POST</span>
        <span class="path">/trees</span>
        <span class="desc">create a tree</span>
      </div>
      <div class="endpoint">
        <span class="method get">GET</span>
        <span class="path">/trees/:id</span>
        <span class="desc">tree info</span>
      </div>
      <div class="endpoint">
        <span class="method get">GET</span>
        <span class="path">/trees/:id/tree</span>
        <span class="desc">full structure</span>
      </div>
      <div class="endpoint">
        <span class="method get">GET</span>
        <span class="path">/trees/:id/replay/:nodeId</span>
        <span class="desc">replay to a node</span>
      </div>
      <div class="endpoint">
        <span class="method post">POST</span>
        <span class="path">/trees/:id/branch</span>
        <span class="desc">branch from a point</span>
      </div>
      <div class="endpoint">
        <span class="method post">POST</span>
        <span class="path">/trees/:id/label</span>
        <span class="desc">add a bookmark</span>
      </div>
      <div class="endpoint">
        <span class="method ws">WS</span>
        <span class="path">/trees/:id/ws</span>
        <span class="desc">viewer websocket</span>
      </div>
      <div class="endpoint">
        <span class="method ws">WS</span>
        <span class="path">/trees/:id/ws/sandbox</span>
        <span class="desc">sandbox websocket</span>
      </div>
    </div>
    <footer>terminalshare.com</footer>
  </div>
</body>
</html>`;

// --- Viewer HTML ---

const VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>terminalshare</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; background: #0d1117; color: #e6edf3; font-family: system-ui, sans-serif; }
    #toolbar {
      display: flex; align-items: center; gap: 12px;
      padding: 8px 16px; background: #161b22; border-bottom: 1px solid #30363d;
      font-size: 13px; color: #8b949e;
    }
    #toolbar .name { color: #58a6ff; font-weight: 600; }
    #toolbar .status { display: flex; align-items: center; gap: 6px; }
    #toolbar .dot { width: 8px; height: 8px; border-radius: 50%; }
    #toolbar .dot.connected { background: #3fb950; }
    #toolbar .dot.disconnected { background: #f85149; }
    #terminal-container { height: calc(100% - 41px); width: 100%; }
    #loading {
      display: flex; align-items: center; justify-content: center;
      height: 100%; color: #8b949e; font-size: 15px;
    }
  </style>
</head>
<body>
  <div id="toolbar">
    <span class="name" id="tree-name">terminalshare</span>
    <span class="status">
      <span class="dot disconnected" id="status-dot"></span>
      <span id="status-text">connecting...</span>
    </span>
  </div>
  <div id="terminal-container">
    <div id="loading">loading terminal...</div>
  </div>
  <script type="module">
    const pathParts = window.location.pathname.split("/");
    const treeIdx = pathParts.indexOf("trees");
    const treeId = treeIdx >= 0 ? pathParts[treeIdx + 1] : null;
    if (!treeId) {
      document.getElementById("loading").textContent = "no tree ID in URL";
      throw new Error("no tree ID");
    }

    const info = await fetch("/trees/" + treeId).then(r => r.json());
    document.getElementById("tree-name").textContent = info.name || treeId;
    document.title = (info.name || treeId) + " — terminalshare";

    const { init, Terminal, FitAddon } = await import("https://esm.sh/ghostty-web@latest");
    await init();

    const container = document.getElementById("terminal-container");
    container.innerHTML = "";

    const term = new Terminal({
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Monaco, monospace",
      scrollback: 10000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.observeResize();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = protocol + "//" + window.location.host + "/trees/" + treeId + "/ws";
    let ws, reconnectTimer;

    function setStatus(connected) {
      document.getElementById("status-dot").className = "dot " + (connected ? "connected" : "disconnected");
      document.getElementById("status-text").textContent = connected ? "live" : "disconnected";
    }

    function connect() {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        setStatus(true);
        clearTimeout(reconnectTimer);
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      };
      ws.onmessage = (event) => {
        if (typeof event.data === "string" && event.data.startsWith("{")) {
          try { if (JSON.parse(event.data).control === "header") return; } catch {}
        }
        term.write(event.data);
      };
      ws.onclose = () => { setStatus(false); reconnectTimer = setTimeout(connect, 3000); };
      ws.onerror = () => { ws.close(); };
    }

    term.onData((data) => { if (ws?.readyState === WebSocket.OPEN) ws.send(data); });
    term.onResize(({ cols, rows }) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });
    connect();
  </script>
</body>
</html>`;

export default app;
