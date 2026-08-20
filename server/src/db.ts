import { createClient, type Client } from "@libsql/client";

import { turso } from "./env";

/**
 * Turso (libSQL) access for the off-chain metadata layer.
 *
 * Scope discipline matters here: this database holds **only** material that has no on-chain
 * meaning — descriptions, social links, profile handles, avatars, and a ledger of uploaded
 * images. Anything a trade depends on (price, reserves, supply, holdings, migration state) is
 * read from the contracts or reconstructed from events, never from this table. If Turso is
 * wiped, the protocol is unaffected and the UI degrades to addresses and tickers.
 */

let client: Client | null = null;
let schemaReady: Promise<void> | null = null;

export function getDb(): Client | null {
  if (!turso) return null;
  if (!client) {
    client = createClient({ url: turso.url, authToken: turso.authToken });
  }
  return client;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS profiles (
     address       TEXT PRIMARY KEY,
     username      TEXT UNIQUE,
     display_name  TEXT,
     bio           TEXT,
     avatar_key    TEXT,
     banner_key    TEXT,
     website       TEXT,
     twitter       TEXT,
     telegram      TEXT,
     discord       TEXT,
     github        TEXT,
     created_at    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS token_metadata (
     address       TEXT PRIMARY KEY,
     creator       TEXT NOT NULL,
     description   TEXT,
     image_key     TEXT,
     banner_key    TEXT,
     website       TEXT,
     twitter       TEXT,
     telegram      TEXT,
     discord       TEXT,
     created_at    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS images (
     key             TEXT PRIMARY KEY,
     thumb_key       TEXT,
     owner           TEXT NOT NULL,
     kind            TEXT NOT NULL,
     mime            TEXT NOT NULL,
     width           INTEGER NOT NULL,
     height          INTEGER NOT NULL,
     original_bytes  INTEGER NOT NULL,
     stored_bytes    INTEGER NOT NULL,
     created_at      INTEGER NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS images_owner_idx ON images (owner, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS token_metadata_creator_idx ON token_metadata (creator)`,

  // Shared cache for external quotes (currently just ETH/USD). Lives in the database rather than
  // process memory so it survives restarts and is shared across instances — a module-level
  // variable is per-instance, and on serverless that means one upstream call per cold start.
  `CREATE TABLE IF NOT EXISTS price_cache (
     id         TEXT PRIMARY KEY,
     usd        REAL NOT NULL,
     source     TEXT NOT NULL,
     fetched_at INTEGER NOT NULL
   )`,
];

/** Applies the schema once per process. Safe to call on every request. */
export async function ensureSchema(): Promise<void> {
  const db = getDb();
  if (!db) return;
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const statement of SCHEMA) {
        await db.execute(statement);
      }
    })().catch((error) => {
      schemaReady = null; // let the next request retry rather than caching the failure
      throw error;
    });
  }
  return schemaReady;
}

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export interface Profile {
  address: string;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarKey: string | null;
  bannerKey: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  discord: string | null;
  github: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TokenMetadata {
  address: string;
  creator: string;
  description: string | null;
  imageKey: string | null;
  bannerKey: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  discord: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ImageRecord {
  key: string;
  thumbKey: string | null;
  owner: string;
  kind: string;
  mime: string;
  width: number;
  height: number;
  originalBytes: number;
  storedBytes: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------------------------

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

function toProfile(row: Record<string, unknown>): Profile {
  return {
    address: String(row.address),
    username: text(row.username),
    displayName: text(row.display_name),
    bio: text(row.bio),
    avatarKey: text(row.avatar_key),
    bannerKey: text(row.banner_key),
    website: text(row.website),
    twitter: text(row.twitter),
    telegram: text(row.telegram),
    discord: text(row.discord),
    github: text(row.github),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toTokenMetadata(row: Record<string, unknown>): TokenMetadata {
  return {
    address: String(row.address),
    creator: String(row.creator),
    description: text(row.description),
    imageKey: text(row.image_key),
    bannerKey: text(row.banner_key),
    website: text(row.website),
    twitter: text(row.twitter),
    telegram: text(row.telegram),
    discord: text(row.discord),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

// ---------------------------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------------------------

export async function getProfile(address: string): Promise<Profile | null> {
  const db = getDb();
  if (!db) return null;
  await ensureSchema();

  const result = await db.execute({
    sql: `SELECT * FROM profiles WHERE address = ?`,
    args: [address.toLowerCase()],
  });
  return result.rows[0] ? toProfile(result.rows[0] as any) : null;
}

/**
 * Profiles for many addresses at once.
 *
 * Exists because identity shows up in lists — the trade ticker, the leaderboard, the creator line
 * on every card — and a request per row would be dozens of round trips to render one screen. Same
 * shape as {@link getTokenMetadataBatch}; addresses with no profile are simply absent from the
 * map, which the caller reads as "fall back to the address".
 */
export async function getProfilesBatch(addresses: string[]): Promise<Map<string, Profile>> {
  const out = new Map<string, Profile>();
  const db = getDb();
  if (!db || addresses.length === 0) return out;
  await ensureSchema();

  const keys = addresses.map((address) => address.toLowerCase());
  const placeholders = keys.map(() => "?").join(",");

  const result = await db.execute({
    sql: `SELECT * FROM profiles WHERE address IN (${placeholders})`,
    args: keys,
  });

  for (const row of result.rows) {
    const profile = toProfile(row as any);
    out.set(profile.address, profile);
  }
  return out;
}

export async function getProfileByUsername(username: string): Promise<Profile | null> {
  const db = getDb();
  if (!db) return null;
  await ensureSchema();

  const result = await db.execute({
    sql: `SELECT * FROM profiles WHERE username = ?`,
    args: [username.toLowerCase()],
  });
  return result.rows[0] ? toProfile(result.rows[0] as any) : null;
}

/** True when `username` is free, or already belongs to `address`. */
export async function isUsernameAvailable(username: string, address: string): Promise<boolean> {
  const existing = await getProfileByUsername(username);
  return !existing || existing.address === address.toLowerCase();
}

export type ProfileInput = Partial<
  Pick<
    Profile,
    | "username"
    | "displayName"
    | "bio"
    | "avatarKey"
    | "bannerKey"
    | "website"
    | "twitter"
    | "telegram"
    | "discord"
    | "github"
  >
>;

const PROFILE_COLUMNS: Record<keyof ProfileInput, string> = {
  username: "username",
  displayName: "display_name",
  bio: "bio",
  avatarKey: "avatar_key",
  bannerKey: "banner_key",
  website: "website",
  twitter: "twitter",
  telegram: "telegram",
  discord: "discord",
  github: "github",
};

/**
 * Partial update built from the keys the caller actually supplied.
 *
 * The obvious `COALESCE(excluded.x, profiles.x)` form looks like "only overwrite when a value
 * was supplied", but it conflates *absent* with *empty* — so once a field had a value, no user
 * could ever clear it again: sending `""` normalises to NULL and COALESCE keeps the old text.
 * Driving the column list off `Object.keys(input)` distinguishes the two properly, and the route
 * only adds a key when the request body contained it.
 */
export async function upsertProfile(address: string, input: ProfileInput): Promise<Profile | null> {
  const db = getDb();
  if (!db) return null;
  await ensureSchema();

  const key = address.toLowerCase();
  const now = Math.floor(Date.now() / 1000);

  const provided = (Object.keys(input) as Array<keyof ProfileInput>).filter(
    (field) => field in input && PROFILE_COLUMNS[field] !== undefined,
  );

  const value = (field: keyof ProfileInput) => {
    const raw = input[field];
    if (raw === undefined || raw === null || raw === "") return null;
    return field === "username" ? String(raw).toLowerCase() : raw;
  };

  const insertColumns = ["address", ...provided.map((field) => PROFILE_COLUMNS[field]), "created_at", "updated_at"];
  const insertValues = [key, ...provided.map(value), now, now];

  const updates = [
    ...provided.map((field) => `${PROFILE_COLUMNS[field]} = excluded.${PROFILE_COLUMNS[field]}`),
    "updated_at = excluded.updated_at",
  ];

  await db.execute({
    sql: `INSERT INTO profiles (${insertColumns.join(", ")})
          VALUES (${insertColumns.map(() => "?").join(", ")})
          ON CONFLICT(address) DO UPDATE SET ${updates.join(", ")}`,
    args: insertValues as any[],
  });

  return getProfile(key);
}

// ---------------------------------------------------------------------------------------------
// Token metadata
// ---------------------------------------------------------------------------------------------

export async function getTokenMetadata(address: string): Promise<TokenMetadata | null> {
  const db = getDb();
  if (!db) return null;
  await ensureSchema();

  const result = await db.execute({
    sql: `SELECT * FROM token_metadata WHERE address = ?`,
    args: [address.toLowerCase()],
  });
  return result.rows[0] ? toTokenMetadata(result.rows[0] as any) : null;
}

/** Batch lookup for the discover feed — one query, no N+1. */
export async function getTokenMetadataBatch(
  addresses: string[],
): Promise<Map<string, TokenMetadata>> {
  const out = new Map<string, TokenMetadata>();
  const db = getDb();
  if (!db || addresses.length === 0) return out;
  await ensureSchema();

  const keys = addresses.map((address) => address.toLowerCase());
  const placeholders = keys.map(() => "?").join(",");

  const result = await db.execute({
    sql: `SELECT * FROM token_metadata WHERE address IN (${placeholders})`,
    args: keys,
  });

  for (const row of result.rows) {
    const metadata = toTokenMetadata(row as any);
    out.set(metadata.address, metadata);
  }
  return out;
}

export type TokenMetadataInput = Partial<
  Pick<
    TokenMetadata,
    "description" | "imageKey" | "bannerKey" | "website" | "twitter" | "telegram" | "discord"
  >
>;

const TOKEN_COLUMNS: Record<keyof TokenMetadataInput, string> = {
  description: "description",
  imageKey: "image_key",
  bannerKey: "banner_key",
  website: "website",
  twitter: "twitter",
  telegram: "telegram",
  discord: "discord",
};

/** Same supplied-keys-only strategy as {@link upsertProfile}, so fields can be cleared. */
export async function upsertTokenMetadata(
  address: string,
  creator: string,
  input: TokenMetadataInput,
): Promise<TokenMetadata | null> {
  const db = getDb();
  if (!db) return null;
  await ensureSchema();

  const key = address.toLowerCase();
  const now = Math.floor(Date.now() / 1000);

  const provided = (Object.keys(input) as Array<keyof TokenMetadataInput>).filter(
    (field) => TOKEN_COLUMNS[field] !== undefined,
  );

  const insertColumns = [
    "address",
    "creator",
    ...provided.map((field) => TOKEN_COLUMNS[field]),
    "created_at",
    "updated_at",
  ];
  const insertValues = [
    key,
    creator.toLowerCase(),
    ...provided.map((field) => {
      const raw = input[field];
      return raw === undefined || raw === null || raw === "" ? null : raw;
    }),
    now,
    now,
  ];

  const updates = [
    ...provided.map((field) => `${TOKEN_COLUMNS[field]} = excluded.${TOKEN_COLUMNS[field]}`),
    "updated_at = excluded.updated_at",
  ];

  await db.execute({
    sql: `INSERT INTO token_metadata (${insertColumns.join(", ")})
          VALUES (${insertColumns.map(() => "?").join(", ")})
          ON CONFLICT(address) DO UPDATE SET ${updates.join(", ")}`,
    args: insertValues as any[],
  });

  return getTokenMetadata(key);
}

// ---------------------------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------------------------

export async function recordImage(record: ImageRecord): Promise<void> {
  const db = getDb();
  if (!db) return;
  await ensureSchema();

  await db.execute({
    sql: `INSERT INTO images (
            key, thumb_key, owner, kind, mime, width, height,
            original_bytes, stored_bytes, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(key) DO NOTHING`,
    args: [
      record.key,
      record.thumbKey,
      record.owner.toLowerCase(),
      record.kind,
      record.mime,
      record.width,
      record.height,
      record.originalBytes,
      record.storedBytes,
      record.createdAt,
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Price cache
// ---------------------------------------------------------------------------------------------

export interface CachedPrice {
  usd: number;
  source: string;
  fetchedAt: number;
}

export async function getCachedPrice(id: string): Promise<CachedPrice | null> {
  const db = getDb();
  if (!db) return null;
  await ensureSchema();

  const result = await db.execute({
    sql: `SELECT usd, source, fetched_at FROM price_cache WHERE id = ?`,
    args: [id],
  });
  const row = result.rows[0];
  if (!row) return null;

  return {
    usd: Number(row.usd),
    source: String(row.source),
    fetchedAt: Number(row.fetched_at),
  };
}

export async function setCachedPrice(id: string, price: CachedPrice): Promise<void> {
  const db = getDb();
  if (!db) return;
  await ensureSchema();

  await db.execute({
    sql: `INSERT INTO price_cache (id, usd, source, fetched_at) VALUES (?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            usd = excluded.usd, source = excluded.source, fetched_at = excluded.fetched_at`,
    args: [id, price.usd, price.source, price.fetchedAt],
  });
}

/**
 * Per-address upload count in a trailing window — the rate limit for the upload route.
 * Uploads cost storage and bandwidth, so they are capped even though they are signature-gated.
 */
export async function recentUploadCount(owner: string, windowSeconds: number): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  await ensureSchema();

  const since = Math.floor(Date.now() / 1000) - windowSeconds;
  const result = await db.execute({
    sql: `SELECT COUNT(*) AS count FROM images WHERE owner = ? AND created_at >= ?`,
    args: [owner.toLowerCase(), since],
  });
  return Number(result.rows[0]?.count ?? 0);
}
