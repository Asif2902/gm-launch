import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Stateless session tokens for the off-chain API.
 *
 * The point of this file is to make the *wallet signature* a login rather than a per-request
 * toll. Previously every off-chain write — each upload, each description edit — opened a wallet
 * popup, which is both hostile to use and trains people to click through signature prompts
 * without reading them. Now one signature at connect time mints a short-lived bearer token and
 * every subsequent write rides on it.
 *
 * The token is an HMAC over a compact payload, not a database row: this API is deployed as a
 * stateless process (possibly serverless, possibly several instances), so a session table would
 * need coordination the rest of the service deliberately avoids. Verification is pure CPU and
 * works identically on every instance.
 *
 * What a token can do is bounded on purpose: it authenticates an address for metadata writes it
 * already owns. It cannot move funds, trade, or touch anything on-chain — those still require a
 * real transaction signed in the wallet.
 */

const ALGORITHM = "sha256";
const VERSION = "v1";

/**
 * Signing key. Set `AUTH_SECRET` in production.
 *
 * Without one the process generates a random key at boot, which is safe but ephemeral: every
 * restart invalidates every outstanding session, and two instances behind a load balancer will
 * reject each other's tokens. The client treats a 401 as "sign in again", so the failure mode is
 * an extra wallet prompt rather than a broken app — but it is worth setting.
 */
const secret = (() => {
  const configured = process.env.AUTH_SECRET?.trim();
  if (configured && configured.length >= 16) return Buffer.from(configured, "utf8");

  if (configured) {
    console.warn("[auth] AUTH_SECRET is shorter than 16 characters — ignoring it.");
  }
  console.warn(
    "[auth] No AUTH_SECRET set. Using an ephemeral key.\n" +
      "        Every restart mints a new key, which invalidates every outstanding session — the\n" +
      "        symptom is users being told their session expired while their own countdown still\n" +
      "        shows time left. In development `tsx watch` restarts on each edit, so this happens\n" +
      "        constantly. Set AUTH_SECRET to any random 32+ character string.",
  );
  return randomBytes(32);
})();

/**
 * Session lifetime, as two bounds rather than one.
 *
 * A single fixed TTL forces a choice between interrupting people who are actively using the site
 * and handing out a credential that stays valid long after they have walked away. Two bounds
 * avoid the trade:
 *
 *   - **Idle window** — the session dies this long after its last use. Activity slides it
 *     forward, so someone working continuously is never interrupted.
 *   - **Absolute lifetime** — the session can never be renewed past this, measured from the
 *     original signature. Re-proving key custody periodically is the point of signing in at all.
 *
 * This is strictly stronger than issuing one long-lived token up front: an abandoned or stolen
 * token still dies at the idle window, which a fixed long TTL would not do.
 */
export const SESSION_IDLE_MS = (() => {
  // SESSION_TTL_MINUTES is the previous name, still honoured so existing deployments keep working.
  const raw = process.env.SESSION_IDLE_HOURS
    ? Number(process.env.SESSION_IDLE_HOURS) * 60
    : Number(process.env.SESSION_TTL_MINUTES ?? 12 * 60);
  if (!Number.isFinite(raw) || raw <= 0) return 12 * 60 * 60_000;
  return Math.min(raw, 7 * 24 * 60) * 60_000;
})();

export const SESSION_ABSOLUTE_MS = (() => {
  const days = Number(process.env.SESSION_MAX_DAYS ?? 7);
  if (!Number.isFinite(days) || days <= 0) return 7 * 86_400_000;
  return Math.min(days, 90) * 86_400_000;
})();

/**
 * How much of the idle window must elapse before a request rotates the token.
 *
 * Rotating on every call would burn CPU and churn the client's storage for no benefit; waiting
 * until the last moment would make renewal race the expiry. Half-way is the usual compromise.
 */
const RENEW_AFTER = 0.5;

/**
 * How long a sign-in signature stays usable.
 *
 * Deliberately short. It is the window in which a captured signature could be exchanged for a
 * session, so it should be long enough for a slow hardware wallet and no longer.
 */
export const SIGN_IN_MAX_AGE_MS = 5 * 60_000;

/** Tolerance for a client clock running ahead of the server's. */
export const CLOCK_SKEW_MS = 2 * 60_000;

export interface Session {
  address: string;
  /** When the wallet actually signed in. Preserved across renewals — it anchors the hard cap. */
  signedInAt: number;
  /** When this token was minted. */
  issuedAt: number;
  /** When this token stops working, absent a renewal. */
  expiresAt: number;
  /** The deadline no renewal can pass: `signedInAt + SESSION_ABSOLUTE_MS`. */
  absoluteExpiresAt: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string): string {
  return createHmac(ALGORITHM, secret).update(payload).digest("base64url");
}

function encode(session: Session): Session & { token: string } {
  const payload = base64url(
    JSON.stringify({
      a: session.address,
      sat: session.signedInAt,
      iat: session.issuedAt,
      exp: session.expiresAt,
      abs: session.absoluteExpiresAt,
    }),
  );

  return { ...session, token: `${VERSION}.${payload}.${sign(payload)}` };
}

/**
 * Mints the first token of a session, at sign-in.
 *
 * `maxAbsoluteExpiresAt` lets the caller shorten — never extend — the hard cap to the deadline
 * the user was actually shown in their wallet. The signed message names that date, and a session
 * that outlived it would make the prompt a lie.
 */
export function issueSession(
  address: string,
  now = Date.now(),
  maxAbsoluteExpiresAt?: number,
): Session & { token: string } {
  const absolute = Math.min(
    now + SESSION_ABSOLUTE_MS,
    maxAbsoluteExpiresAt ?? Number.POSITIVE_INFINITY,
  );

  return encode({
    address: address.toLowerCase(),
    signedInAt: now,
    issuedAt: now,
    expiresAt: Math.min(now + SESSION_IDLE_MS, absolute),
    absoluteExpiresAt: absolute,
  });
}

/**
 * Extends a live session by another idle window, without another signature.
 *
 * The renewal is anchored to the original sign-in: `absoluteExpiresAt` never moves, so repeated
 * use cannot walk a session forward indefinitely. Renewing requires presenting a currently valid
 * token, so this grants nothing that token did not already grant — it only avoids interrupting
 * someone who is demonstrably still here.
 */
export function renewSession(session: Session, now = Date.now()): Session & { token: string } {
  return encode({
    ...session,
    issuedAt: now,
    expiresAt: Math.min(now + SESSION_IDLE_MS, session.absoluteExpiresAt),
  });
}

/**
 * Whether a token is far enough through its idle window to be worth rotating.
 *
 * Also false once the session is against its hard cap, so the last stretch before a required
 * re-signature is not spent minting tokens that cannot extend anything.
 */
export function shouldRenew(session: Session, now = Date.now()): boolean {
  if (session.expiresAt >= session.absoluteExpiresAt) return false;
  return now - session.issuedAt > SESSION_IDLE_MS * RENEW_AFTER;
}

/**
 * Parses and verifies a token, returning the session it carries.
 * Returns null for anything malformed, tampered with, or expired — the caller decides the status
 * code, and every failure looks the same from outside.
 */
export function readSession(token: string | undefined | null, now = Date.now()): Session | null {
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;

  const [, payload, signature] = parts;

  // Constant-time compare: a byte-by-byte early exit would leak the expected MAC over enough
  // attempts. `timingSafeEqual` throws on a length mismatch, hence the guard.
  const expected = Buffer.from(sign(payload));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;

  let decoded: { a?: unknown; sat?: unknown; iat?: unknown; exp?: unknown; abs?: unknown };
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const address = typeof decoded.a === "string" ? decoded.a.toLowerCase() : null;
  const issuedAt = Number(decoded.iat);
  const expiresAt = Number(decoded.exp);
  // Tokens minted before renewals existed carry no `sat`; treat their mint time as the sign-in,
  // so they age out on the same schedule rather than being rejected outright.
  const signedInAt = decoded.sat === undefined ? issuedAt : Number(decoded.sat);

  if (!address || !/^0x[0-9a-f]{40}$/.test(address)) return null;
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return null;
  if (!Number.isFinite(signedInAt)) return null;

  /**
   * The hard cap travels in the token, clamped on the way out.
   *
   * It has to be carried rather than recomputed, because sign-in may have *shortened* it to the
   * deadline the wallet actually displayed — recomputing would silently discard that and let the
   * cap drift forward a little on every renewal. It is equally not simply trusted: policy is
   * re-applied as a ceiling, so a token can claim a shorter life than configuration allows but
   * never a longer one, and lowering SESSION_MAX_DAYS immediately shortens sessions already out
   * in the world.
   */
  const claimed = decoded.abs === undefined ? Number.POSITIVE_INFINITY : Number(decoded.abs);
  if (!Number.isFinite(claimed) && decoded.abs !== undefined) return null;
  const absoluteExpiresAt = Math.min(claimed, signedInAt + SESSION_ABSOLUTE_MS);
  if (absoluteExpiresAt <= now) return null;
  if (expiresAt <= now) return null;

  return { address, signedInAt, issuedAt, expiresAt, absoluteExpiresAt };
}

/** Extracts a bearer token from an Authorization header. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
