/**
 * Bearer-token gate for the write side of a tree.
 *
 * One shared secret (`SANDBOX_TOKEN`) authorises the two operations that can
 * change a session: creating a tree and attaching a sandbox PTY. The same
 * secret upgrades a viewer socket from read-only to read-write.
 *
 * Reads (`GET /trees/:id`, `/tree`, `/node`, `/replay`, `/view`) stay gated by
 * the tree UUID alone — that is the sharing product.
 */

/** Subprotocol carrier: `ts-token.<base64url of the raw token>`. */
export const SUBPROTOCOL_PREFIX = "ts-token.";

export type AuthOutcome = "ok" | "unauthorized" | "unconfigured";

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

/**
 * Compare two secrets without leaking their contents or lengths through
 * timing. Digesting first gives `timingSafeEqual` the equal-length buffers it
 * requires.
 */
export async function secretsMatch(
  presented: string,
  expected: string
): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function authorize(
  expected: string | undefined,
  presented: string | null
): Promise<AuthOutcome> {
  if (!expected) return "unconfigured";
  if (!presented) return "unauthorized";
  return (await secretsMatch(presented, expected)) ? "ok" : "unauthorized";
}

/** `Authorization: Bearer <token>`, the carrier for HTTP and for Node clients. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function decodeBase64Url(value: string): string | null {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  } catch {
    return null;
  }
}

/** The `ts-token.` value a browser offered, verbatim, for echoing in the 101. */
export function tokenSubprotocol(request: Request): string | null {
  const offered = request.headers.get("sec-websocket-protocol");
  if (!offered) return null;
  for (const raw of offered.split(",")) {
    const value = raw.trim();
    if (value.startsWith(SUBPROTOCOL_PREFIX)) return value;
  }
  return null;
}

/**
 * Token a WebSocket client presented, in preference order:
 *
 * 1. `Authorization: Bearer` — Node clients; never logged by an intermediary.
 * 2. `Sec-WebSocket-Protocol: ts-token.<base64url>` — browsers, which cannot
 *    set request headers on a WebSocket.
 * 3. `?token=` — last resort. It lands in request logs; see README.
 */
export function socketToken(request: Request): string | null {
  const bearer = bearerToken(request);
  if (bearer) return bearer;

  const subprotocol = tokenSubprotocol(request);
  if (subprotocol) {
    const decoded = decodeBase64Url(subprotocol.slice(SUBPROTOCOL_PREFIX.length));
    if (decoded) return decoded;
  }

  return new URL(request.url).searchParams.get("token");
}
