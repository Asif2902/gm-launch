import * as dotenv from "dotenv";
import { getAddress, type Address } from "viem";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got "${raw}"`);
  return parsed;
}

export const config = {
  chainId: optionalNumber("CHAIN_ID", 8453),
  rpcUrl: required("RPC_URL"),
  factoryAddress: getAddress(required("FACTORY_ADDRESS")) as Address,
  startBlock: BigInt(optionalNumber("START_BLOCK", 0)),

  blockBatchSize: BigInt(optionalNumber("BLOCK_BATCH_SIZE", 2000)),
  confirmations: BigInt(optionalNumber("CONFIRMATIONS", 5)),
  reorgDepth: BigInt(optionalNumber("REORG_DEPTH", 32)),
  pollIntervalMs: optionalNumber("POLL_INTERVAL_MS", 2000),

  databaseUrl: required("DATABASE_URL"),

  apiPort: optionalNumber("API_PORT", 4000),
  apiCorsOrigin: process.env.API_CORS_ORIGIN ?? "*",
  apiOnly: (process.env.API_ONLY ?? "false").toLowerCase() === "true",
} as const;

/** Candle intervals maintained by the indexer, in seconds. */
export const CANDLE_INTERVALS = [60, 300, 900, 3_600, 14_400, 86_400] as const;

/** Protocol constants, mirrored from the contracts for derived values. */
export const PROTOCOL = {
  totalSupply: 1_000_000_000n * 10n ** 18n,
  virtualEthReserve: 5n * 10n ** 17n,
  migrationThreshold: 5n * 10n ** 18n,
  priceUnit: 10n ** 18n,
  burnAddress: "0x000000000000000000000000000000000000dead",
  zeroAddress: "0x0000000000000000000000000000000000000000",
} as const;

export const TokenStatus = {
  Trading: 1,
  PendingMigration: 2,
  Migrated: 3,
} as const;
