/**
 * Server-side configuration for the off-chain layer.
 *
 * Two backing services, both optional:
 *   - **Turso** (libSQL) holds off-chain metadata: token descriptions, social links, profiles,
 *     and a record of every uploaded image.
 *   - **Cloudflare R2** (S3-compatible) holds the image bytes themselves.
 *
 * Nothing on-chain depends on either. Prices, reserves, supply, holdings and migration state all
 * still come from the contracts and the event stream — this layer only carries the cosmetic and
 * social material that has no business being on-chain (spec §14: never store critical protocol
 * information only in metadata or APIs).
 *
 * When either service is unconfigured the app runs entirely on the in-memory mock, so a
 * contributor can work on the UI without credentials.
 */

function read(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

const tursoUrl = read("TURSO_URL");
const tursoAuthToken = read("TURSO_AUTH_TOKEN");

const r2AccountId = read("R2_ACCOUNT_ID");
const r2AccessKeyId = read("R2_ACCESS_KEY_ID");
const r2SecretAccessKey = read("R2_SECRET_ACCESS_KEY");
const r2Bucket = read("R2_BUCKET");
const r2PublicBaseUrl = read("R2_PUBLIC_BASE_URL");

export const turso = tursoUrl
  ? { url: tursoUrl, authToken: tursoAuthToken }
  : null;

export const r2 =
  r2AccountId && r2AccessKeyId && r2SecretAccessKey && r2Bucket && r2PublicBaseUrl
    ? {
        accountId: r2AccountId,
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey,
        bucket: r2Bucket,
        publicBaseUrl: r2PublicBaseUrl.replace(/\/$/, ""),
        endpoint: `https://${r2AccountId}.r2.cloudflarestorage.com`,
      }
    : null;

export const storageConfigured = Boolean(turso && r2);

/**
 * A `TURSO_URL` that looks like a JWT rather than a libsql:// endpoint is the classic
 * copy-paste slip: both values pasted under the same key, so the token silently overwrites the
 * URL. Catch it at boot instead of failing on the first query.
 */
export function assertEnvSane(): void {
  if (tursoUrl && !/^(libsql|https?|file|ws|wss):/i.test(tursoUrl)) {
    throw new Error(
      "TURSO_URL does not look like a libSQL endpoint. If you pasted an auth token there, " +
        "it belongs in TURSO_AUTH_TOKEN.",
    );
  }
  if (tursoUrl?.startsWith("libsql://") && !tursoAuthToken) {
    throw new Error("TURSO_AUTH_TOKEN is required for a remote libsql:// database.");
  }
}

/** Redacted view for the health endpoint — never leaks a secret. */
export function storageStatus() {
  return {
    turso: turso
      ? { configured: true, host: safeHost(turso.url), authToken: Boolean(turso.authToken) }
      : { configured: false },
    r2: r2
      ? { configured: true, bucket: r2.bucket, publicBaseUrl: r2.publicBaseUrl }
      : { configured: false },
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url.replace(/^libsql:/, "https:")).host;
  } catch {
    return "invalid";
  }
}
