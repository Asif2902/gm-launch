import { buildSignInMessage } from "./authMessage";
import { API_BASE } from "./config";

/**
 * Wallet sessions: one signature per login instead of one per write.
 *
 * Every off-chain write used to open its own wallet prompt — upload an image, sign; save a
 * description, sign; fix a typo, sign again. Beyond being tedious, that pattern is actively bad
 * for users: it teaches people to approve signature requests without reading them, which is
 * precisely the habit wallet-drainer sites rely on. Signing once, over a message that states
 * plainly what the session can do and when it ends, is both less friction and a better habit.
 *
 * The token is stored in `localStorage` rather than a cookie because the API is a separate
 * origin in production and the client attaches it explicitly as a bearer header — no ambient
 * credentials, so nothing rides along on a cross-site request.
 *
 * The stored token authorises metadata edits only. It cannot trade, transfer or approve
 * anything: those are on-chain actions and still need a transaction signed in the wallet.
 */

const STORAGE_KEY = "pumper.session.v1";

/**
 * Treat a session as finished slightly before it truly is, so a request started just under the
 * wire doesn't land as a 401 after the round trip.
 */
const EXPIRY_MARGIN_MS = 30_000;

export interface WalletSession {
  token: string;
  address: string;
  /** When this token lapses, absent further use. Slides forward as the session is used. */
  expiresAt: number;
  /** The deadline no renewal can pass — after this, a new signature is required. */
  absoluteExpiresAt: number;
}

function isLive(session: WalletSession | null, now = Date.now()): session is WalletSession {
  return Boolean(session && session.expiresAt - EXPIRY_MARGIN_MS > now);
}

/**
 * The stored session, or null if there is none, it expired, or it belongs to another wallet.
 *
 * Matching is by `address` normally. `forToken` is the exception: request helpers hold a token
 * but not the wallet it came from, and they need the stored record to rotate it.
 */
export function loadSession(
  address: string | undefined,
  forToken?: string,
): WalletSession | null {
  if (typeof localStorage === "undefined") return null;
  if (!address && !forToken) return null;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<WalletSession>;
    const session: WalletSession = {
      token: String(parsed.token ?? ""),
      address: String(parsed.address ?? "").toLowerCase(),
      expiresAt: Number(parsed.expiresAt ?? 0),
      // Sessions stored before renewals existed carry no hard cap; treating their expiry as the
      // cap is correct for them — they simply cannot be renewed and will end on schedule.
      absoluteExpiresAt: Number(parsed.absoluteExpiresAt ?? parsed.expiresAt ?? 0),
    };

    if (!session.token) return null;
    if (forToken && session.token !== forToken) return null;
    // A session belongs to the wallet that signed it. Switching accounts must not inherit one.
    if (address && session.address !== address.toLowerCase()) return null;
    if (!isLive(session)) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

export function storeSession(session: WalletSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Private-browsing quota or a blocked store: the session still works for this page view.
  }
}

export function clearStoredSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

interface SignInParams {
  domain: string;
  address: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  idleMs: number;
  absoluteMs: number;
}

/**
 * Runs the whole sign-in: fetch the server's parameters, have the wallet sign the message built
 * from them, and exchange the signature for a token.
 *
 * The domain, nonce and session length all come from the server. A client that chose its own
 * would be deciding the policy it is meant to be subject to — and the domain in particular is
 * the one thing the user relies on to know what they are signing into.
 */
export async function openSession(
  address: string,
  sign: (message: string) => Promise<string>,
): Promise<WalletSession> {
  const paramsResponse = await fetch(
    `${API_BASE}/auth/params?address=${encodeURIComponent(address)}`,
  );
  if (!paramsResponse.ok) {
    throw new Error("Sign-in is unavailable right now");
  }

  const params = (await paramsResponse.json()) as SignInParams;
  const signature = await sign(
    buildSignInMessage({
      domain: params.domain,
      address,
      nonce: params.nonce,
      issuedAt: params.issuedAt,
      expiresAt: params.expiresAt,
      idleMs: params.idleMs,
    }),
  );

  const response = await fetch(`${API_BASE}/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address,
      nonce: params.nonce,
      issuedAt: params.issuedAt,
      expiresAt: params.expiresAt,
      signature,
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error ?? "Could not open a session");

  const session = toSession(body, address);
  storeSession(session);
  return session;
}

/** The server is the authority on a token's lifetime; the client only records what it is told. */
function toSession(body: Record<string, unknown>, fallbackAddress: string): WalletSession {
  return {
    token: String(body.token),
    address: String(body.address ?? fallbackAddress).toLowerCase(),
    expiresAt: Number(body.expiresAt),
    absoluteExpiresAt: Number(body.absoluteExpiresAt ?? body.expiresAt),
  };
}

/**
 * Slides a live session forward without a signature.
 *
 * Reads on this API are unauthenticated, so nothing else would renew a session while someone is
 * simply browsing — and being asked to sign the moment you finally click "edit" is precisely the
 * interruption sessions exist to remove. Returns null when the session is genuinely finished, so
 * the caller stops rather than retrying forever.
 */
export async function refreshSession(session: WalletSession): Promise<WalletSession | null> {
  const response = await fetch(`${API_BASE}/auth/refresh`, {
    method: "POST",
    headers: authHeaders(session.token),
  });

  if (!response.ok) return null;

  const body = await response.json().catch(() => ({}));
  if (!body?.token) return null;

  const renewed = toSession(body, session.address);
  storeSession(renewed);
  notifyRotation(renewed);
  return renewed;
}

// ---- token rotation ---------------------------------------------------------------------------

type RotationListener = (session: WalletSession) => void;
const rotationListeners = new Set<RotationListener>();

/** Notifies the provider when a token is replaced, so React state follows storage. */
export function onSessionRotated(listener: RotationListener): () => void {
  rotationListeners.add(listener);
  return () => rotationListeners.delete(listener);
}

function notifyRotation(session: WalletSession): void {
  for (const listener of rotationListeners) listener(session);
}

/**
 * Adopts a token the server rotated onto a response.
 *
 * Every authenticated call is itself proof the session is in use, so the server slides it forward
 * and returns the fresh token in a header. Picking it up here means an active user's session is
 * renewed by the work they were already doing, with no extra request and no prompt.
 */
export function adoptRotatedToken(response: Response, current: WalletSession | null): void {
  const token = response.headers.get("X-Session-Token");
  const expiresAt = Number(response.headers.get("X-Session-Expires"));
  if (!token || !Number.isFinite(expiresAt) || !current) return;

  const rotated: WalletSession = { ...current, token, expiresAt };
  storeSession(rotated);
  notifyRotation(rotated);
}

/** Bearer header for an authenticated write, or nothing when there is no session. */
export function authHeaders(token: string | null | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Whether a failed request failed *because* the session did.
 *
 * The provider clears the session on a true auth failure so the next write prompts for a fresh
 * signature, but a 403 ("this isn't your token to edit") must not: re-signing cannot fix it, and
 * throwing a wallet popup at someone who lacks permission is just noise.
 */
export class SessionExpiredError extends Error {
  constructor(message = "Your session expired — sign in again to continue") {
    super(message);
    this.name = "SessionExpiredError";
  }
}
