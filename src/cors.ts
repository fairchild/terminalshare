/**
 * Which foreign origins may read this API from a browser.
 *
 * What the allowlist is and is not worth here: nothing in terminalshare is
 * authorised by ambient browser state. There is no cookie and no session; the
 * write side wants an `Authorization: Bearer` header the caller must attach
 * deliberately, and the read side is gated by the unguessable tree UUID in the
 * path. A wildcard therefore hands a hostile page nothing it could not fetch
 * from its own server, because the victim's browser carries no authority the
 * attacker lacks. That is why this was rated low.
 *
 * What it does buy: the wildcard stops being a loaded footgun. The day someone
 * adds a cookie session, `*` would silently become an open door, and the
 * change that introduced the cookie would look unrelated to CORS. Pinning the
 * origins now means that change fails closed instead.
 *
 * Shape mirrors `chat/src/worker.ts` in the services monorepo so the two read
 * the same way under review. One deliberate divergence: `credentials` stays
 * false. Chat sets it because it has cookies to send; terminalshare does not,
 * and advertising credential support it has no use for would be claiming a
 * capability that does not exist.
 */

const PRODUCTION_ORIGINS = [
  "https://terminalshare.com",
  // Both hostnames are routed, so the apex and www are a genuine cross-origin
  // pair — a viewer page on www calling the apex API needs this entry.
  "https://www.terminalshare.com",
];

/** `wrangler dev` binds 8789; 8787 is wrangler's default if the port moves. */
const LOCAL_DEV_ORIGINS = [8789, 8787].flatMap((port) => [
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
]);

/** A local run may point its browser at a deployed tree, so it carries both. */
const DEVELOPMENT_ORIGINS = [...PRODUCTION_ORIGINS, ...LOCAL_DEV_ORIGINS];

/**
 * `preview` is deliberately empty: that Worker has never been deployed and has
 * no hostname to name. Same-origin requests never consult CORS, so an empty
 * set breaks nothing — when preview gets a hostname, set `ALLOWED_ORIGINS`
 * rather than guessing one here.
 */
const ORIGINS_BY_ENVIRONMENT = new Map<string, readonly string[]>([
  ["production", PRODUCTION_ORIGINS],
  ["preview", []],
  ["development", DEVELOPMENT_ORIGINS],
  ["test", DEVELOPMENT_ORIGINS],
]);

const NO_ORIGINS: ReadonlySet<string> = new Set();

/**
 * The `ALLOWED_ORIGINS` var, when set, replaces the built-in set for that
 * environment. An unrecognised environment gets nothing, so a typo in
 * `ENVIRONMENT` fails closed.
 */
export function allowedOrigins(
  environment: string | undefined,
  configured: string | undefined
): ReadonlySet<string> {
  const explicit = configured
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (explicit?.length) return new Set(explicit);

  const builtin = ORIGINS_BY_ENVIRONMENT.get(environment ?? "");
  return builtin ? new Set(builtin) : NO_ORIGINS;
}
