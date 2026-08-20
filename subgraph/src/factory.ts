import { BigInt, Bytes, ethereum, log } from "@graphprotocol/graph-ts";

import {
  LiquidityMigrated,
  MigrationTriggered,
  PlatformFeeCollected,
  TokenBought,
  TokenCreated,
  TokenSold,
} from "../generated/PumperFactory/PumperFactory";
import { PumperToken as PumperTokenTemplate } from "../generated/templates";
import {
  Account,
  Candle,
  Creator,
  Migration,
  PlatformFee,
  PricePoint,
  Protocol,
  Token,
  Trade,
} from "../generated/schema";
import {
  BPS,
  CANDLE_INTERVALS,
  PRICE_UNIT,
  PROTOCOL_ID,
  STATUS_MIGRATED,
  STATUS_PENDING_MIGRATION,
  STATUS_TRADING,
  ZERO,
  valuation,
} from "./constants";

// =============================================================================================
// Helpers
// =============================================================================================

function eventId(event: ethereum.Event): string {
  return event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
}

function loadProtocol(): Protocol {
  let protocol = Protocol.load(PROTOCOL_ID);
  if (protocol == null) {
    protocol = new Protocol(PROTOCOL_ID);
    protocol.factory = Bytes.empty();
    protocol.tokenCount = 0;
    protocol.migratedCount = 0;
    protocol.tradeCount = 0;
    protocol.totalVolumeEth = ZERO;
    protocol.totalFeesEth = ZERO;
    protocol.totalEthLocked = ZERO;
    protocol.totalSupplyPerToken = ZERO;
    protocol.virtualEthReserve = ZERO;
    protocol.migrationThreshold = ZERO;
  }
  return protocol as Protocol;
}

/**
 * Load-or-create the {@link Account} for an address.
 *
 * Counters live on the entity so a profile page is a single query. The alternative — fetching a
 * page of trades and counting client-side — is both wrong past the page limit and needlessly
 * expensive for a number the mapping already has in hand.
 *
 * Also created in src/token.ts on the first Transfer, so the two must agree on defaults.
 */
function loadAccount(address: Bytes, timestamp: BigInt): Account {
  let account = Account.load(address.toHexString());
  if (account == null) {
    account = new Account(address.toHexString());
    account.address = address;
    account.positionCount = 0;
    account.tokensCreated = 0;
    account.tradeCount = 0;
    account.volumeEth = ZERO;
    account.firstSeenAt = timestamp;
  }
  account.lastSeenAt = timestamp;
  return account as Account;
}

function loadCreator(address: Bytes, timestamp: BigInt): Creator {
  let creator = Creator.load(address.toHexString());
  if (creator == null) {
    creator = new Creator(address.toHexString());
    creator.address = address;
    creator.tokensCreated = 0;
    creator.tokensMigrated = 0;
    creator.firstSeenAt = timestamp;
  }
  creator.lastSeenAt = timestamp;
  return creator as Creator;
}

/**
 * Updates the OHLCV bucket for every configured interval.
 *
 * A new bucket **opens at `priceBefore`** — the price the market was at before this trade — not
 * at the trade's own resulting price. That is what makes the series continuous: `open[n]` equals
 * `close[n-1]`, so a move is drawn by the candle it happens in.
 *
 * Opening at the post-trade price instead produces a chart that silently hides most price action.
 * A bucket whose only trade moved the price 0.749 → 0.500 gwei records O=H=L=C=0.500 — a flat
 * doji — because the 0.749 side of the move belongs to the previous bucket. Every isolated trade
 * renders as a flat line and only the coarsest interval, where several trades share one bucket,
 * shows any movement at all. That was a real bug: on a live token the 1D candle showed a dump the
 * 1m/5m/15m/1H/4H candles all rendered flat.
 *
 * `high`/`low` must span the open as well, or the bucket can report `high < open`, which is not a
 * valid candle and renders incorrectly.
 */
function updateCandles(
  tokenId: string,
  timestamp: BigInt,
  priceBefore: BigInt,
  price: BigInt,
  volume: BigInt,
): void {
  for (let i = 0; i < CANDLE_INTERVALS.length; i++) {
    const interval = CANDLE_INTERVALS[i];
    const intervalBig = BigInt.fromI32(interval);
    const bucket = timestamp.div(intervalBig).times(intervalBig);
    const id = tokenId + "-" + interval.toString() + "-" + bucket.toString();

    let candle = Candle.load(id);
    if (candle == null) {
      candle = new Candle(id);
      candle.token = tokenId;
      candle.intervalSecs = interval;
      candle.bucketStart = bucket;
      candle.open = priceBefore;
      candle.high = priceBefore;
      candle.low = priceBefore;
      candle.volumeEth = ZERO;
      candle.tradeCount = 0;
    }

    if (price.gt(candle.high)) candle.high = price;
    if (price.lt(candle.low)) candle.low = price;
    candle.close = price;
    candle.volumeEth = candle.volumeEth.plus(volume);
    candle.tradeCount = candle.tradeCount + 1;
    candle.save();
  }
}

/**
 * Applies the post-trade curve state carried by the event. Nothing here is simulated — every
 * value is read straight off the log, which is the whole point of the event design.
 */
function applyTradeState(
  token: Token,
  price: BigInt,
  ethReserve: BigInt,
  virtualEthReserve: BigInt,
  tokenReserve: BigInt,
  timestamp: BigInt,
): void {
  token.price = price;
  token.ethReserve = ethReserve;
  token.virtualEthReserve = virtualEthReserve;
  token.tokenReserve = tokenReserve;
  token.virtualTokenReserve = tokenReserve;
  token.circulatingSupply = token.totalSupply.minus(tokenReserve);
  token.marketCap = valuation(price, token.circulatingSupply);
  // High-water mark, so a card can show what a token was worth at its peak and not just now.
  if (token.marketCap.gt(token.athMarketCap)) {
    token.athMarketCap = token.marketCap;
  }
  token.fullyDilutedValuation = valuation(price, token.totalSupply);
  token.migrationProgressBps = ethReserve
    .times(BPS)
    .div(token.migrationThreshold)
    .toI32();
  token.lastTradeAt = timestamp;
}

function writePricePoint(
  event: ethereum.Event,
  token: Token,
  price: BigInt,
  ethReserve: BigInt,
  tokenReserve: BigInt,
  volume: BigInt,
  timestamp: BigInt,
): void {
  const point = new PricePoint(eventId(event));
  point.token = token.id;
  point.price = price;
  point.ethReserve = ethReserve;
  point.tokenReserve = tokenReserve;
  point.marketCap = token.marketCap;
  point.volumeEth = volume;
  point.blockNumber = event.block.number;
  point.timestamp = timestamp;
  point.save();
}

// =============================================================================================
// TokenCreated
// =============================================================================================

export function handleTokenCreated(event: TokenCreated): void {
  const tokenId = event.params.token.toHexString();

  const creator = loadCreator(event.params.creator, event.params.timestamp);
  creator.tokensCreated = creator.tokensCreated + 1;
  creator.save();

  const creatorAccount = loadAccount(event.params.creator, event.params.timestamp);
  creatorAccount.tokensCreated = creatorAccount.tokensCreated + 1;
  creatorAccount.save();

  const token = new Token(tokenId);
  token.address = event.params.token;
  token.creator = creator.id;
  token.name = event.params.name;
  token.symbol = event.params.symbol;
  token.decimals = 18;

  token.totalSupply = event.params.totalSupply;
  token.initialVirtualEthReserve = event.params.virtualEthReserve;
  token.initialVirtualTokenReserve = event.params.virtualTokenReserve;
  token.migrationThreshold = event.params.migrationThreshold;

  token.createdAt = event.params.timestamp;
  token.createdAtBlock = event.block.number;
  token.createdAtTx = event.transaction.hash;

  token.status = STATUS_TRADING;
  token.ethReserve = ZERO;
  token.virtualEthReserve = event.params.virtualEthReserve;
  token.tokenReserve = event.params.virtualTokenReserve;
  token.virtualTokenReserve = event.params.virtualTokenReserve;
  token.price = event.params.virtualTokenReserve.equals(ZERO)
    ? ZERO
    : event.params.virtualEthReserve.times(PRICE_UNIT).div(event.params.virtualTokenReserve);
  token.circulatingSupply = ZERO;
  token.marketCap = ZERO;
  token.athMarketCap = ZERO;
  token.fullyDilutedValuation = valuation(token.price, token.totalSupply);
  token.migrationProgressBps = 0;

  token.volumeEth = ZERO;
  token.buyVolumeEth = ZERO;
  token.sellVolumeEth = ZERO;
  token.tokensBought = ZERO;
  token.tokensSold = ZERO;
  token.feesEth = ZERO;
  token.tradeCount = 0;
  token.buyCount = 0;
  token.sellCount = 0;
  token.holderCount = 0;
  token.save();

  // Start tracking this token's ERC-20 transfers for holder balances.
  PumperTokenTemplate.create(event.params.token);

  const protocol = loadProtocol();
  protocol.factory = event.address;
  protocol.tokenCount = protocol.tokenCount + 1;
  protocol.totalSupplyPerToken = event.params.totalSupply;
  protocol.virtualEthReserve = event.params.virtualEthReserve;
  protocol.migrationThreshold = event.params.migrationThreshold;
  protocol.save();
}

// =============================================================================================
// TokenBought
// =============================================================================================

export function handleTokenBought(event: TokenBought): void {
  const tokenId = event.params.token.toHexString();
  const token = Token.load(tokenId);
  if (token == null) {
    log.warning("TokenBought for unknown token {}", [tokenId]);
    return;
  }

  // Read before applyTradeState overwrites it — a new candle opens here (see updateCandles).
  const priceBefore = token.price;

  applyTradeState(
    token,
    event.params.tokenPrice,
    event.params.ethReserve,
    event.params.virtualEthReserve,
    event.params.tokenReserve,
    event.params.timestamp,
  );

  token.volumeEth = token.volumeEth.plus(event.params.ethAfterFee);
  token.buyVolumeEth = token.buyVolumeEth.plus(event.params.ethAfterFee);
  token.tokensBought = token.tokensBought.plus(event.params.tokensOut);
  token.feesEth = token.feesEth.plus(event.params.fee);
  token.tradeCount = token.tradeCount + 1;
  token.buyCount = token.buyCount + 1;
  token.save();

  const trade = new Trade(eventId(event));
  trade.token = token.id;
  trade.trader = event.params.buyer;
  trade.side = "BUY";
  trade.ethIn = event.params.ethIn;
  trade.ethOut = ZERO;
  trade.grossEth = event.params.ethAfterFee;
  trade.fee = event.params.fee;
  trade.tokenAmount = event.params.tokensOut;
  trade.price = event.params.tokenPrice;
  trade.executionPrice = event.params.tokensOut.equals(ZERO)
    ? ZERO
    : event.params.ethIn.times(PRICE_UNIT).div(event.params.tokensOut);
  trade.ethReserve = event.params.ethReserve;
  trade.virtualEthReserve = event.params.virtualEthReserve;
  trade.tokenReserve = event.params.tokenReserve;
  trade.blockNumber = event.block.number;
  trade.timestamp = event.params.timestamp;
  trade.transactionHash = event.transaction.hash;
  trade.logIndex = event.logIndex;
  trade.save();

  writePricePoint(
    event,
    token,
    event.params.tokenPrice,
    event.params.ethReserve,
    event.params.tokenReserve,
    event.params.ethAfterFee,
    event.params.timestamp,
  );
  updateCandles(
    token.id,
    event.params.timestamp,
    priceBefore,
    event.params.tokenPrice,
    event.params.ethAfterFee,
  );

  const buyer = loadAccount(event.params.buyer, event.params.timestamp);
  buyer.tradeCount = buyer.tradeCount + 1;
  buyer.volumeEth = buyer.volumeEth.plus(event.params.ethAfterFee);
  buyer.save();

  const protocol = loadProtocol();
  protocol.tradeCount = protocol.tradeCount + 1;
  protocol.totalVolumeEth = protocol.totalVolumeEth.plus(event.params.ethAfterFee);
  protocol.totalFeesEth = protocol.totalFeesEth.plus(event.params.fee);
  protocol.totalEthLocked = protocol.totalEthLocked.plus(event.params.ethAfterFee);
  protocol.save();
}

// =============================================================================================
// TokenSold
// =============================================================================================

export function handleTokenSold(event: TokenSold): void {
  const tokenId = event.params.token.toHexString();
  const token = Token.load(tokenId);
  if (token == null) {
    log.warning("TokenSold for unknown token {}", [tokenId]);
    return;
  }

  // Read before applyTradeState overwrites it — a new candle opens here (see updateCandles).
  const priceBefore = token.price;

  applyTradeState(
    token,
    event.params.tokenPrice,
    event.params.ethReserve,
    event.params.virtualEthReserve,
    event.params.tokenReserve,
    event.params.timestamp,
  );

  token.volumeEth = token.volumeEth.plus(event.params.grossEthOut);
  token.sellVolumeEth = token.sellVolumeEth.plus(event.params.grossEthOut);
  token.tokensSold = token.tokensSold.plus(event.params.tokensIn);
  token.feesEth = token.feesEth.plus(event.params.fee);
  token.tradeCount = token.tradeCount + 1;
  token.sellCount = token.sellCount + 1;
  token.save();

  const trade = new Trade(eventId(event));
  trade.token = token.id;
  trade.trader = event.params.seller;
  trade.side = "SELL";
  trade.ethIn = ZERO;
  trade.ethOut = event.params.ethOut;
  trade.grossEth = event.params.grossEthOut;
  trade.fee = event.params.fee;
  trade.tokenAmount = event.params.tokensIn;
  trade.price = event.params.tokenPrice;
  trade.executionPrice = event.params.tokensIn.equals(ZERO)
    ? ZERO
    : event.params.ethOut.times(PRICE_UNIT).div(event.params.tokensIn);
  trade.ethReserve = event.params.ethReserve;
  trade.virtualEthReserve = event.params.virtualEthReserve;
  trade.tokenReserve = event.params.tokenReserve;
  trade.blockNumber = event.block.number;
  trade.timestamp = event.params.timestamp;
  trade.transactionHash = event.transaction.hash;
  trade.logIndex = event.logIndex;
  trade.save();

  writePricePoint(
    event,
    token,
    event.params.tokenPrice,
    event.params.ethReserve,
    event.params.tokenReserve,
    event.params.grossEthOut,
    event.params.timestamp,
  );
  updateCandles(
    token.id,
    event.params.timestamp,
    priceBefore,
    event.params.tokenPrice,
    event.params.grossEthOut,
  );

  const seller = loadAccount(event.params.seller, event.params.timestamp);
  seller.tradeCount = seller.tradeCount + 1;
  seller.volumeEth = seller.volumeEth.plus(event.params.grossEthOut);
  seller.save();

  const protocol = loadProtocol();
  protocol.tradeCount = protocol.tradeCount + 1;
  protocol.totalVolumeEth = protocol.totalVolumeEth.plus(event.params.grossEthOut);
  protocol.totalFeesEth = protocol.totalFeesEth.plus(event.params.fee);
  protocol.totalEthLocked = protocol.totalEthLocked.minus(event.params.grossEthOut);
  protocol.save();
}

// =============================================================================================
// Migration
// =============================================================================================

export function handleMigrationTriggered(event: MigrationTriggered): void {
  const tokenId = event.params.token.toHexString();
  const token = Token.load(tokenId);
  if (token == null) return;

  token.status = STATUS_PENDING_MIGRATION;
  token.migrationProgressBps = 10000;
  token.save();

  let migration = Migration.load(tokenId);
  if (migration == null) {
    migration = new Migration(tokenId);
    migration.token = tokenId;
  }
  migration.triggeredAt = event.params.timestamp;
  migration.triggeredAtBlock = event.block.number;
  migration.triggeredEthReserve = event.params.ethReserve;
  migration.triggeredTokenReserve = event.params.tokenReserve;
  migration.save();
}

export function handleLiquidityMigrated(event: LiquidityMigrated): void {
  const tokenId = event.params.token.toHexString();
  const token = Token.load(tokenId);
  if (token == null) return;

  const openingPrice = event.params.tokenAmount.equals(ZERO)
    ? ZERO
    : event.params.ethAmount.times(PRICE_UNIT).div(event.params.tokenAmount);

  token.status = STATUS_MIGRATED;
  token.pair = event.params.pair;
  token.migratedAt = event.params.timestamp;
  token.ethReserve = ZERO;
  token.tokenReserve = ZERO;
  token.virtualEthReserve = ZERO;
  token.virtualTokenReserve = ZERO;
  token.price = openingPrice;
  token.circulatingSupply = token.totalSupply.minus(event.params.tokensBurned);
  token.marketCap = valuation(openingPrice, token.circulatingSupply);
  if (token.marketCap.gt(token.athMarketCap)) {
    token.athMarketCap = token.marketCap;
  }
  token.fullyDilutedValuation = valuation(openingPrice, token.totalSupply);
  token.save();

  let migration = Migration.load(tokenId);
  if (migration == null) {
    migration = new Migration(tokenId);
    migration.token = tokenId;
  }
  migration.pair = event.params.pair;
  migration.completedAt = event.params.timestamp;
  migration.completedAtBlock = event.block.number;
  migration.completedTx = event.transaction.hash;
  migration.ethDeposited = event.params.ethAmount;
  migration.tokensDeposited = event.params.tokenAmount;
  migration.tokensBurned = event.params.tokensBurned;
  migration.lpTokensBurned = event.params.lpTokensBurned;
  migration.openingPrice = openingPrice;
  migration.save();

  const creator = Creator.load(token.creator);
  if (creator != null) {
    creator.tokensMigrated = creator.tokensMigrated + 1;
    creator.save();
  }

  const protocol = loadProtocol();
  protocol.migratedCount = protocol.migratedCount + 1;
  protocol.totalEthLocked = protocol.totalEthLocked.minus(event.params.ethAmount);
  protocol.save();
}

// =============================================================================================
// PlatformFee
// =============================================================================================

export function handlePlatformFeeCollected(event: PlatformFeeCollected): void {
  const tokenId = event.params.token.toHexString();
  if (Token.load(tokenId) == null) return;

  const fee = new PlatformFee(eventId(event));
  fee.token = tokenId;
  fee.user = event.params.user;
  fee.action = event.params.action;
  fee.amount = event.params.amount;
  fee.blockNumber = event.block.number;
  fee.timestamp = event.params.timestamp;
  fee.transactionHash = event.transaction.hash;
  fee.save();
}
