/**
 * Connectivity check for the off-chain layer.
 *
 *   npm --prefix server run storage:check      (or: node check-storage.mjs, from server/)
 *
 * Applies the Turso schema, round-trips a row, and round-trips a small object through R2.
 * Everything it writes is namespaced under a `__healthcheck` prefix and deleted again, so it
 * never touches real data. Secrets are read from .env and never printed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const here = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const env = {};
  for (const file of [".env", ".env.local"]) {
    let contents;
    try {
      // Alongside this script, which is also where the server itself reads its .env from.
      contents = readFileSync(join(here, file), "utf8");
    } catch {
      continue;
    }
    for (const line of contents.split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

const env = loadEnv();
const ok = (label, detail = "") => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
const fail = (label, error) => {
  console.log(`  FAIL  ${label} — ${error?.message ?? error}`);
  process.exitCode = 1;
};

console.log("\nPumper storage check\n");

// ---- Turso -------------------------------------------------------------------------------------
console.log("Turso (libSQL)");
if (!env.TURSO_URL) {
  fail("TURSO_URL", "not set");
} else if (!/^(libsql|https?|file|ws|wss):/i.test(env.TURSO_URL)) {
  fail(
    "TURSO_URL",
    "does not look like a libSQL endpoint (an auth token pasted here belongs in TURSO_AUTH_TOKEN)",
  );
} else {
  try {
    const db = createClient({ url: env.TURSO_URL, authToken: env.TURSO_AUTH_TOKEN });

    const version = await db.execute("SELECT sqlite_version() AS v");
    ok("connected", `SQLite ${version.rows[0].v}`);

    await db.execute(`CREATE TABLE IF NOT EXISTS __healthcheck (id TEXT PRIMARY KEY, at INTEGER)`);
    const stamp = Date.now();
    await db.execute({
      sql: `INSERT INTO __healthcheck (id, at) VALUES (?, ?)
            ON CONFLICT(id) DO UPDATE SET at = excluded.at`,
      args: ["probe", stamp],
    });
    const read = await db.execute("SELECT at FROM __healthcheck WHERE id = 'probe'");
    if (Number(read.rows[0].at) === stamp) ok("write + read round-trip");
    else fail("write + read round-trip", "value mismatch");

    await db.execute("DROP TABLE __healthcheck");
    ok("cleanup");

    const tables = await db.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    ok(
      "existing tables",
      tables.rows.length ? tables.rows.map((row) => row.name).join(", ") : "(none yet)",
    );
  } catch (error) {
    fail("connection", error);
  }
}

// ---- R2 ------------------------------------------------------------------------------------------
console.log("\nCloudflare R2");
const required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];
const missing = required.filter((key) => !env[key]);

if (missing.length > 0) {
  fail("configuration", `missing ${missing.join(", ")}`);
} else {
  try {
    const s3 = new S3Client({
      region: "auto",
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });

    const key = `__healthcheck/${Date.now()}.txt`;
    const body = "pumper storage check";

    await s3.send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET,
        Key: key,
        Body: body,
        ContentType: "text/plain",
      }),
    );
    ok("put object", `${env.R2_BUCKET}/${key}`);

    const got = await s3.send(new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
    const text = await got.Body.transformToString();
    if (text === body) ok("get object");
    else fail("get object", "content mismatch");

    await s3.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
    ok("cleanup");

    if (env.R2_PUBLIC_BASE_URL) {
      ok("public base URL", env.R2_PUBLIC_BASE_URL);
    } else {
      console.log("  WARN  R2_PUBLIC_BASE_URL not set — uploaded images would have no public URL");
    }
  } catch (error) {
    fail("connection", error);
  }
}

console.log("");
