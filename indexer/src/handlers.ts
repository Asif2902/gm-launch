import type { PoolClient } from "pg";

import { CANDLE_INTERVALS, PROTOCOL, TokenStatus, config } from "./config";
import { num } from "./db";
import { logger } from "./logger";

export interface EventContext {
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
  timestamp: bigint;
}

const Side = { Buy: 0, Sell: 1 } as const;

// =============================================================================================
// Derived-value helpers — kept in one place so the API, the chart and the DB agree exactly.
// =============================================================================================

/** Valuation of `supply` base units at `price` (wei per whole token). */
function valuation(price: bigint, supply: bigint): bigint {
  return (price * supply) / PROTOCOL.priceUnit;
}

function progressBps(ethReserve: bigint): number {
  return Number((ethReserve * 10_000n) / PROTOCOL.migrationThreshold);
}

/**
 * Realised price the trader experienced, wei per whole token.
 * Buys include the fee they paid; sells are net of the fee deducted. Both are computable from
 * the event alone — this column just saves every consumer from redoing it.
 */
function executionPrice(ethAmount: bigint, tokenAmount: bigint): bigint {
  return tokenAmount === 0n ? 0n : (ethAmount * PROTOCOL.priceUnit) / tokenAmount;
}

// =============================================================================================
// TokenCreated
// =============================================================================================

export async function handleTokenCreated(
  client: PoolClient,
  args: {
    token: string;
    creator: string;
    name: string;
    symbol: string;
    totalSupply: bigint;
    virtualEthReserve: bigint;
    virtualTokenReserve: bigint;
    migrationThreshold: bigint;
    timestamp: bigint;
  },
  ctx: EventContext,
): Promise<void> {
  const token = args.token.toLowerCase();
  const creator = args.creator.toLowerCase();

  await client.query(
    `INSERT INTO creators (address, tokens_created, first_seen_at, last_seen_at)
     VALUES ($1, 1, $2, $2)
     ON CONFLICT (address) DO UPDATE
       SET tokens_created = creators.tokens_created + 1,
           last_seen_at   = EXCLUDED.last_seen_at`,
    [creator, num(args.timestamp)],
  );

  const genesisPrice =
    args.virtualTokenReserve === 0n
      ? 0n
      : (args.virtualEthReserve * PROTOCOL.priceUnit) / args.virtualTokenReserve;

  await client.query(
    `INSERT INTO tokens (
        address, creator, name, symbol,
        total_supply, initial_virtual_eth, initial_virtual_tokens, migration_threshold,
        created_at, created_at_block, created_at_tx,
        status, eth_reserve, virtual_eth_reserve, token_reserve,
        price, market_cap, fdv, migration_progress_bps, updated_at_block
     ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11,
        $12, 0, $6, $7,
        $13, 0, $14, 0, $10
     )
     ON CONFLICT (address) DO NOTHING`,
    [
      token,
      creator,
      args.name,
      args.symbol,
      num(args.totalSupply),
      num(args.virtualEthReserve),
      num(args.virtualTokenReserve),
      num(args.migrationThreshold),
      num(args.timestamp),
      num(ctx.blockNumber),
      ctx.txHash,
      TokenStatus.Trading,
      num(genesisPrice),
      num(valuation(genesisPrice, args.totalSupply)),
    ],
  );

  logger.info("Token created", { token, symbol: args.symbol, block: ctx.blockNumber });
}

// =============================================================================================
// TokenBought / TokenSold
// =============================================================================================

export async function handleTokenBought(
  client: PoolClient,
  args: {
    token: string;
    buyer: string;
    ethIn: bigint;
    fee: bigint;
    ethAfterFee: bigint;
    tokensOut: bigint;
    tokenPrice: bigint;
    ethReserve: bigint;
    virtualEthReserve: bigint;
    tokenReserve: bigint;
    timestamp: bigint;
  },
  ctx: EventContext,
): Promise<void> {
  await recordTrade(
    client,
    {
      token: args.token.toLowerCase(),
      trader: args.buyer.toLowerCase(),
      side: Side.Buy,
      ethIn: args.ethIn,
      ethOut: 0n,
      grossEth: args.ethAfterFee,
      fee: args.fee,
      tokenAmount: args.tokensOut,
      price: args.tokenPrice,
      executionPrice: executionPrice(args.ethIn, args.tokensOut),
      ethReserve: args.ethReserve,
      virtualEthReserve: args.virtualEthReserve,
      tokenReserve: args.tokenReserve,
      timestamp: args.timestamp,
    },
    ctx,
  );
}

export async function handleTokenSold(
  client: PoolClient,
  args: {
    token: string;
    seller: string;
    tokensIn: bigint;
    grossEthOut: bigint;
    fee: bigint;
    ethOut: bigint;
    tokenPrice: bigint;
    ethReserve: bigint;
    virtualEthReserve: bigint;
    tokenReserve: bigint;
    timestamp: bigint;
  },
  ctx: EventContext,
): Promise<void> {
  await recordTrade(
    client,
    {
      token: args.token.toLowerCase(),
      trader: args.seller.toLowerCase(),
      side: Side.Sell,
      ethIn: 0n,
      ethOut: args.ethOut,
      grossEth: args.grossEthOut,
      fee: args.fee,
      tokenAmount: args.tokensIn,
      price: args.tokenPrice,
      executionPrice: executionPrice(args.ethOut, args.tokensIn),
      ethReserve: args.ethReserve,
      virtualEthReserve: args.virtualEthReserve,
      tokenReserve: args.tokenReserve,
      timestamp: args.timestamp,
    },
    ctx,
  );
}

interface TradeRecord {
  token: string;
  trader: string;
  side: number;
  ethIn: bigint;
  ethOut: bigint;
  grossEth: bigint;
  fee: bigint;
  tokenAmount: bigint;
  price: bigint;
  executionPrice: bigint;
  ethReserve: bigint;
  virtualEthReserve: bigint;
  tokenReserve: bigint;
  timestamp: bigint;
}

async function recordTrade(
  client: PoolClient,
  trade: TradeRecord,
  ctx: EventContext,
): Promise<void> {
  // ON CONFLICT DO NOTHING + RETURNING makes replaying a block range idempotent: if the trade
  // is already stored, no rows come back and none of the aggregates below are applied twice.
  const inserted = await client.query(
    `INSERT INTO trades (
        token, trader, side, eth_in, eth_out, gross_eth, fee, token_amount,
        price, execution_price, eth_reserve, virtual_eth_reserve, token_reserve,
        block_number, block_hash, tx_hash, log_index, timestamp
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (tx_hash, log_index) DO NOTHING
     RETURNING id`,
    [
      trade.token,
      trade.trader,
      trade.side,
      num(trade.ethIn),
      num(trade.ethOut),
      num(trade.grossEth),
      num(trade.fee),
      num(trade.tokenAmount),
      num(trade.price),
      num(trade.executionPrice),
      num(trade.ethReserve),
      num(trade.virtualEthReserve),
      num(trade.tokenReserve),
      num(ctx.blockNumber),
      ctx.blockHash,
      ctx.txHash,
      ctx.logIndex,
      num(trade.timestamp),
    ],
  );

  if (inserted.rowCount === 0) return;

  // `price` here is still the *pre-trade* price — the UPDATE below is what advances it. A new
  // candle opens at this value so the series stays continuous; see updateCandles.
  const tokenRow = await client.query<{ total_supply: string; price: string }>(
    `SELECT total_supply, price FROM tokens WHERE address = $1`,
    [trade.token],
  );
  const totalSupply = BigInt(tokenRow.rows[0]?.total_supply ?? PROTOCOL.totalSupply.toString());
  const priceBefore = BigInt(tokenRow.rows[0]?.price ?? trade.price.toString());

  const circulating = totalSupply - trade.tokenReserve;
  const marketCap = valuation(trade.price, circulating);
  const fdv = valuation(trade.price, totalSupply);

  await client.query(
    `INSERT INTO price_points (
        token, price, eth_reserve, token_reserve, market_cap, volume_eth,
        block_number, tx_hash, log_index, timestamp
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tx_hash, log_index) DO NOTHING`,
    [
      trade.token,
      num(trade.price),
      num(trade.ethReserve),
      num(trade.tokenReserve),
      num(marketCap),
      num(trade.grossEth),
      num(ctx.blockNumber),
      ctx.txHash,
      ctx.logIndex,
      num(trade.timestamp),
    ],
  );

  await client.query(
    `UPDATE tokens SET
        eth_reserve            = $2,
        virtual_eth_reserve    = $3,
        token_reserve          = $4,
        price                  = $5,
        market_cap             = $6,
        -- High-water mark. GREATEST rather than a conditional so it is a single atomic write and
        -- stays correct when trades for one token land out of order within a batch.
        ath_market_cap         = GREATEST(ath_market_cap, $6),
        fdv                    = $7,
        migration_progress_bps = $8,
        volume_eth             = volume_eth + $9,
        buy_volume_eth         = buy_volume_eth  + $10,
        sell_volume_eth        = sell_volume_eth + $11,
        tokens_bought          = tokens_bought + $12,
        tokens_sold            = tokens_sold   + $13,
        fees_eth               = fees_eth + $14,
        trade_count            = trade_count + 1,
        buy_count              = buy_count  + $15,
        sell_count             = sell_count + $16,
        last_trade_at          = $17,
        updated_at_block       = $18
     WHERE address = $1`,
    [
      trade.token,
      num(trade.ethReserve),
      num(trade.virtualEthReserve),
      num(trade.tokenReserve),
      num(trade.price),
      num(marketCap),
      num(fdv),
      progressBps(trade.ethReserve),
      num(trade.grossEth),
      num(trade.side === Side.Buy ? trade.grossEth : 0n),
      num(trade.side === Side.Sell ? trade.grossEth : 0n),
      num(trade.side === Side.Buy ? trade.tokenAmount : 0n),
      num(trade.side === Side.Sell ? trade.tokenAmount : 0n),
      num(trade.fee),
      trade.side === Side.Buy ? 1 : 0,
      trade.side === Side.Sell ? 1 : 0,
      num(trade.timestamp),
      num(ctx.blockNumber),
    ],
  );

  await updateCandles(
    client,
    trade.token,
    trade.timestamp,
    priceBefore,
    trade.price,
    trade.grossEth,
    ctx.blockNumber,
  );
}

/**
 * Incrementally maintains OHLCV buckets. Logs arrive in (block, logIndex) order, so `close`
 * always reflects the most recent trade in the bucket.
 *
 * A new bucket **opens at `priceBefore`**, the price before this trade — so `open[n]` equals
 * `close[n-1]` and a move is drawn by the candle it happens in. Opening at the trade's own
 * resulting price instead makes every isolated trade a flat doji (O=H=L=C), hiding the move
 * entirely at short intervals; only the coarsest interval, where several trades share a bucket,
 * shows anything. `high`/`low` therefore have to span the open too, or a bucket can report
 * `high < open`, which is not a valid candle.
 *
 * Mirrors `subgraph/src/factory.ts:updateCandles` — the two must agree bucket for bucket.
 */
async function updateCandles(
  client: PoolClient,
  token: string,
  timestamp: bigint,
  priceBefore: bigint,
  price: bigint,
  volume: bigint,
  blockNumber: bigint,
): Promise<void> {
  for (const interval of CANDLE_INTERVALS) {
    const bucket = (timestamp / BigInt(interval)) * BigInt(interval);
    await client.query(
      `INSERT INTO candles (
          token, interval_secs, bucket_start, open, high, low, close, volume_eth, trade_count, last_block
       ) VALUES ($1,$2,$3,$4,GREATEST($4,$5),LEAST($4,$5),$5,$6,1,$7)
       ON CONFLICT (token, interval_secs, bucket_start) DO UPDATE SET
          high        = GREATEST(candles.high, EXCLUDED.close),
          low         = LEAST(candles.low, EXCLUDED.close),
          close       = EXCLUDED.close,
          volume_eth  = candles.volume_eth + EXCLUDED.volume_eth,
          trade_count = candles.trade_count + 1,
          last_block  = EXCLUDED.last_block`,
      [token, interval, num(bucket), num(priceBefore), num(price), num(volume), num(blockNumber)],
    );
  }
}

// =============================================================================================
// Migration
// =============================================================================================

export async function handleMigrationTriggered(
  client: PoolClient,
  args: { token: string; ethReserve: bigint; tokenReserve: bigint; timestamp: bigint },
  ctx: EventContext,
): Promise<void> {
  const token = args.token.toLowerCase();

  await client.query(
    `INSERT INTO migrations (
        token, triggered_at, triggered_at_block, triggered_eth_reserve, triggered_token_reserve
     ) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (token) DO UPDATE SET
        triggered_at            = EXCLUDED.triggered_at,
        triggered_at_block      = EXCLUDED.triggered_at_block,
        triggered_eth_reserve   = EXCLUDED.triggered_eth_reserve,
        triggered_token_reserve = EXCLUDED.triggered_token_reserve`,
    [
      token,
      num(args.timestamp),
      num(ctx.blockNumber),
      num(args.ethReserve),
      num(args.tokenReserve),
    ],
  );

  await client.query(
    `UPDATE tokens
        SET status = $2, migration_progress_bps = 10000, updated_at_block = $3
      WHERE address = $1 AND status < $2`,
    [token, TokenStatus.PendingMigration, num(ctx.blockNumber)],
  );

  logger.info("Migration triggered", { token, block: ctx.blockNumber });
}

export async function handleLiquidityMigrated(
  client: PoolClient,
  args: {
    token: string;
    pair: string;
    ethAmount: bigint;
    tokenAmount: bigint;
    tokensBurned: bigint;
    lpTokensBurned: bigint;
    timestamp: bigint;
  },
  ctx: EventContext,
): Promise<void> {
  const token = args.token.toLowerCase();
  const pair = args.pair.toLowerCase();
  const openingPrice =
    args.tokenAmount === 0n ? 0n : (args.ethAmount * PROTOCOL.priceUnit) / args.tokenAmount;

  await client.query(
    `INSERT INTO migrations (
        token, pair, completed_at, completed_at_block, completed_tx,
        eth_deposited, tokens_deposited, tokens_burned, lp_tokens_burned, opening_price
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (token) DO UPDATE SET
        pair               = EXCLUDED.pair,
        completed_at       = EXCLUDED.completed_at,
        completed_at_block = EXCLUDED.completed_at_block,
        completed_tx       = EXCLUDED.completed_tx,
        eth_deposited      = EXCLUDED.eth_deposited,
        tokens_deposited   = EXCLUDED.tokens_deposited,
        tokens_burned      = EXCLUDED.tokens_burned,
        lp_tokens_burned   = EXCLUDED.lp_tokens_burned,
        opening_price      = EXCLUDED.opening_price`,
    [
      token,
      pair,
      num(args.timestamp),
      num(ctx.blockNumber),
      ctx.txHash,
      num(args.ethAmount),
      num(args.tokenAmount),
      num(args.tokensBurned),
      num(args.lpTokensBurned),
      num(openingPrice),
    ],
  );

  // The curve is closed: reserves go to zero and the pool price becomes the reference price.
  const rows = await client.query<{ total_supply: string }>(
    `SELECT total_supply FROM tokens WHERE address = $1`,
    [token],
  );
  const totalSupply = BigInt(rows.rows[0]?.total_supply ?? PROTOCOL.totalSupply.toString());
  const circulating = totalSupply - args.tokensBurned;

  await client.query(
    `UPDATE tokens SET
        status              = $2,
        pair                = $3,
        migrated_at         = $4,
        eth_reserve         = 0,
        token_reserve       = 0,
        virtual_eth_reserve = 0,
        price               = $5,
        market_cap          = $6,
        ath_market_cap      = GREATEST(ath_market_cap, $6),
        fdv                 = $7,
        updated_at_block    = $8
      WHERE address = $1`,
    [
      token,
      TokenStatus.Migrated,
      pair,
      num(args.timestamp),
      num(openingPrice),
      num(valuation(openingPrice, circulating)),
      num(valuation(openingPrice, totalSupply)),
      num(ctx.blockNumber),
    ],
  );

  await client.query(
    `UPDATE creators SET tokens_migrated = tokens_migrated + 1
      WHERE address = (SELECT creator FROM tokens WHERE address = $1)`,
    [token],
  );

  logger.info("Liquidity migrated", { token, pair, lpBurned: args.lpTokensBurned });
}

// =============================================================================================
// PlatformFee
// =============================================================================================

export async function handlePlatformFeeCollected(
  client: PoolClient,
  args: { token: string; user: string; action: number; amount: bigint; timestamp: bigint },
  ctx: EventContext,
): Promise<void> {
  await client.query(
    `INSERT INTO platform_fees (
        token, user_address, action, amount, block_number, tx_hash, log_index, timestamp
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tx_hash, log_index) DO NOTHING`,
    [
      args.token.toLowerCase(),
      args.user.toLowerCase(),
      args.action,
      num(args.amount),
      num(ctx.blockNumber),
      ctx.txHash,
      ctx.logIndex,
      num(args.timestamp),
    ],
  );
}

// =============================================================================================
// Holders (ERC-20 Transfer)
// =============================================================================================

export async function handleTransfer(
  client: PoolClient,
  token: string,
  args: { from: string; to: string; value: bigint },
  ctx: EventContext,
): Promise<void> {
  const tokenAddress = token.toLowerCase();
  const from = args.from.toLowerCase();
  const to = args.to.toLowerCase();

  const inserted = await client.query(
    `INSERT INTO transfers (
        token, from_address, to_address, amount, block_number, tx_hash, log_index, timestamp
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tx_hash, log_index) DO NOTHING
     RETURNING id`,
    [
      tokenAddress,
      from,
      to,
      num(args.value),
      num(ctx.blockNumber),
      ctx.txHash,
      ctx.logIndex,
      num(ctx.timestamp),
    ],
  );
  if (inserted.rowCount === 0) return;

  if (from !== PROTOCOL.zeroAddress) {
    await adjustBalance(client, tokenAddress, from, -args.value, ctx.timestamp);
  }
  if (to !== PROTOCOL.zeroAddress) {
    await adjustBalance(client, tokenAddress, to, args.value, ctx.timestamp);
  }

  await refreshHolderCount(client, tokenAddress);
}

async function adjustBalance(
  client: PoolClient,
  token: string,
  address: string,
  delta: bigint,
  timestamp: bigint,
): Promise<void> {
  await client.query(
    `INSERT INTO holders (token, address, balance, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$4)
     ON CONFLICT (token, address) DO UPDATE SET
        balance      = holders.balance + EXCLUDED.balance,
        last_seen_at = EXCLUDED.last_seen_at`,
    [token, address, num(delta), num(timestamp)],
  );
}

/**
 * Holder count excludes the launchpad (its balance is curve inventory, not a position), the
 * burn address and the zero address.
 */
export async function refreshHolderCount(client: PoolClient, token: string): Promise<void> {
  await client.query(
    `UPDATE tokens SET holder_count = (
        SELECT COUNT(*) FROM holders h
         WHERE h.token = $1
           AND h.balance > 0
           AND h.address <> ALL($2::text[])
     ) WHERE address = $1`,
    [token, EXCLUDED_HOLDERS],
  );
}

/** Addresses that hold tokens but are not "holders" for display purposes. */
const EXCLUDED_HOLDERS: string[] = [
  PROTOCOL.burnAddress,
  PROTOCOL.zeroAddress,
  config.factoryAddress.toLowerCase(),
];
