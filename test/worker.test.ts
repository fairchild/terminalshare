/**
 * Exercises the write gate against a real workerd instance (wrangler's
 * `unstable_dev`), so the Durable Object and its WebSocket hibernation path are
 * the ones under test rather than a stand-in.
 *
 *   node --test test/*.test.ts
 *
 * Note: run these under node, not bun — bun's HTTP client hangs against the
 * local workerd proxy `unstable_dev` puts in front of the Worker.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { unstable_dev } from "wrangler";
import WebSocket from "ws";

const TOKEN = "s3cr3t-sandbox-token-for-tests";
const WRONG = "s3cr3t-sandbox-token-for-testt";

type Dev = Awaited<ReturnType<typeof unstable_dev>>;

let worker: Dev;
let origin: string;

async function startDev(vars: Record<string, string>): Promise<Dev> {
  return unstable_dev("src/index.ts", {
    vars,
    experimental: { disableExperimentalWarning: true },
  });
}

async function createTree(): Promise<string> {
  const res = await worker.fetch("/trees", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ sandboxUrl: "local", name: "test" }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { treeId: string };
  return body.treeId;
}

interface Socket {
  ws: WebSocket;
  messages: string[];
  control: Record<string, unknown>[];
  close(): void;
}

/** Open a socket and resolve once it is established, or reject with its status. */
function open(path: string, options: WebSocket.ClientOptions & { protocol?: string } = {}): Promise<Socket> {
  const { protocol, ...clientOptions } = options;
  const ws = protocol
    ? new WebSocket(`${origin}${path}`, [protocol], clientOptions)
    : new WebSocket(`${origin}${path}`, clientOptions);

  const messages: string[] = [];
  const control: Record<string, unknown>[] = [];

  ws.on("message", (data) => {
    const raw = data.toString();
    if (raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.control === "string") {
          control.push(parsed);
          return;
        }
      } catch {
        // fall through: raw terminal data that happens to start with {
      }
    }
    messages.push(raw);
  });

  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve({ ws, messages, control, close: () => ws.close() }));
    ws.on("unexpected-response", (_req, res) => reject(new HandshakeError(res.statusCode ?? 0)));
    ws.on("error", (err) => reject(err));
  });
}

class HandshakeError extends Error {
  status: number;
  constructor(status: number) {
    super(`handshake rejected with ${status}`);
    this.status = status;
  }
}

async function handshakeStatus(path: string, options: WebSocket.ClientOptions & { protocol?: string } = {}): Promise<number> {
  try {
    const socket = await open(path, options);
    socket.close();
    return 101;
  } catch (err) {
    if (err instanceof HandshakeError) return err.status;
    throw err;
  }
}

/** base64url of a raw token — the `ts-token.` subprotocol carrier. */
function carrier(token: string): string {
  return `ts-token.${Buffer.from(token).toString("base64url")}`;
}

function settle(ms = 250): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flatten(nodes: { entry: Record<string, unknown>; children: unknown[] }[]): Record<string, unknown>[] {
  return nodes.flatMap((node) => [
    node.entry,
    ...flatten(node.children as { entry: Record<string, unknown>; children: unknown[] }[]),
  ]);
}

before(async () => {
  worker = await startDev({ SANDBOX_TOKEN: TOKEN, ENVIRONMENT: "test" });
  origin = `ws://127.0.0.1:${worker.port}`;
});

after(async () => {
  await worker.stop();
});

describe("POST /trees", () => {
  test("401 without a bearer", async () => {
    const res = await worker.fetch("/trees", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sandboxUrl: "local" }),
    });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer/);
  });

  test("401 with a wrong bearer of the same length", async () => {
    const res = await worker.fetch("/trees", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${WRONG}` },
      body: JSON.stringify({ sandboxUrl: "local" }),
    });
    assert.equal(res.status, 401);
  });

  test("401 when the bearer is passed as a query parameter instead", async () => {
    const res = await worker.fetch(`/trees?token=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sandboxUrl: "local" }),
    });
    assert.equal(res.status, 401);
  });

  test("201 with the bearer", async () => {
    const treeId = await createTree();
    assert.match(treeId, /^[0-9a-f-]{36}$/);
  });
});

describe("reads stay link-gated by the tree id", () => {
  test("GET / serves the landing page", async () => {
    const res = await worker.fetch("/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /terminalshare/);
  });

  test("GET /trees/:id needs no token", async () => {
    const treeId = await createTree();
    const res = await worker.fetch(`/trees/${treeId}`);
    assert.equal(res.status, 200);
    const info = (await res.json()) as { name: string; sandboxConnected: boolean };
    assert.equal(info.name, "test");
    assert.equal(info.sandboxConnected, false);
  });
});

describe("sandbox WebSocket", () => {
  test("401 without a token", async () => {
    const treeId = await createTree();
    assert.equal(await handshakeStatus(`/trees/${treeId}/ws/sandbox`), 401);
  });

  test("401 with a wrong token", async () => {
    const treeId = await createTree();
    const status = await handshakeStatus(`/trees/${treeId}/ws/sandbox`, {
      headers: { authorization: `Bearer ${WRONG}` },
    });
    assert.equal(status, 401);
  });

  test("attaches with the bearer, and a second attach gets 409", async () => {
    const treeId = await createTree();
    const first = await open(`/trees/${treeId}/ws/sandbox`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    const second = await handshakeStatus(`/trees/${treeId}/ws/sandbox`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(second, 409);

    const info = (await (await worker.fetch(`/trees/${treeId}`)).json()) as {
      sandboxConnected: boolean;
    };
    assert.equal(info.sandboxConnected, true);

    first.close();
  });

  test("a dropped sandbox releases the slot, so a crash cannot lock the tree", async () => {
    const treeId = await createTree();
    const first = await open(`/trees/${treeId}/ws/sandbox`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    first.ws.terminate(); // abrupt, the way a crashed connector goes away

    // Poll rather than sleep: the point is that release is prompt, not that it
    // happens eventually.
    const deadline = Date.now() + 5_000;
    let released = false;
    while (Date.now() < deadline) {
      const info = (await (await worker.fetch(`/trees/${treeId}`)).json()) as {
        sandboxConnected: boolean;
      };
      if (!info.sandboxConnected) {
        released = true;
        break;
      }
      await settle(25);
    }
    assert.ok(released, "sandbox slot was still held 5s after the socket dropped");

    const second = await open(`/trees/${treeId}/ws/sandbox`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    second.close();
  });
});

describe("viewers are read-only by default", () => {
  test("an anonymous viewer connects but its input never reaches the PTY", async () => {
    const treeId = await createTree();
    const sandbox = await open(`/trees/${treeId}/ws/sandbox`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    const lurker = await open(`/trees/${treeId}/ws`);
    await settle();
    assert.deepEqual(
      lurker.control.find((m) => m.control === "access"),
      { control: "access", write: false }
    );

    lurker.ws.send("nope");
    lurker.ws.send(JSON.stringify({ type: "resize", cols: 999, rows: 999 }));
    await settle();

    const writer = await open(`/trees/${treeId}/ws`, { protocol: carrier(TOKEN) });
    await settle();
    assert.deepEqual(
      writer.control.find((m) => m.control === "access"),
      { control: "access", write: true }
    );

    const writerResize = JSON.stringify({ type: "resize", cols: 120, rows: 40 });
    writer.ws.send(writerResize);
    writer.ws.send("yes");
    await settle();

    // Only the writer's traffic crossed to the sandbox.
    assert.deepEqual(sandbox.messages, [writerResize, "yes"]);

    // And only the writer's keystrokes were recorded in the tree.
    const tree = (await (await worker.fetch(`/trees/${treeId}/tree`)).json()) as never;
    const entries = flatten(tree);
    const inbound = entries.filter((e) => e.type === "data" && e.direction === "in");
    assert.deepEqual(
      inbound.map((e) => Buffer.from(e.data as string, "base64").toString()),
      ["yes"]
    );
    const resizes = entries.filter((e) => e.type === "resize");
    assert.deepEqual(
      resizes.map((e) => [e.cols, e.rows]),
      [[120, 40]],
      "the read-only viewer's resize never reached the tree"
    );

    // The read-only viewer still receives sandbox output.
    sandbox.ws.send("hello from the pty");
    await settle();
    assert.ok(lurker.messages.includes("hello from the pty"));

    lurker.close();
    writer.close();
    sandbox.close();
  });

  test("a wrong token in the subprotocol still connects, read-only", async () => {
    const treeId = await createTree();
    const viewer = await open(`/trees/${treeId}/ws`, { protocol: carrier(WRONG) });
    await settle();
    assert.deepEqual(
      viewer.control.find((m) => m.control === "access"),
      { control: "access", write: false }
    );
    viewer.close();
  });

  test("?token= also grants write, at the cost of landing in logs", async () => {
    const treeId = await createTree();
    const viewer = await open(`/trees/${treeId}/ws?token=${encodeURIComponent(TOKEN)}`);
    await settle();
    assert.deepEqual(
      viewer.control.find((m) => m.control === "access"),
      { control: "access", write: true }
    );

    const info = (await (await worker.fetch(`/trees/${treeId}`)).json()) as {
      viewers: { write: boolean }[];
    };
    assert.deepEqual(info.viewers.map((v) => v.write), [true]);

    viewer.close();
  });
});

describe("an unset SANDBOX_TOKEN fails closed", () => {
  test("503 rather than an open door", async () => {
    const bare = await startDev({ ENVIRONMENT: "test" });
    try {
      const res = await bare.fetch("/trees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sandboxUrl: "local" }),
      });
      assert.equal(res.status, 503);

      const withToken = await bare.fetch("/trees", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ sandboxUrl: "local" }),
      });
      assert.equal(withToken.status, 503);
    } finally {
      await bare.stop();
    }
  });
});
