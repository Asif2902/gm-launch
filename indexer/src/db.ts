import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { config } from "./config";
import { logger } from "./logger";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (error) => {
  logger.error("Unexpected postgres client error", { error: error.message });
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Postgres NUMERIC/BIGINT arrive as strings; normalise to bigint. */
export function toBigInt(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === "bigint") return value;
  return BigInt(value);
}

/** bigint -> string for NUMERIC(78,0) parameters. */
export function num(value: bigint): string {
  return value.toString();
}

export async function closePool(): Promise<void> {
  await pool.end();
}
