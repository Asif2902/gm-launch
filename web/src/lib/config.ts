import type { Address } from "viem";

/**
 * Client configuration, from Vite's `import.meta.env`.
 *
 * Only `VITE_`-prefixed variables are exposed to the bundle — that prefix is the boundary, and
 * it is why the Turso and R2 credentials live in the `server/` package instead: anything the
 * browser can read is public, so a secret here would be a secret published.
 */

export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 8453);

export const FACTORY_ADDRESS = (import.meta.env.VITE_FACTORY_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as Address;

/**
 * Base path for the off-chain metadata API (`server/`).
 *
 * Defaults to a relative `/api`, which Vite proxies to the API server in development and which
 * a reverse proxy handles in production. Set `VITE_API_BASE` to an absolute URL when the two are
 * deployed to different hosts.
 */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? "/api").replace(/\/$/, "");

/** Indexer REST API. Ignored when a subgraph URL is configured. */
export const INDEXER_URL = import.meta.env.VITE_INDEXER_URL ?? "http://localhost:4000";

/**
 * The Graph endpoint. When set it takes precedence over the REST indexer.
 *
 * Both are built from the same events and expose the same entities, so this is purely an
 * operational choice: the subgraph needs nothing but a URL, while the REST indexer needs a
 * Postgres instance you host.
 */
export const SUBGRAPH_URL = import.meta.env.VITE_SUBGRAPH_URL ?? "";

export const RPC_URL = import.meta.env.VITE_RPC_URL ?? "https://mainnet.base.org";

export const EXPLORER_URL = import.meta.env.VITE_EXPLORER_URL ?? "https://basescan.org";

/**
 * Forces the simulated launchpad in `lib/mock.ts` instead of calling the indexer. Leave it off
 * for real deployments — the client falls back to demo data automatically (and says so in the
 * header) whenever the indexer is unreachable.
 */
export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

/**
 * Protocol constants, mirrored for display and for optimistic UI only.
 *
 * Anything that decides a transaction — quotes, slippage floors, migration state — is read from
 * the contract or the indexer, never computed here (spec §14).
 */
export const PROTOCOL = {
  totalSupply: 1_000_000_000n * 10n ** 18n,
  virtualEthReserve: 5n * 10n ** 17n,
  migrationThreshold: 5n * 10n ** 18n,
  /** k / (0.5 + 5) ETH — what the curve still holds the moment it graduates. */
  tokenReserveAtMigration: 90_909_090_909_090_909_090_909_090n,
  buyFeeBps: 20n,
  sellFeeBps: 30n,
  bps: 10_000n,
  priceUnit: 10n ** 18n,
} as const;

export const TokenStatus = {
  Trading: 1,
  PendingMigration: 2,
  Migrated: 3,
} as const;

export const STATUS_LABEL: Record<number, string> = {
  1: "Bonding curve",
  2: "Ready to migrate",
  3: "Migrated to Uniswap",
};

export const CANDLE_INTERVALS = [
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1H", seconds: 3600 },
  { label: "4H", seconds: 14400 },
  { label: "1D", seconds: 86400 },
] as const;

/**
 * The chain this deployment trades on, in words.
 *
 * Derived rather than written into the UI, so switching `VITE_CHAIN_ID` moves every label,
 * warning and footer at once instead of leaving "Base Sepolia" stamped on a mainnet app.
 */
export const NETWORK_NAME = CHAIN_ID === 8453 ? "Base" : CHAIN_ID === 84532 ? "Base Sepolia" : `Chain ${CHAIN_ID}`;

/** Whether this deployment is playing with real money. */
export const IS_MAINNET = CHAIN_ID === 8453;

/**
 * Whether a launchpad has actually been deployed and wired up yet.
 *
 * A zero factory address means `npm run sync` has not run against a deployment, so there is
 * nothing to read and no amount of retrying will produce any. Worth distinguishing from a
 * service being down: one is a setup step, the other is an outage.
 */
export const IS_CONFIGURED =
  FACTORY_ADDRESS.toLowerCase() !== "0x0000000000000000000000000000000000000000";

export const explorerAddress = (address: string) => `${EXPLORER_URL}/address/${address}`;
export const explorerTx = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
