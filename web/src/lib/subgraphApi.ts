import { FACTORY_ADDRESS, SUBGRAPH_URL } from "./config";
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
import type { Portfolio, TickerTrade } from "./apiTypes";

/**
 * The Graph-backed implementation of the data layer.
 *
 * The custom Node indexer needs Postgres; a subgraph needs nothing but a URL. Since both are
 * built from the same events and expose the same entity model, either can back the frontend —
 * so this module returns the exact shapes `api.ts` already consumes, and the choice becomes one
 * environment variable rather than a fork in the UI.
 *
 * Two figures are computed differently here, and the difference is real rather than cosmetic:
 *
 *   - **24h volume** comes from the current *daily candle*, which is calendar-bucketed rather
 *     than a trailing 24 hours. Early in a UTC day it reads low. The REST indexer does a true
 *     trailing window; The Graph has no cheap equivalent for a list query.
 *   - **Sorting by volume** uses lifetime `volumeEth`, because a nested per-token aggregate
 *     can't be an `orderBy` target.
 *   - **The leaderboard is lifetime-only, with no PnL.** `Account` carries total volume and trade
 *     count, not per-side cash flow or time buckets, so there is nothing to compute a windowed
 *     profit from. Rather than approximate one, this source reports what it can answer and the
 *     page hides the columns it cannot — see `leaderboard` below.
 */

export const subgraphConfigured = () => Boolean(SUBGRAPH_URL);

class SubgraphError extends Error {}

/**
 * The subgraph is serving a different launchpad than this app is configured for.
 *
 * Its own class because it is not a transient failure and retrying will never fix it — the two
 * are simply pointed at different deployments, and the page needs to say that rather than show a
 * generic "couldn't load".
 */
export class SubgraphMismatchError extends Error {
  constructor(
    readonly subgraphFactory: string,
    readonly expectedFactory: string,
  ) {
    super(
      `Subgraph indexes factory ${subgraphFactory}, but this app is configured for ${expectedFactory}`,
    );
    this.name = "SubgraphMismatchError";
  }
}

let endpointCheck: Promise<void> | null = null;

/**
 * Refuses to read from a subgraph that indexes a different factory than we are configured for.
 *
 * This exists because of a failure that is very easy to cause and very hard to spot: migrating
 * the app to a new chain while `VITE_SUBGRAPH_URL` still points at the old deployment. Every
 * query succeeds, the data looks entirely plausible, and the app confidently renders a market
 * that has nothing to do with the chain in its own header — testnet tokens on a mainnet site.
 *
 * Comparing the factory address catches it on the first query. Checked once per session and
 * memoised, because the answer cannot change under a running deployment.
 */
async function assertEndpointMatches(): Promise<void> {
  if (!endpointCheck) {
    endpointCheck = (async () => {
      const data = await gql<{ protocol: { factory: string } | null }>(
        `{ protocol(id: "pumper") { factory } }`,
        {},
        true,
      );

      const indexed = data.protocol?.factory?.toLowerCase();
      const expected = FACTORY_ADDRESS.toLowerCase();

      // A subgraph that has not indexed anything yet has no Protocol entity. That is a fresh
      // deployment catching up, not a mismatch, so it is allowed through.
      if (!indexed) return;

      if (indexed !== expected) throw new SubgraphMismatchError(indexed, expected);
    })().catch((error) => {
      // Never cache a transport failure as a verdict — only a real mismatch should stick.
      if (!(error instanceof SubgraphMismatchError)) endpointCheck = null;
      throw error;
    });
  }
  return endpointCheck;
}

/**
 * One GraphQL round trip.
 *
 * `skipVerify` exists only for the endpoint check itself, which has to issue a query before the
 * check can have an answer. Everything else is verified first, so no caller can accidentally
 * render data from the wrong deployment.
 */
async function gql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  skipVerify = false,
): Promise<T> {
  if (!SUBGRAPH_URL) throw new SubgraphError("No subgraph URL configured");
  if (!skipVerify) await assertEndpointMatches();

  const response = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });

  if (!response.ok) throw new SubgraphError(`Subgraph HTTP ${response.status}`);

  const body = await response.json();
  if (body.errors?.length) {
    const message = body.errors.map((e: { message: string }) => e.message).join("; ");

    /**
     * The one error worth recovering from rather than reporting: this endpoint predates a field
     * we asked for. Drop it and run the query again - see `athFieldSupported`.
     *
     * The condition deliberately does *not* consult `athFieldSupported`. That flag records what
     * we have learned, and gating recovery on it created a race: the feed fires several queries
     * at once, the first to fail flipped the flag and retried successfully, and every sibling
     * already in flight then saw `false`, concluded someone else had handled it, and threw. The
     * result was an empty feed with no error on screen, which is the worst kind of failure.
     *
     * Recovery is guarded instead by the query still containing the field, which is also what
     * guarantees the recursion terminates: the retry has it stripped, so a second failure cannot
     * match here.
     */
    if (/athMarketCap/i.test(message) && query.includes("athMarketCap")) {
      if (athFieldSupported) {
        console.warn(
          "[gm] subgraph has no athMarketCap field - redeploy the subgraph to show all-time highs",
        );
        athFieldSupported = false;
      }
      return gql<T>(query.replace(/athMarketCap/g, ""), variables, skipVerify);
    }

    throw new SubgraphError(message);
  }
  return body.data as T;
}

// ---- field selections ---------------------------------------------------------------------------

/**
 * Whether the deployed subgraph knows about `athMarketCap`.
 *
 * The field was added after the first deploy, and The Graph rejects an entire query that selects
 * an unknown field — so asking for it against an older subgraph would not merely lose the
 * all-time-high, it would fail every token query and drop the whole session into the simulation.
 *
 * So it is requested optimistically and dropped for good the first time an endpoint says it does
 * not exist. A deployment that has redeployed its subgraph gets the field; one that has not keeps
 * working exactly as before, and starts showing ATH the moment it upgrades — no flag to flip.
 */
let athFieldSupported = true;

const tokenFields = () => `
  id name symbol status
  totalSupply migrationThreshold
  ethReserve virtualEthReserve tokenReserve
  price marketCap ${athFieldSupported ? "athMarketCap" : ""} fullyDilutedValuation migrationProgressBps
  volumeEth buyVolumeEth sellVolumeEth tokensBought tokensSold feesEth
  tradeCount buyCount sellCount holderCount
  pair migratedAt lastTradeAt createdAt createdAtBlock createdAtTx
  creator { id }
`;

const TRADE_FIELDS = `
  trader side ethIn ethOut grossEth fee tokenAmount
  price executionPrice ethReserve virtualEthReserve tokenReserve
  blockNumber timestamp transactionHash logIndex
`;

// ---- shape adapters -----------------------------------------------------------------------------

interface RawToken {
  id: string;
  name: string;
  symbol: string;
  status: number;
  totalSupply: string;
  migrationThreshold: string;
  ethReserve: string;
  virtualEthReserve: string;
  tokenReserve: string;
  price: string;
  marketCap: string;
  athMarketCap?: string;
  fullyDilutedValuation: string;
  migrationProgressBps: number;
  volumeEth: string;
  buyVolumeEth: string;
  sellVolumeEth: string;
  tokensBought: string;
  tokensSold: string;
  feesEth: string;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  holderCount: number;
  pair: string | null;
  migratedAt: string | null;
  lastTradeAt: string | null;
  createdAt: string;
  createdAtBlock: string;
  createdAtTx: string;
  creator: { id: string };
  pricePoints?: Array<{ price: string }>;
  candles?: Array<{ volumeEth: string }>;
}

function toIndexedToken(raw: RawToken): IndexedToken {
  return {
    address: raw.id,
    creator: raw.creator.id,
    name: raw.name,
    symbol: raw.symbol,
    status: Number(raw.status),
    total_supply: raw.totalSupply,
    migration_threshold: raw.migrationThreshold,
    eth_reserve: raw.ethReserve,
    virtual_eth_reserve: raw.virtualEthReserve,
    token_reserve: raw.tokenReserve,
    price: raw.price,
    market_cap: raw.marketCap,
    ath_market_cap: raw.athMarketCap,
    fdv: raw.fullyDilutedValuation,
    migration_progress_bps: Number(raw.migrationProgressBps),
    volume_eth: raw.volumeEth,
    buy_volume_eth: raw.buyVolumeEth,
    sell_volume_eth: raw.sellVolumeEth,
    tokens_bought: raw.tokensBought,
    tokens_sold: raw.tokensSold,
    fees_eth: raw.feesEth,
    trade_count: Number(raw.tradeCount),
    buy_count: Number(raw.buyCount),
    sell_count: Number(raw.sellCount),
    holder_count: Number(raw.holderCount),
    pair: raw.pair,
    migrated_at: raw.migratedAt,
    last_trade_at: raw.lastTradeAt,
    created_at: raw.createdAt,
    created_at_block: raw.createdAtBlock,
    created_at_tx: raw.createdAtTx,
    volume_24h: raw.candles?.[0]?.volumeEth ?? "0",
    trades_24h: undefined,
    // Nested price points come back newest-first; the sparkline reads oldest-first.
    sparkline: raw.pricePoints ? [...raw.pricePoints].reverse().map((p) => p.price) : null,
  };
}

interface RawTrade {
  trader: string;
  side: "BUY" | "SELL";
  ethIn: string;
  ethOut: string;
  grossEth: string;
  fee: string;
  tokenAmount: string;
  price: string;
  executionPrice: string;
  ethReserve: string;
  virtualEthReserve: string;
  tokenReserve: string;
  blockNumber: string;
  timestamp: string;
  transactionHash: string;
  logIndex: string;
  token?: { id: string; symbol: string; name: string };
}

function toIndexedTrade(raw: RawTrade, tokenAddress: string): IndexedTrade {
  return {
    token: tokenAddress,
    trader: raw.trader,
    side: raw.side === "BUY" ? 0 : 1,
    eth_in: raw.ethIn,
    eth_out: raw.ethOut,
    gross_eth: raw.grossEth,
    fee: raw.fee,
    token_amount: raw.tokenAmount,
    price: raw.price,
    execution_price: raw.executionPrice,
    eth_reserve: raw.ethReserve,
    virtual_eth_reserve: raw.virtualEthReserve,
    token_reserve: raw.tokenReserve,
    block_number: raw.blockNumber,
    tx_hash: raw.transactionHash,
    log_index: Number(raw.logIndex),
    timestamp: raw.timestamp,
  };
}

// ---- sorting ------------------------------------------------------------------------------------

const ORDER_BY: Record<string, { field: string; direction: "asc" | "desc" }> = {
  newest: { field: "createdAt", direction: "desc" },
  oldest: { field: "createdAt", direction: "asc" },
  marketCap: { field: "marketCap", direction: "desc" },
  volume: { field: "volumeEth", direction: "desc" },
  progress: { field: "migrationProgressBps", direction: "desc" },
  lastTrade: { field: "lastTradeAt", direction: "desc" },
  trades: { field: "tradeCount", direction: "desc" },
};

const startOfUtcDay = () => Math.floor(Date.now() / 1000 / 86_400) * 86_400;

/** Descending comparison for decimal strings too large for a JS number. */
function descending(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left === right ? 0 : left > right ? -1 : 1;
}

// ---- public surface -----------------------------------------------------------------------------

export const subgraphApi = {
  async stats(): Promise<ProtocolStats> {
    const today = startOfUtcDay();
    const data = await gql<{
      protocol: {
        tokenCount: number;
        migratedCount: number;
        tradeCount: number;
        totalVolumeEth: string;
        totalFeesEth: string;
        totalEthLocked: string;
      } | null;
      tokens: Array<{ status: number }>;
      candles: Array<{ volumeEth: string }>;
    }>(
      `query Stats($today: BigInt!) {
         protocol(id: "pumper") {
           tokenCount migratedCount tradeCount totalVolumeEth totalFeesEth totalEthLocked
         }
         tokens(where: { status: 2 }, first: 1000) { status }
         candles(where: { intervalSecs: 86400, bucketStart_gte: $today }, first: 1000) {
           volumeEth
         }
       }`,
      { today: String(today) },
    );

    const volume24h = data.candles.reduce((sum, candle) => sum + BigInt(candle.volumeEth), 0n);

    return {
      tokens: String(data.protocol?.tokenCount ?? 0),
      migrated: String(data.protocol?.migratedCount ?? 0),
      pending_migration: String(data.tokens.length),
      total_volume_eth: data.protocol?.totalVolumeEth ?? "0",
      total_fees_eth: data.protocol?.totalFeesEth ?? "0",
      total_eth_locked: data.protocol?.totalEthLocked ?? "0",
      total_trades: String(data.protocol?.tradeCount ?? 0),
      volume_24h: volume24h.toString(),
    };
  },

  async tokens(params: {
    sort?: string;
    status?: number | "all";
    q?: string;
    creator?: string;
    limit?: number;
    offset?: number;
  }) {
    const order = ORDER_BY[params.sort ?? "newest"] ?? ORDER_BY.newest;
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    const where: Record<string, unknown> = {};
    if (params.status !== undefined && params.status !== "all") where.status = params.status;
    if (params.creator) where.creator = params.creator.toLowerCase();

    // The Graph has no OR across fields in a single `where`, so a text search runs as two
    // queries merged client-side. Address search is handled by an exact id lookup.
    const search = params.q?.trim().toLowerCase();
    const today = startOfUtcDay();

    const nested = `
      pricePoints(first: 24, orderBy: timestamp, orderDirection: desc) { price }
      candles(where: { intervalSecs: 86400, bucketStart_gte: "${today}" }, first: 1) { volumeEth }
    `;

    if (search && /^0x[0-9a-f]{40}$/.test(search)) {
      const data = await gql<{ token: RawToken | null }>(
        `query TokenById($id: ID!) { token(id: $id) { ${tokenFields()} ${nested} } }`,
        { id: search },
      );
      const tokens = data.token ? [toIndexedToken(data.token)] : [];
      return { tokens, total: tokens.length, limit, offset };
    }

    if (search) {
      const data = await gql<{ byName: RawToken[]; bySymbol: RawToken[] }>(
        `query Search($where: Token_filter!, $q: String!, $first: Int!) {
           byName: tokens(where: { and: [$where, { name_contains_nocase: $q }] }, first: $first) {
             ${tokenFields()} ${nested}
           }
           bySymbol: tokens(where: { and: [$where, { symbol_contains_nocase: $q }] }, first: $first) {
             ${tokenFields()} ${nested}
           }
         }`,
        { where, q: search, first: limit },
      );

      const merged = new Map<string, IndexedToken>();
      for (const raw of [...data.byName, ...data.bySymbol]) {
        merged.set(raw.id, toIndexedToken(raw));
      }
      const tokens = [...merged.values()];
      return { tokens, total: tokens.length, limit, offset };
    }

    const data = await gql<{ tokens: RawToken[] }>(
      `query Tokens($where: Token_filter!, $first: Int!, $skip: Int!, $orderBy: Token_orderBy!, $dir: OrderDirection!) {
         tokens(where: $where, first: $first, skip: $skip, orderBy: $orderBy, orderDirection: $dir) {
           ${tokenFields()} ${nested}
         }
       }`,
      { where, first: limit, skip: offset, orderBy: order.field, dir: order.direction },
    );

    const tokens = data.tokens.map(toIndexedToken);
    // The Graph has no total-count aggregate; report what the page holds.
    return { tokens, total: tokens.length + offset, limit, offset };
  },

  async token(address: string) {
    const today = startOfUtcDay();
    const data = await gql<{ token: RawToken | null; migration: RawMigration | null }>(
      `query Token($id: ID!, $today: BigInt!) {
         token(id: $id) {
           ${tokenFields()}
           pricePoints(first: 24, orderBy: timestamp, orderDirection: desc) { price }
           candles(where: { intervalSecs: 86400, bucketStart_gte: $today }, first: 1) { volumeEth }
         }
         migration(id: $id) {
           pair triggeredAt triggeredEthReserve triggeredTokenReserve
           completedAt completedTx ethDeposited tokensDeposited tokensBurned
           lpTokensBurned openingPrice
         }
       }`,
      { id: address.toLowerCase(), today: String(today) },
    );

    if (!data.token) throw new SubgraphError("token_not_found");

    return {
      token: toIndexedToken(data.token),
      migration: data.migration ? toIndexedMigration(address, data.migration) : null,
    };
  },

  async trades(address: string, limit = 50) {
    const data = await gql<{ trades: RawTrade[] }>(
      `query Trades($token: String!, $first: Int!) {
         trades(where: { token: $token }, first: $first, orderBy: blockNumber, orderDirection: desc) {
           ${TRADE_FIELDS}
         }
       }`,
      { token: address.toLowerCase(), first: limit },
    );
    return { trades: data.trades.map((raw) => toIndexedTrade(raw, address.toLowerCase())) };
  },

  async candles(address: string, interval: number, limit = 500) {
    const data = await gql<{
      candles: Array<{
        bucketStart: string;
        open: string;
        high: string;
        low: string;
        close: string;
        volumeEth: string;
        tradeCount: number;
      }>;
    }>(
      `query Candles($token: String!, $interval: Int!, $first: Int!) {
         candles(
           where: { token: $token, intervalSecs: $interval }
           first: $first
           orderBy: bucketStart
           orderDirection: desc
         ) { bucketStart open high low close volumeEth tradeCount }
       }`,
      { token: address.toLowerCase(), interval, first: limit },
    );

    // Query descending to get the newest window, then flip for the chart.
    const candles: IndexedCandle[] = [...data.candles].reverse().map((candle) => ({
      bucket_start: candle.bucketStart,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume_eth: candle.volumeEth,
      trade_count: Number(candle.tradeCount),
    }));

    return { interval, candles };
  },

  async holders(address: string, limit = 50) {
    const data = await gql<{
      token: { totalSupply: string } | null;
      holders: Array<{ address: string; balance: string; firstSeenAt: string; lastSeenAt: string }>;
    }>(
      `query Holders($token: String!, $id: ID!, $first: Int!) {
         token(id: $id) { totalSupply }
         holders(
           where: { token: $token, balance_gt: "0" }
           first: $first
           orderBy: balance
           orderDirection: desc
         ) { address balance firstSeenAt lastSeenAt }
       }`,
      { token: address.toLowerCase(), id: address.toLowerCase(), first: limit },
    );

    const supply = BigInt(data.token?.totalSupply ?? "0");

    const holders: IndexedHolder[] = data.holders.map((holder) => ({
      address: holder.address,
      balance: holder.balance,
      share_bps: supply > 0n ? ((BigInt(holder.balance) * 10_000n) / supply).toString() : null,
      first_seen_at: holder.firstSeenAt,
      last_seen_at: holder.lastSeenAt,
    }));

    return { holders };
  },

  async recentTrades(limit = 24): Promise<{ trades: TickerTrade[] }> {
    const data = await gql<{ trades: Array<RawTrade & { token: { id: string; symbol: string; name: string } }> }>(
      `query Recent($first: Int!) {
         trades(first: $first, orderBy: blockNumber, orderDirection: desc) {
           ${TRADE_FIELDS}
           token { id symbol name }
         }
       }`,
      { first: limit },
    );

    return {
      trades: data.trades.map((raw) => ({
        ...toIndexedTrade(raw, raw.token.id),
        symbol: raw.token.symbol,
        name: raw.token.name,
      })),
    };
  },

  /**
   * Trader and creator rankings from the entity counters.
   *
   * Two limits are inherent to the source rather than choices:
   *
   *   * **No windows.** `Account.volumeEth` is lifetime. A 24h ranking would mean scanning every
   *     `Trade` in the window and grouping client-side, which is a paginated crawl of the whole
   *     trade history on every page view.
   *   * **No PnL.** There is no per-side cash flow on `Account`, so the profit column is simply
   *     absent here instead of being guessed at.
   *
   * Creators are sorted client-side for the volume and market-cap boards, because those are sums
   * over a nested `tokens` selection and The Graph can only order by a field on the entity
   * itself. The fetch is widened to compensate, which is sound while a launchpad has hundreds of
   * creators rather than millions — the REST indexer is the answer at that scale.
   */
  async leaderboard(params: {
    board: "traders" | "creators";
    sort: string;
    limit?: number;
  }): Promise<{ entries: LeaderboardTrader[] | LeaderboardCreator[] }> {
    const limit = params.limit ?? 50;

    if (params.board === "creators") {
      const clientSorted = params.sort === "volume" || params.sort === "marketCap";
      const orderBy = params.sort === "graduated" ? "tokensMigrated" : "tokensCreated";

      const data = await gql<{
        creators: Array<{
          id: string;
          tokensCreated: number;
          tokensMigrated: number;
          lastSeenAt: string;
          tokens: Array<{
            volumeEth: string;
            marketCap: string;
            feesEth: string;
            tradeCount: number;
            holderCount: number;
            createdAt: string;
          }>;
        }>;
      }>(
        `query Creators($first: Int!) {
           creators(first: $first, orderBy: ${orderBy}, orderDirection: desc) {
             id tokensCreated tokensMigrated lastSeenAt
             tokens(first: 200) {
               volumeEth marketCap feesEth tradeCount holderCount createdAt
             }
           }
         }`,
        { first: clientSorted ? Math.max(limit, 200) : limit },
      );

      const entries: LeaderboardCreator[] = data.creators.map((creator) => {
        const totals = creator.tokens.reduce(
          (sum, token) => ({
            volume: sum.volume + BigInt(token.volumeEth),
            marketCap: sum.marketCap + BigInt(token.marketCap),
            fees: sum.fees + BigInt(token.feesEth),
            trades: sum.trades + Number(token.tradeCount),
            holders: sum.holders + Number(token.holderCount),
            lastCreated: Math.max(sum.lastCreated, Number(token.createdAt)),
          }),
          { volume: 0n, marketCap: 0n, fees: 0n, trades: 0, holders: 0, lastCreated: 0 },
        );

        return {
          address: creator.id,
          tokens_created: Number(creator.tokensCreated),
          tokens_migrated: Number(creator.tokensMigrated),
          volume: totals.volume.toString(),
          market_cap: totals.marketCap.toString(),
          fees: totals.fees.toString(),
          trades: totals.trades,
          holders: totals.holders,
          last_created_at: totals.lastCreated ? String(totals.lastCreated) : creator.lastSeenAt,
        };
      });

      if (params.sort === "volume") {
        entries.sort((a, b) => descending(a.volume, b.volume));
      } else if (params.sort === "marketCap") {
        entries.sort((a, b) => descending(a.market_cap, b.market_cap));
      }

      return { entries: entries.slice(0, limit) };
    }

    const orderBy = params.sort === "trades" ? "tradeCount" : "volumeEth";

    const data = await gql<{
      accounts: Array<{
        id: string;
        volumeEth: string;
        tradeCount: number;
        positionCount: number;
        lastSeenAt: string;
      }>;
    }>(
      `query Traders($first: Int!) {
         accounts(
           first: $first
           orderBy: ${orderBy}
           orderDirection: desc
           where: { tradeCount_gt: 0 }
         ) {
           id volumeEth tradeCount positionCount lastSeenAt
         }
       }`,
      { first: limit },
    );

    const entries: LeaderboardTrader[] = data.accounts.map((account) => ({
      address: account.id,
      trades: Number(account.tradeCount),
      // Positions currently held, not markets traded in the window — the closest thing this
      // source has, and the same order of magnitude.
      tokens: Number(account.positionCount),
      last_trade_at: account.lastSeenAt,
      volume: account.volumeEth,
      pnl: null,
    }));

    return { entries };
  },

  /** One query for a whole profile, thanks to the counters on `Account`. */
  async portfolio(address: string): Promise<Portfolio> {
    const data = await gql<{
      account: {
        tradeCount: number;
        volumeEth: string;
        holdings: Array<{
          balance: string;
          token: {
            id: string;
            name: string;
            symbol: string;
            status: number;
            price: string;
            totalSupply: string;
          };
        }>;
      } | null;
      tokens: Array<{ id: string }>;
    }>(
      `query Portfolio($id: ID!, $creator: String!) {
         account(id: $id) {
           tradeCount volumeEth
           holdings(where: { balance_gt: "0" }, orderBy: balance, orderDirection: desc, first: 200) {
             balance
             token { id name symbol status price totalSupply }
           }
         }
         tokens(where: { creator: $creator }, orderBy: createdAt, orderDirection: desc, first: 200) {
           id
         }
       }`,
      { id: address.toLowerCase(), creator: address.toLowerCase() },
    );

    const holdings = (data.account?.holdings ?? []).map((holding) => {
      const balance = BigInt(holding.balance);
      const price = BigInt(holding.token.price);
      const supply = BigInt(holding.token.totalSupply);
      return {
        token: holding.token.id,
        name: holding.token.name,
        symbol: holding.token.symbol,
        status: Number(holding.token.status),
        balance: holding.balance,
        price: holding.token.price,
        valueWei: ((price * balance) / 10n ** 18n).toString(),
        shareBps: supply > 0n ? Number((balance * 10_000n) / supply) : 0,
      };
    });

    const totalValueWei = holdings.reduce((sum, h) => sum + BigInt(h.valueWei), 0n);

    // Value ordering can differ from balance ordering when prices differ across tokens.
    holdings.sort((a, b) => (BigInt(b.valueWei) > BigInt(a.valueWei) ? 1 : -1));

    return {
      holdings,
      created: data.tokens.map((token) => token.id),
      totalValueWei: totalValueWei.toString(),
      tradeCount: Number(data.account?.tradeCount ?? 0),
      volumeWei: data.account?.volumeEth ?? "0",
    };
  },

  /** Health probe used to decide whether the subgraph is usable. */
  async health(): Promise<{ ok: boolean; tokenCount: number }> {
    const data = await gql<{ protocol: { tokenCount: number } | null }>(
      `{ protocol(id: "pumper") { tokenCount } }`,
    );
    return { ok: true, tokenCount: data.protocol?.tokenCount ?? 0 };
  },
};

interface RawMigration {
  pair: string | null;
  triggeredAt: string | null;
  triggeredEthReserve: string | null;
  triggeredTokenReserve: string | null;
  completedAt: string | null;
  completedTx: string | null;
  ethDeposited: string | null;
  tokensDeposited: string | null;
  tokensBurned: string | null;
  lpTokensBurned: string | null;
  openingPrice: string | null;
}

function toIndexedMigration(token: string, raw: RawMigration): IndexedMigration {
  return {
    token,
    pair: raw.pair,
    triggered_at: raw.triggeredAt,
    triggered_eth_reserve: raw.triggeredEthReserve,
    triggered_token_reserve: raw.triggeredTokenReserve,
    completed_at: raw.completedAt,
    completed_tx: raw.completedTx,
    eth_deposited: raw.ethDeposited,
    tokens_deposited: raw.tokensDeposited,
    tokens_burned: raw.tokensBurned,
    lp_tokens_burned: raw.lpTokensBurned,
    opening_price: raw.openingPrice,
  };
}
