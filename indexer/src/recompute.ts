import type { PoolClient } from "pg";

import { CANDLE_INTERVALS, PROTOCOL, TokenStatus } from "./config";
import { num } from "./db";
import { logger } from "./logger";
import { refreshHolderCount } from "./handlers";

/**
 * Reorg recovery.
 *
 * Everything the API serves is either an event-derived row (trades, price_points, transfers,
 * platform_fees, migrations) or a cache computed from those rows (the mutable half of `tokens`,
 * plus candles and holders). So rolling back is: delete the event rows above the fork point,
 * then rebuild every cache for the tokens that were touched. No compensating deltas, no drift.
 */
export async function rollbackToBlock(client: PoolClient, targetBlock: bigint): Promise<void> {
  logger.warn("Rolling back indexed data", { targetBlock });

  const affected = await client.query<{ token: string }>(
    `SELECT DISTINCT token FROM (
        SELECT token FROM trades         WHERE block_number > $1
        UNION SELECT token FROM transfers      WHERE block_number > $1
        UNION SELECT token FROM platform_fees  WHERE block_number > $1
        UNION SELECT token FROM migrations     WHERE completed_at_block > $1 OR triggered_at_block > $1
     ) touched`,
    [num(targetBlock)],
  );

  await client.query(`DELETE FROM trades        WHERE block_number > $1`, [num(targetBlock)]);
  await client.query(`DELETE FROM price_points  WHERE block_number > $1`, [num(targetBlock)]);
  await client.query(`DELETE FROM platform_fees WHERE block_number > $1`, [num(targetBlock)]);
  await client.query(`DELETE FROM transfers     WHERE block_number > $1`, [num(targetBlock)]);

  // Undo migration rows partially: a completed migration above the fork reverts to triggered,
  // a triggered migration above the fork disappears entirely.
  await client.query(
    `UPDATE migrations SET
        pair = NULL, completed_at = NULL, completed_at_block = NULL, completed_tx = NULL,
        eth_deposited = NULL, tokens_deposited = NULL, tokens_burned = NULL,
        lp_tokens_burned = NULL, opening_price = NULL
      WHERE completed_at_block > $1`,
    [num(targetBlock)],
  );
  await client.query(`DELETE FROM migrations WHERE triggered_at_block > $1`, [num(targetBlock)]);

  // Tokens created above the fork never existed; cascades clear their dependent rows.
  const orphaned = await client.query<{ address: string; creator: string }>(
    `DELETE FROM tokens WHERE created_at_block > $1 RETURNING address, creator`,
    [num(targetBlock)],
  );
  for (const row of orphaned.rows) {
    await client.query(
      `UPDATE creators SET tokens_created = GREATEST(tokens_created - 1, 0) WHERE address = $1`,
      [row.creator],
    );
  }

  const orphanedAddresses = new Set(orphaned.rows.map((row) => row.address));
  for (const row of affected.rows) {
    if (orphanedAddresses.has(row.token)) continue;
    await recomputeToken(client, row.token);
  }

  await client.query(`DELETE FROM blocks WHERE number > $1`, [num(targetBlock)]);

  logger.warn("Rollback complete", {
    targetBlock,
    tokensRebuilt: affected.rows.length,
    tokensRemoved: orphaned.rows.length,
  });
}

/** Rebuilds every cached column of one token from its surviving event rows. */
export async function recomputeToken(client: PoolClient, token: string): Promise<void> {
  const tokenRow = await client.query<{
    total_supply: string;
    initial_virtual_eth: string;
    initial_virtual_tokens: string;
  }>(
    `SELECT total_supply, initial_virtual_eth, initial_virtual_tokens
       FROM tokens WHERE address = $1`,
    [token],
  );
  if (tokenRow.rowCount === 0) return;

  const totalSupply = BigInt(tokenRow.rows[0].total_supply);
  const initialVirtualEth = BigInt(tokenRow.rows[0].initial_virtual_eth);
  const initialVirtualTokens = BigInt(tokenRow.rows[0].initial_virtual_tokens);

  const aggregates = await client.query<{
    trade_count: string;
    buy_count: string;
    sell_count: string;
    volume_eth: string;
    buy_volume_eth: string;
    sell_volume_eth: string;
    tokens_bought: string;
    tokens_sold: string;
    fees_eth: string;
    last_trade_at: string | null;
  }>(
    `SELECT
        COUNT(*)                                                   AS trade_count,
        COUNT(*) FILTER (WHERE side = 0)                           AS buy_count,
        COUNT(*) FILTER (WHERE side = 1)                           AS sell_count,
        COALESCE(SUM(gross_eth), 0)                                AS volume_eth,
        COALESCE(SUM(gross_eth) FILTER (WHERE side = 0), 0)        AS buy_volume_eth,
        COALESCE(SUM(gross_eth) FILTER (WHERE side = 1), 0)        AS sell_volume_eth,
        COALESCE(SUM(token_amount) FILTER (WHERE side = 0), 0)     AS tokens_bought,
        COALESCE(SUM(token_amount) FILTER (WHERE side = 1), 0)     AS tokens_sold,
        COALESCE(SUM(fee), 0)                                      AS fees_eth,
        MAX(timestamp)                                             AS last_trade_at
       FROM trades WHERE token = $1`,
    [token],
  );

  /**
   * The all-time-high market cap, rebuilt rather than carried.
   *
   * Everywhere else it is maintained with `GREATEST`, which by construction never decreases —
   * correct while the chain only moves forward, and wrong the moment a reorg removes the trades
   * that set the high. Recomputing it here from the surviving `price_points` is what keeps the
   * high-water mark a *derived* value like every other field below the schema's "derived" line,
   * rather than a fact the rollback cannot reach.
   */
  const ath = await client.query<{ ath: string | null }>(
    `SELECT MAX(market_cap) AS ath FROM price_points WHERE token = $1`,
    [token],
  );

  const latest = await client.query<{
    price: string;
    eth_reserve: string;
    virtual_eth_reserve: string;
    token_reserve: string;
    block_number: string;
  }>(
    `SELECT price, eth_reserve, virtual_eth_reserve, token_reserve, block_number
       FROM trades WHERE token = $1
      ORDER BY block_number DESC, log_index DESC LIMIT 1`,
    [token],
  );

  const migration = await client.query<{
    completed_at: string | null;
    triggered_at: string | null;
    pair: string | null;
    tokens_burned: string | null;
    opening_price: string | null;
    completed_at_block: string | null;
  }>(
    `SELECT completed_at, triggered_at, pair, tokens_burned, opening_price, completed_at_block
       FROM migrations WHERE token = $1`,
    [token],
  );

  const agg = aggregates.rows[0];
  const migrated = migration.rows[0]?.completed_at != null;
  const triggered = migration.rows[0]?.triggered_at != null;

  let status: number = TokenStatus.Trading;
  if (migrated) status = TokenStatus.Migrated;
  else if (triggered) status = TokenStatus.PendingMigration;

  let price: bigint;
  let ethReserve: bigint;
  let virtualEthReserve: bigint;
  let tokenReserve: bigint;
  let circulating: bigint;

  if (migrated) {
    price = BigInt(migration.rows[0].opening_price ?? "0");
    ethReserve = 0n;
    virtualEthReserve = 0n;
    tokenReserve = 0n;
    circulating = totalSupply - BigInt(migration.rows[0].tokens_burned ?? "0");
  } else if (latest.rowCount && latest.rowCount > 0) {
    price = BigInt(latest.rows[0].price);
    ethReserve = BigInt(latest.rows[0].eth_reserve);
    virtualEthReserve = BigInt(latest.rows[0].virtual_eth_reserve);
    tokenReserve = BigInt(latest.rows[0].token_reserve);
    circulating = totalSupply - tokenReserve;
  } else {
    // No surviving trades — back to genesis.
    price =
      initialVirtualTokens === 0n
        ? 0n
        : (initialVirtualEth * PROTOCOL.priceUnit) / initialVirtualTokens;
    ethReserve = 0n;
    virtualEthReserve = initialVirtualEth;
    tokenReserve = initialVirtualTokens;
    circulating = 0n;
  }

  await client.query(
    `UPDATE tokens SET
        status                 = $2,
        eth_reserve            = $3,
        virtual_eth_reserve    = $4,
        token_reserve          = $5,
        price                  = $6,
        market_cap             = $7,
        ath_market_cap         = $22,
        fdv                    = $8,
        migration_progress_bps = $9,
        volume_eth             = $10,
        buy_volume_eth         = $11,
        sell_volume_eth        = $12,
        tokens_bought          = $13,
        tokens_sold            = $14,
        fees_eth               = $15,
        trade_count            = $16,
        buy_count              = $17,
        sell_count             = $18,
        last_trade_at          = $19,
        pair                   = $20,
        migrated_at            = $21
      WHERE address = $1`,
    [
      token,
      status,
      num(ethReserve),
      num(virtualEthReserve),
      num(tokenReserve),
      num(price),
      num((price * circulating) / PROTOCOL.priceUnit),
      num((price * totalSupply) / PROTOCOL.priceUnit),
      Number((ethReserve * 10_000n) / PROTOCOL.migrationThreshold),
      agg.volume_eth,
      agg.buy_volume_eth,
      agg.sell_volume_eth,
      agg.tokens_bought,
      agg.tokens_sold,
      agg.fees_eth,
      Number(agg.trade_count),
      Number(agg.buy_count),
      Number(agg.sell_count),
      agg.last_trade_at,
      migration.rows[0]?.pair ?? null,
      migration.rows[0]?.completed_at ?? null,
      ath.rows[0]?.ath ?? "0",
    ],
  );

  await rebuildCandles(client, token);
  await rebuildHolders(client, token);
}

/**
 * Recreates all OHLCV buckets for a token from its surviving price_points.
 *
 * Must produce byte-identical buckets to the incremental path in `handlers.ts:updateCandles`,
 * which means a bucket opens at the price *before* its first trade — `LAG` over the token's whole
 * price history, not the first price inside the bucket. Taking the first price inside the bucket
 * (what this did originally) drops the move that carried the price into the bucket, so an
 * isolated trade becomes a flat O=H=L=C doji and short intervals show no price action at all.
 *
 * The very first trade of a token has no predecessor, so it falls back to the genesis price
 * derived from the token's initial virtual reserves — the same value the subgraph seeds
 * `token.price` with at creation, so both back-ends agree on the opening candle too.
 */
async function rebuildCandles(client: PoolClient, token: string): Promise<void> {
  await client.query(`DELETE FROM candles WHERE token = $1`, [token]);

  for (const interval of CANDLE_INTERVALS) {
    await client.query(
      `WITH genesis AS (
          SELECT initial_virtual_eth * 1000000000000000000::numeric
                 / NULLIF(initial_virtual_tokens, 0)                               AS price
            FROM tokens
           WHERE address = $1
       ),
       points AS (
          SELECT
             token, price, volume_eth, block_number, log_index, timestamp,
             COALESCE(
               LAG(price) OVER (ORDER BY block_number, log_index),
               (SELECT price FROM genesis),
               price
             )                                                                     AS prev_price
            FROM price_points
           WHERE token = $1
       ),
       buckets AS (
          SELECT
             token,
             (timestamp / $2::bigint) * $2::bigint                                 AS bucket_start,
             (ARRAY_AGG(prev_price ORDER BY block_number, log_index))[1]           AS open,
             MAX(price)                                                            AS high,
             MIN(price)                                                            AS low,
             (ARRAY_AGG(price ORDER BY block_number DESC, log_index DESC))[1]      AS close,
             SUM(volume_eth)                                                       AS volume_eth,
             COUNT(*)                                                              AS trade_count,
             MAX(block_number)                                                     AS last_block
            FROM points
           GROUP BY token, bucket_start
       )
       INSERT INTO candles (
          token, interval_secs, bucket_start, open, high, low, close,
          volume_eth, trade_count, last_block
       )
       SELECT
          token,
          $2::int,
          bucket_start,
          open,
          GREATEST(high, open),
          LEAST(low, open),
          close,
          volume_eth,
          trade_count,
          last_block
        FROM buckets`,
      [token, interval],
    );
  }
}

/** Replays surviving transfers to rebuild exact balances. */
async function rebuildHolders(client: PoolClient, token: string): Promise<void> {
  await client.query(`DELETE FROM holders WHERE token = $1`, [token]);

  await client.query(
    `INSERT INTO holders (token, address, balance, first_seen_at, last_seen_at)
     SELECT token, address, SUM(delta), MIN(timestamp), MAX(timestamp)
       FROM (
            SELECT token, to_address   AS address,  amount AS delta, timestamp
              FROM transfers WHERE token = $1 AND to_address   <> $2
            UNION ALL
            SELECT token, from_address AS address, -amount AS delta, timestamp
              FROM transfers WHERE token = $1 AND from_address <> $2
       ) movements
      GROUP BY token, address`,
    [token, PROTOCOL.zeroAddress],
  );

  await refreshHolderCount(client, token);
}
