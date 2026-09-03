/**
 * Sandbox connector: spawns a local PTY and bridges it to a terminalshare tree.
 *
 * Usage:
 *   node --experimental-strip-types connect.ts [base-url]
 *
 * Creates a tree, spawns a shell, connects the PTY as the sandbox WebSocket.
 * Prints the viewer URL so you can open it in a browser.
 */

import * as pty from "@lydell/node-pty";
import WebSocket from "ws";

const BASE_URL = process.argv[2] || "http://localhost:8788";
const SHELL = process.env.SHELL || "bash";
const COLS = parseInt(process.env.COLS || "120");
const ROWS = parseInt(process.env.ROWS || "30");

async function main() {
  // 1. Create a tree
  const res = await fetch(`${BASE_URL}/trees`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sandboxUrl: "local",
      cols: COLS,
      rows: ROWS,
      name: `local-${Date.now()}`,
    }),
  });

  if (!res.ok) {
    console.error("Failed to create tree:", await res.text());
    process.exit(1);
  }

  const tree = (await res.json()) as { treeId: string };
  const treeId = tree.treeId;
  const wsBase = BASE_URL.replace(/^http/, "ws");

  console.log(`Tree created: ${treeId}`);
  console.log(`Viewer URL: ${BASE_URL}/trees/${treeId}/view`);
  console.log(`WebSocket:  ${wsBase}/trees/${treeId}/ws`);
  console.log();

  // 2. Spawn PTY
  const shell = pty.spawn(SHELL, [], {
    name: "xterm-256color",
    cols: COLS,
    rows: ROWS,
    cwd: process.env.HOME || "/",
    env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
  });

  console.log(`Shell spawned: ${SHELL} (pid ${shell.pid})`);

  // 3. Connect to terminalshare as sandbox
  const ws = new WebSocket(`${wsBase}/trees/${treeId}/ws/sandbox`);

  ws.on("open", () => {
    console.log("Connected to terminalshare as sandbox");
    console.log("---");
  });

  // PTY output → WebSocket (to terminalshare → viewers)
  shell.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  // WebSocket input → PTY (from viewers via terminalshare)
  ws.on("message", (data: WebSocket.Data) => {
    const msg = data.toString();
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === "resize") {
        shell.resize(parsed.cols, parsed.rows);
        return;
      }
    } catch {
      // Not JSON — raw terminal input
    }
    shell.write(msg);
  });

  // Cleanup
  shell.onExit(({ exitCode }) => {
    console.log(`\nShell exited (code ${exitCode})`);
    ws.close();
    process.exit(exitCode);
  });

  ws.on("close", () => {
    console.log("\nWebSocket closed");
    shell.kill();
    process.exit(0);
  });

  ws.on("error", (err: Error) => {
    console.error("WebSocket error:", err.message);
    shell.kill();
    process.exit(1);
  });
}

main();
