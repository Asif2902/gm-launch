import type { Request, Response } from "express";
import { createPublicClient, http, isAddress, parseAbi, type Hex } from "viem";

import {
  AUTH_MAX_AGE_MS,
  buildAuthMessage,
  buildSignInMessage,
  type AuthAction,
} from "./authMessage";
import { FACTORY_ADDRESS, RPC_URL } from "./config";
import {
  CLOCK_SKEW_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SIGN_IN_MAX_AGE_MS,
  bearerToken,
  issueSession,
  readSession,
  renewSession,
  shouldRenew,
  type Session,
} from "./session";

/**
 * Wallet-signature authorisation for off-chain writes.
 *
 * Without this, anyone could POST a description and image for a token they had nothing to do
 * with, or overwrite another user's profile. A signature proves control of the address; the
 * caller then still has to satisfy an ownership check (profile == signer, token creator ==
 * signer) before anything is written.
 *
 * There are two ways to present that proof, and {@link requireAuth} accepts either:
 *
 *   1. **A session** — one sign-in signature mints a bearer token good for an hour. This is what
 *      the app does now, and it is why editing a description no longer opens a wallet popup.
 *   2. **A per-write signature** in the request body — the original scheme, kept so a tab still
 *      running the previous bundle keeps working through a deploy.
 *
 * Verification goes through a public client rather than a bare `verifyMessage` so that
 * ERC-1271 contract wallets (Safe, smart accounts) work as well as EOAs — a meaningful share of
 * Base users are on smart accounts.
 *
 * No `chain` is declared: importing `viem/chains` pulls in several hundred chain definitions for
 * an `eth_call` against a single known RPC. Both operations here work fine without it.
 */
const publicClient = createPublicClient({ transport: http(RPC_URL) });

/** Only the launchpad view this server needs — the authority on who created a token. */
const FACTORY_ABI = parseAbi([
  "function getToken(address token) view returns ((address token, address creator, uint8 status, string name, string symbol, uint256 totalSupply, uint256 circulatingSupply, uint256 ethReserve, uint256 virtualEthReserve, uint256 tokenReserve, uint256 virtualTokenReserve, uint256 tokenPrice, uint256 marketCap, uint256 fullyDilutedValuation, uint256 tokensAvailable, uint256 migrationProgressBps, uint256 cumulativeEthIn, uint256 cumulativeEthOut, uint256 cumulativeTokensBought, uint256 cumulativeTokensSold, uint256 createdAt, uint256 migratedAt, address pair))",
]);

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface SignedRequest {
  action: AuthAction;
  address: string;
  issuedAt: number;
  signature: string;
  /** Optional binding, e.g. the token address an `update-token` signature applies to. */
  subject?: string;
}

/**
 * Verifies a signed request and returns the authenticated address, lowercased.
 * Throws {@link AuthError} on any failure.
 */
export async function verifySignedRequest(request: SignedRequest): Promise<string> {
  const { action, address, issuedAt, signature, subject } = request;

  if (!address || !isAddress(address)) throw new AuthError("Invalid address");
  if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) throw new AuthError("Invalid signature");
  if (!Number.isFinite(issuedAt)) throw new AuthError("Invalid timestamp");

  const age = Date.now() - issuedAt;
  // Reject the future too: a far-future timestamp would otherwise extend the replay window.
  if (age > AUTH_MAX_AGE_MS || age < -60_000) {
    throw new AuthError("Signature expired — please sign again");
  }

  const message = buildAuthMessage(action, address, issuedAt, subject);

  let valid = false;
  try {
    valid = await publicClient.verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as Hex,
    });
  } catch {
    throw new AuthError("Could not verify signature");
  }

  if (!valid) throw new AuthError("Signature does not match address");
  return address.toLowerCase();
}

/**
 * Exchanges a sign-in signature for a session token.
 *
 * The client picks the nonce and the timestamps; the server checks they are sane, verifies the
 * signature over the exact message the wallet displayed, and issues a token that can never
 * outlive the expiry shown in that prompt.
 *
 * There is no server-side nonce ledger, which is the one deliberate simplification here: a
 * signature captured in transit could be exchanged for a session by whoever captured it, within
 * the five-minute window. That is the same exposure the per-write scheme already carried, TLS is
 * the control that prevents it, and the alternative — shared nonce storage — would put a
 * coordination dependency into a service whose whole design is stateless. Revisit if sessions
 * ever gain authority over anything beyond a description and a picture.
 */
export async function createSession(input: {
  domain: string;
  address: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}): Promise<Session & { token: string }> {
  // The idle window is rebuilt from this server's own configuration, never from the request —
  // otherwise a client could display one timeout to the user and have another enforced.
  const { domain, address, nonce, issuedAt, expiresAt, signature } = input;

  if (!address || !isAddress(address)) throw new AuthError("Invalid address");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce ?? "")) throw new AuthError("Invalid nonce");
  if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) throw new AuthError("Invalid signature");
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    throw new AuthError("Invalid session window");
  }

  const now = Date.now();
  const age = now - issuedAt;
  if (age > SIGN_IN_MAX_AGE_MS || age < -CLOCK_SKEW_MS) {
    throw new AuthError("Sign-in request expired — please sign again");
  }
  if (expiresAt <= now) throw new AuthError("Session window has already elapsed");
  if (expiresAt - issuedAt > SESSION_ABSOLUTE_MS + CLOCK_SKEW_MS) {
    throw new AuthError("Requested session is longer than this server allows");
  }

  const message = buildSignInMessage({
    domain,
    address,
    nonce,
    issuedAt,
    expiresAt,
    idleMs: SESSION_IDLE_MS,
  });

  let valid = false;
  try {
    valid = await publicClient.verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as Hex,
    });
  } catch {
    throw new AuthError("Could not verify signature");
  }

  if (!valid) throw new AuthError("Signature does not match address");
  return issueSession(address, now, expiresAt);
}

/**
 * The authenticated address for a write request, from a session token if one is present and from
 * a body signature otherwise.
 *
 * Returning a bare address rather than a session object keeps every call site identical to what
 * it was: the route still compares the result against the resource's owner, because proving
 * control of *an* address has never been the same as being allowed to edit *this* row.
 */
export async function requireAuth(
  req: Request,
  legacy: { action: AuthAction; subject?: string },
  res?: Response,
): Promise<string> {
  const token = bearerToken(req.headers.authorization);
  if (token) {
    const session = readSession(token);
    if (!session) throw new AuthError("Session expired — please sign in again");
    // Using the session is what keeps it alive, so the rotation rides on the request that was
    // already happening rather than needing a separate call.
    if (res) attachRenewal(res, session);
    return session.address;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  return verifySignedRequest({
    action: legacy.action,
    address: String(body.address ?? ""),
    issuedAt: Number(body.issuedAt ?? 0),
    signature: String(body.signature ?? ""),
    subject: legacy.subject,
  });
}

/**
 * Slides a session forward on the response, when it is far enough through its idle window.
 *
 * The rotated token travels in a header rather than the body so every route gets it for free and
 * no response shape changes. `Access-Control-Expose-Headers` has to list these or a browser on a
 * different origin cannot read them — see the CORS setup in `index.ts`.
 */
export function attachRenewal(res: Response, session: Session, now = Date.now()): void {
  if (!shouldRenew(session, now)) return;

  const renewed = renewSession(session, now);
  res.setHeader("X-Session-Token", renewed.token);
  res.setHeader("X-Session-Expires", String(renewed.expiresAt));
}

/** Reads a token's creator straight from the launchpad — the authority on who may edit it. */
export async function getTokenCreator(token: string): Promise<string | null> {
  try {
    const view = (await publicClient.readContract({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI,
      functionName: "getToken",
      args: [token as `0x${string}`],
    })) as { creator: string };
    return view.creator.toLowerCase();
  } catch {
    return null;
  }
}
