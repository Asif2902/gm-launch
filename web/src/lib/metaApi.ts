import { API_BASE, DEMO_MODE } from "./config";
import { findMockProfileByUsername, getMockProfile, getMockTokenMeta } from "./mockMeta";
import { SessionExpiredError, adoptRotatedToken, authHeaders, loadSession } from "./session";

/**
 * Client for the off-chain metadata layer (the Express API in ../server → Turso + R2).
 *
 * Kept separate from `api.ts`, which talks to the indexer, because the two have different
 * failure semantics. The indexer being down means "fall back to simulated market data". Storage
 * being unconfigured means "there is nowhere to read descriptions from" — and on a *live*
 * deployment with no descriptions written yet, the right answer is to show nothing, not to
 * invent one. So the demo fixtures are never chosen because a request failed — see
 * {@link useRealTokenMetadata} and {@link useRealProfiles}, which deliberately differ.
 */

export interface TokenMeta {
  address: string;
  description: string | null;
  imageUrl: string | null;
  bannerUrl: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  discord: string | null;
}

export interface UserProfile {
  address: string;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  discord: string | null;
  github: string | null;
}

export interface UploadResult {
  key: string | null;
  thumbKey: string | null;
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  originalBytes: number;
  storedBytes: number;
  savedPercent: number;
  mock: boolean;
}

// ---- storage availability -------------------------------------------------------------------

/**
 * What the API said about its storage.
 *
 * `unknown` is the important one, and it is deliberately not folded into `unconfigured`. "There
 * is no database here" and "I could not reach the server" call for opposite behaviour: the first
 * is a deployment running on fixtures, the second is a live deployment whose data is momentarily
 * out of reach. Answering the second with fixtures replaces a real profile with an invented one.
 */
type StorageState = "configured" | "unconfigured" | "unknown";

let storageProbe: Promise<StorageState> | null = null;

/** How long a failed probe is reused before another read is allowed to retry it. */
const PROBE_RETRY_MS = 5_000;
let probeValidUntil = Number.POSITIVE_INFINITY;

/**
 * Asks the API whether it has storage behind it, once.
 *
 * A definite answer is cached for the page's lifetime — it cannot change under a running
 * deployment. A *failure* is cached for five seconds and no longer, which is the whole point of
 * this function's shape: the previous version cached the failed probe forever, so a single blip
 * (an API still booting, a cold start, one dropped request) silently switched the entire session
 * to generated metadata and generated profiles, with no retry and nothing on screen to say so.
 */
function probeStorage(): Promise<StorageState> {
  if (storageProbe && Date.now() < probeValidUntil) return storageProbe;

  probeValidUntil = Number.POSITIVE_INFINITY;
  storageProbe = fetch(`${API_BASE}/storage/status`)
    .then((response) => {
      if (!response.ok) throw new Error(`storage status ${response.status}`);
      return response.json();
    })
    .then((body): StorageState => (body.configured ? "configured" : "unconfigured"))
    .catch((error) => {
      console.warn("[gm] could not reach the metadata API:", error);
      probeValidUntil = Date.now() + PROBE_RETRY_MS;
      return "unknown" as StorageState;
    });

  return storageProbe;
}

/**
 * Where a read should get its data.
 *
 *   - `live`      — query the API.
 *   - `fixtures`  — this deployment has no storage; the demo material is the intended content.
 *   - `none`      — the API is unreachable. Show nothing and try again on the next read.
 *
 * `none` never falls through to fixtures. Inventing a description is bad; inventing somebody's
 * username, bio and links is worse, and this codebase has already been bitten by a version of
 * that — see {@link profileSource}.
 */
type Source = "live" | "fixtures" | "none";

function toSource(state: StorageState): Source {
  if (state === "configured") return "live";
  return state === "unconfigured" ? "fixtures" : "none";
}

/**
 * Source for *token* metadata.
 *
 * Demo mode wins here. Simulated tokens were never deployed and can never have a row keyed to
 * their address, so querying real storage for them would correctly return nothing and leave
 * every card blank.
 */
export async function tokenMetadataSource(): Promise<Source> {
  if (DEMO_MODE) return "fixtures";
  return toSource(await probeStorage());
}

/**
 * Source for *profiles* — gated on storage alone, never on demo mode.
 *
 * A profile is keyed by a real wallet address. Demo mode simulates the market, not the user's
 * wallet: the address that connects is genuine whether or not the token prices around it are.
 *
 * Getting this wrong caused a live bug worth remembering. Reads were demo-gated while writes
 * were not, so an edit persisted to Turso but the page kept rendering a generated profile — and
 * because the editor seeded its fields from whatever was on screen, the generated username and
 * bio were then written into the real database. Reads and writes must agree on their source,
 * which is also why an unreachable API resolves to `none` rather than to fixtures.
 */
export async function profileSource(): Promise<Source> {
  return toSource(await probeStorage());
}

/** Exposed for the header badge / diagnostics. */
export async function isStorageConfigured(): Promise<boolean> {
  return (await probeStorage()) === "configured";
}

/**
 * Whether the profile editor can save, and if not, why.
 *
 * `unreachable` is worth distinguishing from `unconfigured` in the UI: one is a deployment
 * missing its credentials, which the reader can fix, and the other is a service that is down,
 * which they can only wait out. Telling someone to set `TURSO_URL` because a request timed out
 * sends them to fix something that was never broken.
 */
export type StorageAvailability = "checking" | "ready" | "unconfigured" | "unreachable";

export async function profileStorageAvailability(): Promise<StorageAvailability> {
  const state = await probeStorage();
  if (state === "configured") return "ready";
  return state === "unconfigured" ? "unconfigured" : "unreachable";
}

/**
 * JSON request against the metadata API, carrying the wallet session when there is one.
 *
 * A 401 is singled out because it is the one failure a caller can fix: the session lapsed, and
 * re-signing recovers it. Everything else — 403, 409, 500 — is a plain error, since prompting
 * for another signature would not change the answer.
 */
async function localJson<T>(
  path: string,
  init?: RequestInit & { token?: string | null },
): Promise<T> {
  const { token, ...rest } = init ?? {};

  const response = await fetch(path, {
    ...rest,
    headers: { "Content-Type": "application/json", ...authHeaders(token), ...rest.headers },
  });

  // Using a session is what keeps it alive; the server rides the renewal back on this response.
  if (token) adoptRotatedToken(response, loadSession(undefined, token));

  const body = await response.json().catch(() => ({}));
  if (response.status === 401) throw new SessionExpiredError(body?.error);
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body as T;
}

// ---- token metadata ----------------------------------------------------------------------------

export async function fetchTokenMeta(address: string): Promise<TokenMeta | null> {
  const source = await tokenMetadataSource();
  if (source === "none") return null;
  if (source === "fixtures") return getMockTokenMeta(address);

  try {
    const body = await localJson<{ metadata: TokenMeta | null }>(
      `${API_BASE}/tokens/${address}/metadata`,
    );
    return body.metadata;
  } catch {
    return null;
  }
}

export async function fetchTokenMetaBatch(
  addresses: string[],
): Promise<Record<string, TokenMeta>> {
  if (addresses.length === 0) return {};

  const source = await tokenMetadataSource();
  if (source === "none") return {};

  if (source === "fixtures") {
    const out: Record<string, TokenMeta> = {};
    for (const address of addresses) {
      const meta = getMockTokenMeta(address);
      if (meta) out[address.toLowerCase()] = meta;
    }
    return out;
  }

  try {
    const body = await localJson<{ metadata: Record<string, TokenMeta> }>(
      `${API_BASE}/tokens/metadata?addresses=${addresses.join(",")}`,
    );
    return body.metadata ?? {};
  } catch {
    return {};
  }
}

export async function saveTokenMeta(
  address: string,
  token: string,
  input: Partial<TokenMeta> & { imageKey?: string | null },
): Promise<TokenMeta> {
  const body = await localJson<{ metadata: TokenMeta }>(`${API_BASE}/tokens/${address}/metadata`, {
    method: "PUT",
    token,
    body: JSON.stringify(input),
  });
  return body.metadata;
}

// ---- profiles ------------------------------------------------------------------------------------

/**
 * The profile service could not be reached, so nothing can be said about this address.
 *
 * Distinct from a `null` profile, which is the positive statement that the wallet has not set one
 * up. Throwing lets the query layer retry and lets the page say "couldn't load" instead of
 * announcing an absence it has no evidence for.
 */
export class ProfileUnavailableError extends Error {
  constructor() {
    super("Could not reach the profile service");
    this.name = "ProfileUnavailableError";
  }
}

export async function fetchProfile(address: string): Promise<UserProfile | null> {
  const source = await profileSource();
  // `null` is a claim — "this wallet has no profile". An unreachable API cannot support that
  // claim, so it throws instead: the caller retries, rather than rendering a wrong fact.
  if (source === "none") throw new ProfileUnavailableError();
  if (source === "fixtures") return getMockProfile(address);

  try {
    const body = await localJson<{ profile: UserProfile | null }>(`${API_BASE}/profiles/${address}`);
    return body.profile;
  } catch {
    return null;
  }
}

/**
 * Profiles for a list of addresses, keyed lowercase. Addresses without one are simply absent.
 *
 * Unlike the single-profile read this never throws: it backs decoration — an avatar and a name
 * beside an address that is already on screen — so an unreachable API should degrade to plain
 * addresses, not blow up a ticker or a leaderboard.
 */
export async function fetchProfileBatch(
  addresses: string[],
): Promise<Record<string, UserProfile>> {
  if (addresses.length === 0) return {};

  const source = await profileSource();
  if (source === "none") return {};

  if (source === "fixtures") {
    const out: Record<string, UserProfile> = {};
    for (const address of addresses) {
      const profile = getMockProfile(address);
      if (profile) out[address.toLowerCase()] = profile;
    }
    return out;
  }

  try {
    const body = await localJson<{ profiles: Record<string, UserProfile> }>(
      `${API_BASE}/profiles/batch?addresses=${addresses.join(",")}`,
    );
    return body.profiles ?? {};
  } catch {
    return {};
  }
}

export async function fetchProfileByUsername(username: string): Promise<UserProfile | null> {
  const source = await profileSource();
  if (source === "none") throw new ProfileUnavailableError();
  if (source === "fixtures") return findMockProfileByUsername(username);

  try {
    const body = await localJson<{ profile: UserProfile | null }>(
      `${API_BASE}/profiles/lookup?username=${encodeURIComponent(username)}`,
    );
    return body.profile;
  } catch {
    return null;
  }
}

export type UsernameCheck =
  | { status: "free" }
  | { status: "taken" }
  | { status: "invalid"; message: string }
  | { status: "error"; message: string };

/**
 * Availability of a username for `address`.
 *
 * Four outcomes, deliberately — an earlier version collapsed everything that wasn't a clean
 * "available: true" into `available: false`, which the editor rendered as "taken". A momentary
 * network blip, or the API process restarting in dev, therefore told the user every name
 * they tried was taken, with no way to get past it. "I couldn't check" is not "someone has it".
 */
export async function checkUsername(username: string, address: string): Promise<UsernameCheck> {
  const source = await profileSource();
  // With no storage there is no uniqueness constraint to satisfy, so anything is free. With an
  // unreachable API there very much is one — saying "free" here would promise a name we cannot
  // see, and the save would then 409.
  if (source === "fixtures") return { status: "free" };
  if (source === "none") {
    return { status: "error", message: "Could not reach the server to check that name" };
  }

  try {
    const response = await fetch(
      `${API_BASE}/profiles/lookup?username=${encodeURIComponent(username)}&check=${address}`,
    );
    const body = await response.json().catch(() => ({}));

    // A 400 means the name itself is malformed — a different problem from being unavailable,
    // and one the user can act on from the message.
    if (response.status === 400) {
      return { status: "invalid", message: body?.error ?? "Invalid username" };
    }
    if (!response.ok) {
      return { status: "error", message: body?.error ?? `Check failed (${response.status})` };
    }

    return body?.available ? { status: "free" } : { status: "taken" };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Could not reach the server",
    };
  }
}

export async function saveProfile(
  address: string,
  token: string,
  input: Partial<UserProfile> & { avatarKey?: string | null; bannerKey?: string | null },
): Promise<UserProfile> {
  const body = await localJson<{ profile: UserProfile }>(`${API_BASE}/profiles/${address}`, {
    method: "PUT",
    token,
    body: JSON.stringify(input),
  });
  return body.profile;
}

// ---- upload ----------------------------------------------------------------------------------------

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Uploads an image. The file is checked against the 5 MB cap here as well as on the server —
 * client-side so the user gets an instant, specific error instead of waiting out an upload that
 * is going to be rejected, server-side because a client check is not a control.
 */
export async function uploadImage(
  file: File,
  kind: "token" | "avatar" | "banner",
  token: string,
): Promise<UploadResult> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB.`,
    );
  }
  if (!file.type.startsWith("image/")) {
    throw new Error("That file isn't an image");
  }

  const form = new FormData();
  form.append("file", file);
  form.append("kind", kind);

  // No Content-Type header: the browser has to set the multipart boundary itself.
  const response = await fetch(`${API_BASE}/upload`, {
    method: "POST",
    headers: authHeaders(token),
    body: form,
  });

  adoptRotatedToken(response, loadSession(undefined, token));

  const body = await response.json().catch(() => ({}));
  if (response.status === 401) throw new SessionExpiredError(body?.error);
  if (!response.ok) throw new Error(body?.error ?? "Upload failed");
  return body as UploadResult;
}
