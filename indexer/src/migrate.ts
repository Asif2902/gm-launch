import * as fs from "fs";
import * as path from "path";

import { closePool, pool } from "./db";
import { logger } from "./logger";

const TABLES = [
  "platform_fees",
  "transfers",
  "holders",
  "candles",
  "price_points",
  "trades",
  "migrations",
  "tokens",
  "creators",
  "blocks",
  "indexer_state",
];

async function main() {
  const reset = process.argv.includes("--reset");

  if (reset) {
    logger.warn("Dropping all indexer tables (--reset)");
    await pool.query(`DROP VIEW IF EXISTS token_stats_24h CASCADE`);
    for (const table of TABLES) {
      await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
  }

  const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schema);

  logger.info("Schema applied", { schemaPath, reset });
  await closePool();
}

main().catch(async (error) => {
  logger.error("Migration failed", { error: error instanceof Error ? error.message : String(error) });
  await closePool();
  process.exitCode = 1;
});
