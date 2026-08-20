/**
 * Shapes returned by the indexer API. All uint256 values arrive as decimal strings — JSON
 * numbers would lose precision — so they are typed as `string` and parsed with BigInt.
 */

export interface IndexedToken {
  address: string;
  creator: string;
  name: string;
  symbol: string;
  status: number;

  total_supply: string;
  migration_threshold: string;

  eth_reserve: string;
  virtual_eth_reserve: string;
  token_reserve: string;

  price: string;
  market_cap: string;
  /**
   * Highest market cap ever reached — a high-water mark.
   *
   * Optional because it was added after the first release: a deployment running an older indexer
   * or subgraph simply will not send it, and the UI falls back rather than showing a wrong zero.
   */
  ath_market_cap?: string;
  fdv: string;
  migration_progress_bps: number;

  volume_eth: string;
  buy_volume_eth: string;
  sell_volume_eth: string;
  tokens_bought: string;
  tokens_sold: string;
  fees_eth: string;

  trade_count: number;
  buy_count: number;
  sell_count: number;
  holder_count: number;

  pair: string | null;
  migrated_at: string | null;
  last_trade_at: string | null;
  created_at: string;
  created_at_block: string;
  created_at_tx: string;

  volume_24h?: string;
  trades_24h?: string;
  traders_24h?: string;
  high_24h?: string | null;
  low_24h?: string | null;
  open_24h?: string | null;

  /** Up to the last 24 price points, oldest first — drives the discover-feed sparkline. */
  sparkline?: string[] | null;
}

export interface IndexedTrade {
  token: string;
  trader: string;
  side: number; // 0 buy, 1 sell
  eth_in: string;
  eth_out: string;
  gross_eth: string;
  fee: string;
  token_amount: string;
  price: string;
  execution_price: string;
  eth_reserve: string;
  virtual_eth_reserve: string;
  token_reserve: string;
  block_number: string;
  tx_hash: string;
  log_index: number;
  timestamp: string;
}

export interface IndexedCandle {
  bucket_start: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume_eth: string;
  trade_count: number;
}

export interface IndexedHolder {
  address: string;
  balance: string;
  share_bps: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface IndexedMigration {
  token: string;
  pair: string | null;
  triggered_at: string | null;
  triggered_eth_reserve: string | null;
  triggered_token_reserve: string | null;
  completed_at: string | null;
  completed_tx: string | null;
  eth_deposited: string | null;
  tokens_deposited: string | null;
  tokens_burned: string | null;
  lp_tokens_burned: string | null;
  opening_price: string | null;
}

export interface ProtocolStats {
  tokens: string;
  migrated: string;
  pending_migration: string;
  total_volume_eth: string;
  total_fees_eth: string;
  total_eth_locked: string;
  total_trades: string;
  volume_24h: string;
}

/**
 * One row of the trader leaderboard.
 *
 * `volume`, `eth_in`, `eth_out` and `trades` cover the requested window; `holdings_value` is
 * necessarily current, since a balance has no history without replaying transfers. `pnl` adds the
 * two together, which only makes it a real profit figure over the all-time window — see the
 * indexer's `/leaderboard` comment.
 *
 * The cash-flow fields are optional because The Graph cannot produce them: its `Account` entity
 * carries lifetime volume and trade counts but no per-side totals, so a subgraph-backed
 * deployment ranks on volume and activity alone rather than inventing a PnL. Which fields are
 * actually present is reported alongside the rows — see `LeaderboardCapabilities` in `api.ts`.
 */
export interface LeaderboardTrader {
  address: string;
  trades: number;
  tokens: number;
  last_trade_at: string | null;
  volume: string;
  eth_in?: string;
  eth_out?: string;
  holdings_value?: string | null;
  pnl?: string | null;
}

/** One row of the creator leaderboard: everything an address has launched. */
export interface LeaderboardCreator {
  address: string;
  tokens_created: number;
  tokens_migrated: number;
  volume: string;
  market_cap: string;
  fees: string;
  trades: number;
  holders: number;
  last_created_at: string | null;
}

/** Mirrors the `TokenView` struct returned by `PumperFactory.getToken`. */
export interface OnChainToken {
  token: string;
  creator: string;
  status: number;
  name: string;
  symbol: string;
  totalSupply: bigint;
  circulatingSupply: bigint;
  ethReserve: bigint;
  virtualEthReserve: bigint;
  tokenReserve: bigint;
  virtualTokenReserve: bigint;
  tokenPrice: bigint;
  marketCap: bigint;
  fullyDilutedValuation: bigint;
  tokensAvailable: bigint;
  migrationProgressBps: bigint;
  cumulativeEthIn: bigint;
  cumulativeEthOut: bigint;
  cumulativeTokensBought: bigint;
  cumulativeTokensSold: bigint;
  createdAt: bigint;
  migratedAt: bigint;
  pair: string;
}
