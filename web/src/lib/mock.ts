import type { PortfolioHolding } from "./apiTypes";
import type {
  IndexedCandle,
  IndexedHolder,
  IndexedMigration,
  IndexedToken,
  IndexedTrade,
  LeaderboardCreator,
  LeaderboardTrader,
  ProtocolStats,
} from "./types";

/**
 * ============================================================================================
 * Mock chain — demonstration data
 * ============================================================================================
 *
 * A self-contained simulation of the launchpad, used when no indexer is reachable (or when
 * VITE_DEMO_MODE=true) so the UI can be shown end-to-end without a deployment.
 *
 * It is not decorative noise: every token here is walked through the **real** bonding-curve
 * arithmetic from `BondingCurve.sol` — same constant product, same 0.5 ETH virtual reserve,
 * same 0.20%/0.30% fees, same 5 ETH threshold, same 1/11 surplus burn at migration. So the
 * charts show genuine curve behaviour (convex, accelerating into migration) rather than a
 * random walk that happens to look plausible.
 *
 * Everything is generated from a fixed seed, once, on first access. `tick()` then appends live
 * trades so the UI actually moves.
 */

// ---- protocol constants (mirrored from the contracts) ---------------------------------------

const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
const VIRTUAL_ETH = 5n * 10n ** 17n;
const MIGRATION_THRESHOLD = 5n * 10n ** 18n;
const BUY_FEE_BPS = 20n;
const SELL_FEE_BPS = 30n;
const BPS = 10_000n;
const PRICE_UNIT = 10n ** 18n;

// ---- curve math (identical to contracts/contracts/libraries/BondingCurve.sol) ----------------

const tokensOut = (ethIn: bigint, ethReserve: bigint, tokenReserve: bigint) =>
  ethIn === 0n ? 0n : (tokenReserve * ethIn) / (ethReserve + ethIn);

const ethOut = (tokensIn: bigint, ethReserve: bigint, tokenReserve: bigint) =>
  tokensIn === 0n ? 0n : (ethReserve * tokensIn) / (tokenReserve + tokensIn);

const spotPrice = (ethReserve: bigint, tokenReserve: bigint) =>
  tokenReserve === 0n ? 0n : (ethReserve * PRICE_UNIT) / tokenReserve;

const valuation = (price: bigint, supply: bigint) => (price * supply) / PRICE_UNIT;

// ---- deterministic PRNG (mulberry32) ---------------------------------------------------------

function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)];

const between = (random: () => number, min: number, max: number) => min + random() * (max - min);

function hexAddress(random: () => number): string {
  let out = "0x";
  for (let i = 0; i < 40; i++) out += "0123456789abcdef"[Math.floor(random() * 16)];
  return out;
}

// ---- flavour ---------------------------------------------------------------------------------

const TOKEN_IDEAS: Array<[string, string]> = [
  ["Base God", "BASEGOD"],
  ["Onchain Summer", "SUMMER"],
  ["Wen Lambo", "LAMBO"],
  ["Blue Pill", "BLUE"],
  ["Degen Ape Club", "DAPE"],
  ["Toshi The Cat", "TOSHI"],
  ["Gigachad Coin", "GIGA"],
  ["Moon Boi", "MOONBOI"],
  ["Based Pepe", "BPEPE"],
  ["Liquidity Wizard", "WIZARD"],
  ["Number Go Up", "NGU"],
  ["Rug Resistant", "NORUG"],
  ["Diamond Hands", "DIAMOND"],
  ["Exit Liquidity", "EXIT"],
  ["Bonding Curve Chad", "CURVE"],
  ["Probably Nothing", "NOTHING"],
  ["Ser Please", "SERPLS"],
  ["Higher Highs", "HIGHER"],
  ["Blue Chip Maxi", "MAXI"],
  ["Sepolia Whale", "WHALE"],
  ["Anon Capital", "ANON"],
  ["Full Port", "FULLPORT"],
  ["Cope Harder", "COPE"],
  ["Gm Every Day", "GM"],
  ["Send It", "SENDIT"],
  ["Last Buyer", "LASTBUY"],
  ["Infinite Money", "INFMONEY"],
  ["Touch Grass", "GRASS"],
];

// ---- internal model ---------------------------------------------------------------------------

interface MockTrade {
  trader: string;
  side: 0 | 1;
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
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
  timestamp: number;
}

interface MockToken {
  address: string;
  creator: string;
  name: string;
  symbol: string;
  createdAt: number;
  createdAtBlock: bigint;
  createdAtTx: string;

  status: 1 | 2 | 3;
  ethReserve: bigint;
  tokenReserve: bigint;

  athMarketCap: bigint;

  volumeEth: bigint;
  buyVolumeEth: bigint;
  sellVolumeEth: bigint;
  tokensBought: bigint;
  tokensSold: bigint;
  feesEth: bigint;
  buyCount: number;
  sellCount: number;

  trades: MockTrade[];
  balances: Map<string, bigint>;

  pair: string | null;
  migratedAt: number | null;
  tokensForPool: bigint;
  tokensBurned: bigint;
  lpBurned: bigint;
  openingPrice: bigint;
}

/** Descending-friendly comparison for decimal strings that may be negative (PnL). */
function compareBig(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left === right ? 0 : left > right ? 1 : -1;
}

// ---- generation ---------------------------------------------------------------------------------

const SEED = 0x9e3779b9;
const BLOCK_TIME = 2; // Base produces a block every ~2s

class MockChain {
  readonly tokens = new Map<string, MockToken>();
  private readonly traders: string[] = [];
  private order: string[] = [];
  private random = makeRandom(SEED);
  private headBlock = 0n;
  private listeners = new Set<() => void>();

  constructor() {
    const now = Math.floor(Date.now() / 1000);
    this.headBlock = 21_400_000n;

    for (let i = 0; i < 64; i++) this.traders.push(hexAddress(this.random));

    // Curve progress is deliberately shaped rather than uniform: a launchpad is mostly duds,
    // with a handful climbing and one or two that already graduated.
    const targets: number[] = [
      1.0, 1.0, 0.97, 0.93, 0.81, 0.74, 0.66, 0.58, 0.51, 0.44, 0.38, 0.33, 0.29, 0.25,
      0.21, 0.18, 0.15, 0.12, 0.1, 0.08, 0.065, 0.05, 0.04, 0.03, 0.022, 0.015, 0.009, 0.004,
    ];

    TOKEN_IDEAS.forEach(([name, symbol], index) => {
      const progress = targets[index] ?? 0.02;
      const token = this.createToken(name, symbol, progress, now, index);
      this.tokens.set(token.address, token);
      this.order.push(token.address);
    });

    // Newest first for the default discover ordering.
    this.order.sort((a, b) => this.tokens.get(b)!.createdAt - this.tokens.get(a)!.createdAt);
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Executes one live trade on a random active token, so the UI keeps moving. */
  tick(): void {
    const active = this.order.filter((address) => this.tokens.get(address)!.status === 1);
    if (active.length === 0) return;

    // Weight toward tokens with more momentum — hot tokens trade more.
    const weighted = active.filter(
      (address) => this.random() < 0.25 + Number(this.tokens.get(address)!.ethReserve) / 1e19,
    );
    const address = pick(this.random, weighted.length > 0 ? weighted : active);
    const token = this.tokens.get(address)!;

    const now = Math.floor(Date.now() / 1000);
    this.headBlock += 1n;

    const isBuy = this.random() < 0.62;
    if (isBuy) {
      const eth = BigInt(Math.floor(between(this.random, 0.004, 0.14) * 1e18));
      this.applyBuy(token, eth, now, this.headBlock);
    } else {
      const holders = [...token.balances.entries()].filter(([, balance]) => balance > 0n);
      if (holders.length === 0) return;
      const [holder, balance] = pick(this.random, holders);
      const portion = BigInt(Math.floor(between(this.random, 0.08, 0.5) * 1000));
      const amount = (balance * portion) / 1000n;
      if (amount > 0n) this.applySell(token, holder, amount, now, this.headBlock);
    }

    this.emit();
  }

  // ---- token construction -------------------------------------------------------------------

  private createToken(
    name: string,
    symbol: string,
    progress: number,
    now: number,
    index: number,
  ): MockToken {
    const ageSeconds = Math.floor(between(this.random, 900, 5 * 86_400) * (0.35 + progress));
    const createdAt = now - ageSeconds;

    const token: MockToken = {
      address: hexAddress(this.random),
      creator: pick(this.random, this.traders),
      name,
      symbol,
      createdAt,
      createdAtBlock: this.headBlock - BigInt(Math.floor(ageSeconds / BLOCK_TIME)),
      createdAtTx: `0x${hexAddress(this.random).slice(2)}${hexAddress(this.random).slice(2, 26)}`,
      status: 1,
      ethReserve: 0n,
      tokenReserve: TOTAL_SUPPLY,
      athMarketCap: 0n,
      volumeEth: 0n,
      buyVolumeEth: 0n,
      sellVolumeEth: 0n,
      tokensBought: 0n,
      tokensSold: 0n,
      feesEth: 0n,
      buyCount: 0,
      sellCount: 0,
      trades: [],
      balances: new Map(),
      pair: null,
      migratedAt: null,
      tokensForPool: 0n,
      tokensBurned: 0n,
      lpBurned: 0n,
      openingPrice: 0n,
    };

    this.simulateHistory(token, progress, createdAt, now, index);
    return token;
  }

  /**
   * Walks the token from launch to its target reserve with a plausible trade sequence.
   * Buys dominate but sells cluster after run-ups, which is what gives the chart its shape.
   */
  private simulateHistory(
    token: MockToken,
    progress: number,
    createdAt: number,
    now: number,
    index: number,
  ): void {
    const target = (MIGRATION_THRESHOLD * BigInt(Math.round(progress * 10_000))) / 10_000n;
    if (target === 0n) return;

    /**
     * Most tokens are walked *past* their target and then sold back down to it.
     *
     * Without this every token ends its history on the buy that reached the target, so its
     * current market cap is also its highest — and a feed where ATH equals MC on every card
     * makes a working column look broken. Real charts retrace: a coin that touched $80K and
     * settled at $30K is the ordinary case, and the gap between those two numbers is the whole
     * reason the card shows both.
     *
     * Tokens seeded at full progress are exempt: they have to land exactly on the threshold to
     * graduate, and overshooting would trip migration early.
     */
    const retracing = progress < 1 && this.random() < 0.7;
    const peak = retracing
      ? (target * BigInt(Math.round(between(this.random, 1.3, 3.2) * 1000))) / 1000n
      : target;

    // More trades for hotter tokens — enough density that 5m candles are near-contiguous.
    const tradeCount = Math.max(24, Math.floor(60 + progress * 620 + between(this.random, 0, 90)));
    const span = Math.max(600, now - createdAt - 30);

    let timestamp = createdAt + 5;
    let momentum = 0.72;

    for (let i = 0; i < tradeCount && token.ethReserve < peak; i++) {
      const elapsed = i / tradeCount;
      timestamp = Math.min(
        now - 5,
        createdAt + Math.floor(span * elapsed) + Math.floor(between(this.random, 1, 45)),
      );
      const block = token.createdAtBlock + BigInt(Math.floor((timestamp - createdAt) / BLOCK_TIME));

      // Momentum drifts, so buy pressure comes in waves instead of being uniformly random.
      momentum += between(this.random, -0.16, 0.15);
      momentum = Math.min(0.93, Math.max(0.42, momentum));

      const holders = [...token.balances.entries()].filter(([, balance]) => balance > 0n);
      const wantsSell = this.random() > momentum && holders.length > 3;

      if (wantsSell) {
        const [holder, balance] = pick(this.random, holders);
        const portion = BigInt(Math.floor(between(this.random, 0.1, 0.65) * 1000));
        const amount = (balance * portion) / 1000n;
        if (amount > 0n) this.applySell(token, holder, amount, timestamp, block);
        continue;
      }

      const remaining = peak - token.ethReserve;
      // Stop rather than emit a dust trade to close the last few wei of the gap — it would
      // show up as a real candle with essentially zero volume.
      if (remaining < 10n ** 13n) break;

      const stepsLeft = Math.max(1, tradeCount - i);
      // Average step aims at the target, with a fat tail so whale buys show up as green spikes.
      const average = Number(remaining) / stepsLeft;
      const whale = this.random() < 0.07 ? between(this.random, 3, 9) : 1;
      const size = BigInt(
        Math.max(1e14, Math.floor(average * between(this.random, 0.35, 2.1) * whale)),
      );

      this.applyBuy(token, size > remaining ? remaining : size, timestamp, block);
    }

    // The walk down from the peak, in a handful of sells rather than one — a single exit would
    // draw as a cliff, and the point of the retrace is that the chart shape stays plausible.
    if (retracing) {
      for (let i = 0; i < 40 && token.ethReserve > target; i++) {
        const holders = [...token.balances.entries()].filter(([, balance]) => balance > 0n);
        if (holders.length === 0) break;

        const [holder, balance] = pick(this.random, holders);
        const portion = BigInt(Math.floor(between(this.random, 0.25, 0.8) * 1000));
        const amount = (balance * portion) / 1000n;
        if (amount === 0n) continue;

        timestamp = Math.min(now - 2, timestamp + Math.floor(between(this.random, 20, 400)));
        const block = token.createdAtBlock + BigInt(Math.floor((timestamp - createdAt) / BLOCK_TIME));
        this.applySell(token, holder, amount, timestamp, block);
      }
    }

    // The two tokens seeded at 100% graduate all the way to Uniswap.
    if (progress >= 1) {
      this.applyBuy(token, MIGRATION_THRESHOLD - token.ethReserve, timestamp + 20, token.createdAtBlock + 1n);
      this.migrate(token, timestamp + 90, index);
    } else if (token.ethReserve >= MIGRATION_THRESHOLD) {
      token.status = 2;
    }
  }

  // ---- trade application (mirrors PumperFactory) ------------------------------------------------

  /**
   * Advances the high-water mark after a trade, mirroring what the indexer and subgraph do.
   *
   * Called from both sides of the curve because a sell moves the price too — just downward, which
   * is precisely the case a maximum has to ignore.
   */
  private trackAth(token: MockToken): void {
    const price = spotPrice(VIRTUAL_ETH + token.ethReserve, token.tokenReserve);
    const marketCap = valuation(price, TOTAL_SUPPLY - token.tokenReserve);
    if (marketCap > token.athMarketCap) token.athMarketCap = marketCap;
  }

  private applyBuy(token: MockToken, grossEthIn: bigint, timestamp: number, block: bigint): void {
    if (token.status !== 1 || grossEthIn <= 0n) return;

    let fee = (grossEthIn * BUY_FEE_BPS) / BPS;
    let netEth = grossEthIn - fee;
    let grossUsed = grossEthIn;

    // Threshold pinning: a buy can never push the curve past 5 ETH.
    const headroom = MIGRATION_THRESHOLD - token.ethReserve;
    if (netEth > headroom) {
      netEth = headroom;
      grossUsed = (netEth * BPS + (BPS - BUY_FEE_BPS) - 1n) / (BPS - BUY_FEE_BPS);
      if (grossUsed > grossEthIn) grossUsed = grossEthIn;
      fee = grossUsed - netEth;
    }
    if (netEth <= 0n) return;

    const virtualEth = VIRTUAL_ETH + token.ethReserve;
    const out = tokensOut(netEth, virtualEth, token.tokenReserve);
    if (out <= 0n) return;

    token.ethReserve += netEth;
    token.tokenReserve -= out;
    token.volumeEth += netEth;
    token.buyVolumeEth += netEth;
    token.tokensBought += out;
    token.feesEth += fee;
    token.buyCount += 1;

    const trader = pick(this.random, this.traders);
    token.balances.set(trader, (token.balances.get(trader) ?? 0n) + out);

    this.trackAth(token);

    const price = spotPrice(VIRTUAL_ETH + token.ethReserve, token.tokenReserve);
    token.trades.push({
      trader,
      side: 0,
      ethIn: grossUsed,
      ethOut: 0n,
      grossEth: netEth,
      fee,
      tokenAmount: out,
      price,
      executionPrice: (grossUsed * PRICE_UNIT) / out,
      ethReserve: token.ethReserve,
      virtualEthReserve: VIRTUAL_ETH + token.ethReserve,
      tokenReserve: token.tokenReserve,
      blockNumber: block,
      txHash: this.txHash(),
      logIndex: token.trades.length % 7,
      timestamp,
    });

    if (token.ethReserve >= MIGRATION_THRESHOLD) token.status = 2;
  }

  private applySell(
    token: MockToken,
    trader: string,
    tokensIn: bigint,
    timestamp: number,
    block: bigint,
  ): void {
    if (token.status !== 1 || tokensIn <= 0n) return;

    const virtualEth = VIRTUAL_ETH + token.ethReserve;
    const gross = ethOut(tokensIn, virtualEth, token.tokenReserve);
    if (gross <= 0n || gross > token.ethReserve) return;

    const fee = (gross * SELL_FEE_BPS) / BPS;
    const net = gross - fee;

    token.ethReserve -= gross;
    token.tokenReserve += tokensIn;
    token.volumeEth += gross;
    token.sellVolumeEth += gross;
    token.tokensSold += tokensIn;
    token.feesEth += fee;
    token.sellCount += 1;
    token.balances.set(trader, (token.balances.get(trader) ?? 0n) - tokensIn);

    this.trackAth(token);

    const price = spotPrice(VIRTUAL_ETH + token.ethReserve, token.tokenReserve);
    token.trades.push({
      trader,
      side: 1,
      ethIn: 0n,
      ethOut: net,
      grossEth: gross,
      fee,
      tokenAmount: tokensIn,
      price,
      executionPrice: (net * PRICE_UNIT) / tokensIn,
      ethReserve: token.ethReserve,
      virtualEthReserve: VIRTUAL_ETH + token.ethReserve,
      tokenReserve: token.tokenReserve,
      blockNumber: block,
      txHash: this.txHash(),
      logIndex: token.trades.length % 7,
      timestamp,
    });
  }

  /** Applies the same 1/11 surplus burn and pool sizing the migrator performs on-chain. */
  private migrate(token: MockToken, timestamp: number, index: number): void {
    const ethAmount = token.ethReserve;
    const tokenTotal = token.tokenReserve;
    const tokensForPool = (tokenTotal * ethAmount) / (VIRTUAL_ETH + ethAmount);

    token.tokensForPool = tokensForPool;
    token.tokensBurned = tokenTotal - tokensForPool;
    token.openingPrice = (ethAmount * PRICE_UNIT) / tokensForPool;
    token.lpBurned = BigInt(Math.floor(Math.sqrt(Number(ethAmount) * Number(tokensForPool)))) - 1000n;
    token.pair = hexAddress(makeRandom(SEED + index * 977));
    token.migratedAt = timestamp;
    token.status = 3;
    token.ethReserve = 0n;
    token.tokenReserve = 0n;
  }

  private txHash(): string {
    let out = "0x";
    for (let i = 0; i < 64; i++) out += "0123456789abcdef"[Math.floor(this.random() * 16)];
    return out;
  }

  // ---- read API (shaped exactly like the indexer's REST responses) ------------------------------

  list(): string[] {
    return this.order;
  }

  /** Every address that trades in the simulation — the population profiles are generated for. */
  accounts(): string[] {
    return this.traders;
  }

  toIndexed(token: MockToken): IndexedToken {
    const price =
      token.status === 3
        ? token.openingPrice
        : spotPrice(VIRTUAL_ETH + token.ethReserve, token.tokenReserve);

    const circulating =
      token.status === 3 ? TOTAL_SUPPLY - token.tokensBurned : TOTAL_SUPPLY - token.tokenReserve;

    const dayAgo = Math.floor(Date.now() / 1000) - 86_400;
    const recent = token.trades.filter((trade) => trade.timestamp >= dayAgo);
    const volume24h = recent.reduce((sum, trade) => sum + trade.grossEth, 0n);

    const holders = [...token.balances.values()].filter((balance) => balance > 0n).length;
    const last = token.trades[token.trades.length - 1];

    return {
      address: token.address,
      creator: token.creator,
      name: token.name,
      symbol: token.symbol,
      status: token.status,
      total_supply: TOTAL_SUPPLY.toString(),
      migration_threshold: MIGRATION_THRESHOLD.toString(),
      eth_reserve: token.ethReserve.toString(),
      virtual_eth_reserve: (VIRTUAL_ETH + token.ethReserve).toString(),
      token_reserve: token.tokenReserve.toString(),
      price: price.toString(),
      market_cap: valuation(price, circulating).toString(),
      ath_market_cap: token.athMarketCap.toString(),
      fdv: valuation(price, TOTAL_SUPPLY).toString(),
      migration_progress_bps: Number((token.ethReserve * BPS) / MIGRATION_THRESHOLD),
      volume_eth: token.volumeEth.toString(),
      buy_volume_eth: token.buyVolumeEth.toString(),
      sell_volume_eth: token.sellVolumeEth.toString(),
      tokens_bought: token.tokensBought.toString(),
      tokens_sold: token.tokensSold.toString(),
      fees_eth: token.feesEth.toString(),
      trade_count: token.trades.length,
      buy_count: token.buyCount,
      sell_count: token.sellCount,
      holder_count: holders,
      pair: token.pair,
      migrated_at: token.migratedAt ? String(token.migratedAt) : null,
      last_trade_at: last ? String(last.timestamp) : null,
      created_at: String(token.createdAt),
      created_at_block: token.createdAtBlock.toString(),
      created_at_tx: token.createdAtTx,
      volume_24h: volume24h.toString(),
      trades_24h: String(recent.length),
      traders_24h: String(new Set(recent.map((trade) => trade.trader)).size),
      high_24h: recent.length
        ? recent.reduce((max, t) => (t.price > max ? t.price : max), 0n).toString()
        : null,
      low_24h: recent.length
        ? recent.reduce((min, t) => (t.price < min ? t.price : min), recent[0].price).toString()
        : null,
      open_24h: recent.length ? recent[0].price.toString() : null,
      sparkline: token.trades.slice(-24).map((trade) => trade.price.toString()),
    };
  }

  toIndexedTrades(token: MockToken, limit: number): IndexedTrade[] {
    return token.trades
      .slice(-limit)
      .reverse()
      .map((trade) => ({
        token: token.address,
        trader: trade.trader,
        side: trade.side,
        eth_in: trade.ethIn.toString(),
        eth_out: trade.ethOut.toString(),
        gross_eth: trade.grossEth.toString(),
        fee: trade.fee.toString(),
        token_amount: trade.tokenAmount.toString(),
        price: trade.price.toString(),
        execution_price: trade.executionPrice.toString(),
        eth_reserve: trade.ethReserve.toString(),
        virtual_eth_reserve: trade.virtualEthReserve.toString(),
        token_reserve: trade.tokenReserve.toString(),
        block_number: trade.blockNumber.toString(),
        tx_hash: trade.txHash,
        log_index: trade.logIndex,
        timestamp: String(trade.timestamp),
      }));
  }

  /** Buckets the trade series into OHLCV exactly as the indexer's candle table does. */
  toCandles(token: MockToken, interval: number, limit: number): IndexedCandle[] {
    const buckets = new Map<number, IndexedCandle>();

    for (const trade of token.trades) {
      const start = Math.floor(trade.timestamp / interval) * interval;
      const existing = buckets.get(start);

      if (!existing) {
        buckets.set(start, {
          bucket_start: String(start),
          open: trade.price.toString(),
          high: trade.price.toString(),
          low: trade.price.toString(),
          close: trade.price.toString(),
          volume_eth: trade.grossEth.toString(),
          trade_count: 1,
        });
        continue;
      }

      if (trade.price > BigInt(existing.high)) existing.high = trade.price.toString();
      if (trade.price < BigInt(existing.low)) existing.low = trade.price.toString();
      existing.close = trade.price.toString();
      existing.volume_eth = (BigInt(existing.volume_eth) + trade.grossEth).toString();
      existing.trade_count += 1;
    }

    return [...buckets.values()]
      .sort((a, b) => Number(a.bucket_start) - Number(b.bucket_start))
      .slice(-limit);
  }

  toHolders(token: MockToken, limit: number): IndexedHolder[] {
    return [...token.balances.entries()]
      .filter(([, balance]) => balance > 0n)
      .sort((a, b) => (b[1] > a[1] ? 1 : -1))
      .slice(0, limit)
      .map(([address, balance]) => ({
        address,
        balance: balance.toString(),
        share_bps: ((balance * BPS) / TOTAL_SUPPLY).toString(),
        first_seen_at: String(token.createdAt),
        last_seen_at: String(token.trades[token.trades.length - 1]?.timestamp ?? token.createdAt),
      }));
  }

  toMigration(token: MockToken): IndexedMigration | null {
    if (token.status !== 3) return null;
    return {
      token: token.address,
      pair: token.pair,
      triggered_at: String(token.migratedAt),
      triggered_eth_reserve: MIGRATION_THRESHOLD.toString(),
      triggered_token_reserve: (token.tokensForPool + token.tokensBurned).toString(),
      completed_at: String(token.migratedAt),
      completed_tx: token.createdAtTx,
      eth_deposited: MIGRATION_THRESHOLD.toString(),
      tokens_deposited: token.tokensForPool.toString(),
      tokens_burned: token.tokensBurned.toString(),
      lp_tokens_burned: token.lpBurned.toString(),
      opening_price: token.openingPrice.toString(),
    };
  }

  stats(): ProtocolStats {
    const tokens = [...this.tokens.values()];
    const dayAgo = Math.floor(Date.now() / 1000) - 86_400;

    let volume = 0n;
    let fees = 0n;
    let locked = 0n;
    let trades = 0;
    let volume24h = 0n;

    for (const token of tokens) {
      volume += token.volumeEth;
      fees += token.feesEth;
      locked += token.ethReserve;
      trades += token.trades.length;
      for (const trade of token.trades) {
        if (trade.timestamp >= dayAgo) volume24h += trade.grossEth;
      }
    }

    return {
      tokens: String(tokens.length),
      migrated: String(tokens.filter((token) => token.status === 3).length),
      pending_migration: String(tokens.filter((token) => token.status === 2).length),
      total_volume_eth: volume.toString(),
      total_fees_eth: fees.toString(),
      total_eth_locked: locked.toString(),
      total_trades: String(trades),
      volume_24h: volume24h.toString(),
    };
  }

  /**
   * Everything a profile page needs about one address: what they hold, what they launched, and
   * what they've traded.
   *
   * On a real deployment this comes from the subgraph's `Account` entity (holdings are tracked
   * from ERC-20 Transfer logs, so they stay correct through peer-to-peer sends and
   * post-migration Uniswap activity). This is the same shape, computed locally.
   */
  portfolio(address: string): {
    holdings: PortfolioHolding[];
    created: string[];
    totalValueWei: bigint;
    tradeCount: number;
    volumeWei: bigint;
  } {
    const account = address.toLowerCase();
    const holdings: PortfolioHolding[] = [];
    const created: string[] = [];

    let totalValueWei = 0n;
    let tradeCount = 0;
    let volumeWei = 0n;

    for (const token of this.tokens.values()) {
      if (token.creator.toLowerCase() === account) created.push(token.address);

      for (const trade of token.trades) {
        if (trade.trader.toLowerCase() !== account) continue;
        tradeCount += 1;
        volumeWei += trade.grossEth;
      }

      const balance = token.balances.get(account) ?? 0n;
      if (balance <= 0n) continue;

      const price =
        token.status === 3
          ? token.openingPrice
          : spotPrice(VIRTUAL_ETH + token.ethReserve, token.tokenReserve);
      const value = (price * balance) / PRICE_UNIT;
      totalValueWei += value;

      holdings.push({
        token: token.address,
        name: token.name,
        symbol: token.symbol,
        status: token.status,
        balance: balance.toString(),
        price: price.toString(),
        valueWei: value.toString(),
        shareBps: Number((balance * BPS) / TOTAL_SUPPLY),
      });
    }

    holdings.sort((a, b) => (BigInt(b.valueWei) > BigInt(a.valueWei) ? 1 : -1));

    return { holdings, created, totalValueWei, tradeCount, volumeWei };
  }

  /**
   * Trader and creator rankings, mirroring the indexer's `/leaderboard` query — including its
   * one asymmetry: flows are windowed, holdings are current.
   */
  leaderboard(params: {
    board: "traders" | "creators";
    sort: string;
    window: string;
    limit: number;
  }): { entries: LeaderboardTrader[] | LeaderboardCreator[] } {
    const spans: Record<string, number | null> = {
      "24h": 86_400,
      "7d": 604_800,
      "30d": 2_592_000,
      all: null,
    };
    const span = params.window in spans ? spans[params.window] : spans["24h"];
    const since = span === null ? 0 : Math.floor(Date.now() / 1000) - span;

    if (params.board === "creators") {
      const byCreator = new Map<string, LeaderboardCreator>();

      for (const token of this.tokens.values()) {
        if (token.createdAt < since) continue;

        const indexed = this.toIndexed(token);
        const row = byCreator.get(token.creator) ?? {
          address: token.creator,
          tokens_created: 0,
          tokens_migrated: 0,
          volume: "0",
          market_cap: "0",
          fees: "0",
          trades: 0,
          holders: 0,
          last_created_at: null,
        };

        row.tokens_created += 1;
        if (token.status === 3) row.tokens_migrated += 1;
        row.volume = (BigInt(row.volume) + token.volumeEth).toString();
        row.market_cap = (BigInt(row.market_cap) + BigInt(indexed.market_cap)).toString();
        row.fees = (BigInt(row.fees) + token.feesEth).toString();
        row.trades += token.trades.length;
        row.holders += indexed.holder_count;
        row.last_created_at = String(
          Math.max(Number(row.last_created_at ?? 0), token.createdAt),
        );

        byCreator.set(token.creator, row);
      }

      const compare: Record<string, (a: LeaderboardCreator, b: LeaderboardCreator) => number> = {
        volume: (a, b) => compareBig(b.volume, a.volume),
        graduated: (a, b) =>
          b.tokens_migrated - a.tokens_migrated || b.tokens_created - a.tokens_created,
        tokens: (a, b) => b.tokens_created - a.tokens_created,
        marketCap: (a, b) => compareBig(b.market_cap, a.market_cap),
      };

      const entries = [...byCreator.values()]
        .sort(compare[params.sort] ?? compare.volume)
        .slice(0, params.limit);

      return { entries };
    }

    /**
     * The simulation fills in every field, including the cash-flow ones a subgraph-backed
     * deployment has to leave out — so the rows are built against a fully-required shape and
     * widen to {@link LeaderboardTrader} on the way out.
     */
    type Flow = LeaderboardTrader & {
      eth_in: string;
      eth_out: string;
      holdings_value: string;
      pnl: string;
    };

    const flows = new Map<string, Flow>();
    const holdings = new Map<string, bigint>();

    for (const token of this.tokens.values()) {
      const price =
        token.status === 3
          ? token.openingPrice
          : spotPrice(VIRTUAL_ETH + token.ethReserve, token.tokenReserve);

      for (const [account, balance] of token.balances) {
        if (balance <= 0n) continue;
        holdings.set(account, (holdings.get(account) ?? 0n) + (price * balance) / PRICE_UNIT);
      }

      for (const trade of token.trades) {
        if (trade.timestamp < since) continue;

        const row: Flow = flows.get(trade.trader) ?? {
          address: trade.trader,
          trades: 0,
          tokens: 0,
          last_trade_at: null,
          volume: "0",
          eth_in: "0",
          eth_out: "0",
          holdings_value: "0",
          pnl: "0",
        };

        row.trades += 1;
        row.volume = (BigInt(row.volume) + trade.grossEth).toString();
        row.eth_in = (BigInt(row.eth_in) + trade.ethIn).toString();
        row.eth_out = (BigInt(row.eth_out) + trade.ethOut).toString();
        row.last_trade_at = String(Math.max(Number(row.last_trade_at ?? 0), trade.timestamp));

        flows.set(trade.trader, row);
      }
    }

    // `tokens` counts distinct markets touched, so it is tallied separately from the trade loop.
    const distinct = new Map<string, Set<string>>();
    for (const token of this.tokens.values()) {
      for (const trade of token.trades) {
        if (trade.timestamp < since) continue;
        const seen = distinct.get(trade.trader) ?? new Set<string>();
        seen.add(token.address);
        distinct.set(trade.trader, seen);
      }
    }

    for (const row of flows.values()) {
      const held = holdings.get(row.address) ?? 0n;
      row.tokens = distinct.get(row.address)?.size ?? 0;
      row.holdings_value = held.toString();
      row.pnl = (BigInt(row.eth_out) - BigInt(row.eth_in) + held).toString();
    }

    const compare: Record<string, (a: Flow, b: Flow) => number> = {
      volume: (a, b) => compareBig(b.volume, a.volume),
      pnl: (a, b) => compareBig(b.pnl, a.pnl),
      trades: (a, b) => b.trades - a.trades,
    };

    const entries = [...flows.values()]
      .sort(compare[params.sort] ?? compare.volume)
      .slice(0, params.limit);

    return { entries };
  }

  /** Most recent trades across every token — powers the live ticker. */
  recentTrades(limit: number): Array<IndexedTrade & { symbol: string; name: string }> {
    const all: Array<IndexedTrade & { symbol: string; name: string }> = [];

    for (const token of this.tokens.values()) {
      for (const trade of token.trades.slice(-6)) {
        all.push({
          token: token.address,
          trader: trade.trader,
          side: trade.side,
          eth_in: trade.ethIn.toString(),
          eth_out: trade.ethOut.toString(),
          gross_eth: trade.grossEth.toString(),
          fee: trade.fee.toString(),
          token_amount: trade.tokenAmount.toString(),
          price: trade.price.toString(),
          execution_price: trade.executionPrice.toString(),
          eth_reserve: trade.ethReserve.toString(),
          virtual_eth_reserve: trade.virtualEthReserve.toString(),
          token_reserve: trade.tokenReserve.toString(),
          block_number: trade.blockNumber.toString(),
          tx_hash: trade.txHash,
          log_index: trade.logIndex,
          timestamp: String(trade.timestamp),
          symbol: token.symbol,
          name: token.name,
        });
      }
    }

    return all
      .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
      .slice(0, limit);
  }
}

// ---- singleton ------------------------------------------------------------------------------------

let instance: MockChain | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

/**
 * Built lazily and only in the browser: generation uses `Date.now()`, and running it during SSR
 * would produce different markup than the client hydration.
 */
export function getMockChain(): MockChain {
  if (!instance) {
    instance = new MockChain();
    if (typeof window !== "undefined" && !ticker) {
      ticker = setInterval(() => instance?.tick(), 2_600);
    }
  }
  return instance;
}

export type { MockToken };
