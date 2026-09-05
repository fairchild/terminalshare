/**
 * How long a shared tree lives.
 *
 * A share is a capability handed out as a URL, and a URL leaks — into
 * scrollback, chat logs, browser history. A tree that expires bounds how long
 * a leaked link stays useful, which is the only thing standing between an old
 * link and the terminal it replays.
 *
 * Expiry is stored as an absolute `expiresAt` on the tree header rather than a
 * duration, so it survives eviction and does not restart when the Durable
 * Object wakes.
 */

export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/** Short enough for a test to wait it out; long enough to be a real share. */
export const MIN_TTL_SECONDS = 1;

/** A month. Past this, "share" is really "host", which this service is not. */
export const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Validate a caller-supplied TTL. Returns null when the request is malformed,
 * which the route turns into a 400 — silently clamping would hand the caller a
 * lifetime it never asked for.
 */
export function resolveTtlSeconds(requested: unknown): number | null {
  if (requested === undefined || requested === null) return DEFAULT_TTL_SECONDS;
  if (typeof requested !== "number" || !Number.isInteger(requested)) return null;
  if (requested < MIN_TTL_SECONDS || requested > MAX_TTL_SECONDS) return null;
  return requested;
}

export function expiryFrom(now: Date, ttlSeconds: number): string {
  return new Date(now.getTime() + ttlSeconds * 1000).toISOString();
}

/**
 * Whether a tree has outlived its share window.
 *
 * A header with no `expiresAt` predates TTL and never expires — trees created
 * before this shipped keep the lifetime they were promised, so no existing
 * share is withdrawn by deploying it.
 */
export function isExpired(expiresAt: string | undefined, now: number): boolean {
  if (!expiresAt) return false;
  const deadline = Date.parse(expiresAt);
  return Number.isFinite(deadline) && now >= deadline;
}
