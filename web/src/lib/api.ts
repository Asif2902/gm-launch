import { DEMO_MODE, INDEXER_URL } from "./config";
import { getMockChain } from "./mock";
import { subgraphApi, subgraphConfigured } from "./subgraphApi";
import type { Portfolio, TickerTrade } from "./apiTypes";
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
 * Market data client, with three interchangeable sources tried in order:
 *
 *   1. **The Graph** — when `VITE_SUBGRAPH_URL` is set. Needs nothing but a URL.
 *   2. **REST indexer** — the custom Node service. Needs a Postgres instance you host.
 *   3. **Simulation** — `lib/mock.ts`, so the UI is explorable with neither.
 *
 * The first two are built from the same events and expose the same entity model, so they are a
 * genuine either/or rather than a fork in the UI: every method below returns identical shapes
 * whichever answered.
 *
 * None of them is an authority. The token page cross-checks the numbers that matter against
 * `PumperFactory.getToken`, and every trade is quoted on-chain before it is signed (spec §14).
 * When a source is unreachable the session drops to the simulation and says so in the header,
 * rather than presenting stale data as live.
 */

/**
 * The simulation is opt-in and nothing else turns it on.
 *
 * It used to engage automatically on the first failed request, which sounds forgiving and is
 * actually the worst of both worlds: a real deployment with a momentarily unreachable subgraph
 * would quietly replace its market with invented tokens, invented prices and invented trades.
 * A chip in the corner is not enough of a disclaimer for that, and the failure it masks — a
 * misconfigured endpoint — is exactly the one you need to see immediately.
 *
 * So a failing source now fails. Queries reject, pages show that they could not load, and the
 * simulation only appears when someone explicitly asks for it with `VITE_DEMO_MODE=true`.
 */
export const isDemoMode = () => DEMO_MODE;

/** Which source is serving data — surfaced in the header. */
export function activeSource(): "demo" | "subgraph" | "indexer" {
  if (DEMO_MODE) return "demo";
  return subgraphConfigured() ? "subgraph" : "indexer";
}

/** An indexer response that arrived but wasn't OK — as opposed to one that never arrived. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`GET ${path} → ${status}`);
    this.name = "HttpError";
  }
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${INDEXER_URL}${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new HttpError(response.status, path);
  return (await response.json()) as T;
}

/**
 * Runs the configured source. `subgraph` is optional so a method can be REST-only.
 *
 * Errors propagate. The caller is React Query, which surfaces them as `isError` for the page to
 * render honestly — "couldn't load the feed" is information; a feed of fabricated tokens is not.
 */
async function resolve<T>(options: {
  subgraph?: () => Promise<T>;
  path: string;
  mock: () => T;
}): Promise<T> {
  if (DEMO_MODE) return options.mock();

  if (options.subgraph && subgraphConfigured()) {
    return options.subgraph();
  }

  return request<T>(options.path);
}

export type LeaderboardBoard = "traders" | "creators";
export type LeaderboardWindow = "24h" | "7d" | "30d" | "all";
export type LeaderboardSort = "volume" | "pnl" | "trades" | "graduated" | "tokens" | "marketCap";

export interface LeaderboardParams {
  board: LeaderboardBoard;
  sort: LeaderboardSort;
  window: LeaderboardWindow;
  limit?: number;
}

/**
 * What the answering source could actually compute.
 *
 * The two backends are not equivalent here: the REST indexer has the raw trades and can window
 * them and derive a PnL, while The Graph only has lifetime counters on `Account`. Rather than
 * paper over that — a "24h" tab that silently shows all-time numbers is a lie told in a label —
 * the source says what it supports and the page renders only those controls.
 */
export interface LeaderboardCapabilities {
  /** Whether the 24h / 7d / 30d windows mean anything, or everything is lifetime. */
  windows: boolean;
  /** Whether rows carry cash-flow and open-position figures. */
  pnl: boolean;
}

export interface LeaderboardResult {
  entries: LeaderboardTrader[] | LeaderboardCreator[];
  capabilities: LeaderboardCapabilities;
  /** The indexer answered, but has no leaderboard route — it predates this feature. */
  unsupported?: boolean;
}

export type TokenSort =
  | "newest"
  | "oldest"
  | "marketCap"
  | "volume"
  | "progress"
  | "lastTrade"
  | "trades";

export interface TokenListParams {
  sort?: TokenSort;
  status?: number | "all";
  q?: string;
  creator?: string;
  limit?: number;
  offset?: number;
}

export type { TickerTrade, Portfolio };

// ---- mock-side sorting, mirroring the SQL ORDER BY clauses -----------------------------------

const SORTERS: Record<TokenSort, (a: IndexedToken, b: IndexedToken) => number> = {
  newest: (a, b) => Number(b.created_at) - Number(a.created_at),
  oldest: (a, b) => Number(a.created_at) - Number(b.created_at),
  marketCap: (a, b) => compareBig(b.market_cap, a.market_cap),
  volume: (a, b) => compareBig(b.volume_24h ?? "0", a.volume_24h ?? "0"),
  progress: (a, b) => b.migration_progress_bps - a.migration_progress_bps,
  lastTrade: (a, b) => Number(b.last_trade_at ?? 0) - Number(a.last_trade_at ?? 0),
  trades: (a, b) => b.trade_count - a.trade_count,
};

function compareBig(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left === right ? 0 : left > right ? 1 : -1;
}

function mockTokenList(params: TokenListParams) {
  const chain = getMockChain();
  let tokens = chain.list().map((address) => chain.toIndexed(chain.tokens.get(address)!));

  if (params.status !== undefined && params.status !== "all") {
    tokens = tokens.filter((token) => token.status === params.status);
  }
  if (params.creator) {
    tokens = tokens.filter(
      (token) => token.creator.toLowerCase() === params.creator!.toLowerCase(),
    );
  }
  if (params.q) {
    const needle = params.q.toLowerCase();
    tokens = tokens.filter(
      (token) =>
        token.name.toLowerCase().includes(needle) ||
        token.symbol.toLowerCase().includes(needle) ||
        token.address.toLowerCase().includes(needle),
    );
  }

  tokens.sort(SORTERS[params.sort ?? "newest"]);

  const offset = params.offset ?? 0;
  const limit = params.limit ?? 50;
  return {
    tokens: tokens.slice(offset, offset + limit),
    total: tokens.length,
    limit,
    offset,
  };
}

// ---- public API ---------------------------------------------------------------------------------

export const api = {
  stats: () =>
    resolve<ProtocolStats>({
      subgraph: () => subgraphApi.stats(),
      path: "/stats",
      mock: () => getMockChain().stats(),
    }),

  tokens: (params: TokenListParams = {}) => {
    const search = new URLSearchParams();
    if (params.sort) search.set("sort", params.sort);
    if (params.status !== undefined) search.set("status", String(params.status));
    if (params.q) search.set("q", params.q);
    if (params.creator) search.set("creator", params.creator);
    search.set("limit", String(params.limit ?? 50));
    search.set("offset", String(params.offset ?? 0));

    return resolve<{ tokens: IndexedToken[]; total: number; limit: number; offset: number }>({
      subgraph: () => subgraphApi.tokens(params),
      path: `/tokens?${search.toString()}`,
      mock: () => mockTokenList(params),
    });
  },

  token: (address: string) =>
    resolve<{ token: IndexedToken; migration: IndexedMigration | null }>({
      subgraph: () => subgraphApi.token(address),
      path: `/tokens/${address}`,
      mock: () => {
        const chain = getMockChain();
        const token = chain.tokens.get(address.toLowerCase());
        if (!token) throw new Error("token_not_found");
        return { token: chain.toIndexed(token), migration: chain.toMigration(token) };
      },
    }),

  trades: (address: string, limit = 50) =>
    resolve<{ trades: IndexedTrade[] }>({
      subgraph: () => subgraphApi.trades(address, limit),
      path: `/tokens/${address}/trades?limit=${limit}`,
      mock: () => {
        const chain = getMockChain();
        const token = chain.tokens.get(address.toLowerCase());
        return { trades: token ? chain.toIndexedTrades(token, limit) : [] };
      },
    }),

  candles: (address: string, interval: number, limit = 500) =>
    resolve<{ interval: number; candles: IndexedCandle[] }>({
      subgraph: () => subgraphApi.candles(address, interval, limit),
      path: `/tokens/${address}/candles?interval=${interval}&limit=${limit}`,
      mock: () => {
        const chain = getMockChain();
        const token = chain.tokens.get(address.toLowerCase());
        return { interval, candles: token ? chain.toCandles(token, interval, limit) : [] };
      },
    }),

  holders: (address: string, limit = 50) =>
    resolve<{ holders: IndexedHolder[] }>({
      subgraph: () => subgraphApi.holders(address, limit),
      path: `/tokens/${address}/holders?limit=${limit}`,
      mock: () => {
        const chain = getMockChain();
        const token = chain.tokens.get(address.toLowerCase());
        return { holders: token ? chain.toHolders(token, limit) : [] };
      },
    }),

  recentTrades: (limit = 24) =>
    resolve<{ trades: TickerTrade[] }>({
      subgraph: () => subgraphApi.recentTrades(limit),
      path: `/trades/recent?limit=${limit}`,
      mock: () => ({ trades: getMockChain().recentTrades(limit) }),
    }),

  /**
   * Trader and creator rankings.
   *
   * REST-only by design: it is an aggregation across every trade and holder, which The Graph
   * cannot answer in one query without an entity built for it. With a subgraph configured this
   * still goes to the indexer.
   *
   * It does *not* use {@link resolve}, because a 404 here means something specific: an indexer
   * that predates this endpoint. Treating that as "the source is down" would drop the whole
   * session into the simulation — the feed, the charts, everything — over one missing route,
   * and filling the table with invented traders would be worse still. So a 404 returns nothing
   * and says so; only a genuine transport failure degrades the way everything else does.
   */
  leaderboard: async (params: LeaderboardParams): Promise<LeaderboardResult> => {
    const full: LeaderboardCapabilities = { windows: true, pnl: true };
    if (DEMO_MODE) {
      return {
        ...getMockChain().leaderboard({ ...params, limit: params.limit ?? 50 }),
        capabilities: full,
      };
    }

    if (subgraphConfigured()) {
      const result = await subgraphApi.leaderboard(params);
      return { ...result, capabilities: { windows: false, pnl: false } };
    }

    const search = new URLSearchParams({
      board: params.board,
      sort: params.sort,
      window: params.window,
      limit: String(params.limit ?? 50),
    });

    try {
      const result = await request<{
        entries: LeaderboardTrader[] | LeaderboardCreator[];
      }>(`/leaderboard?${search.toString()}`);
      return { ...result, capabilities: full };
    } catch (error) {
      // A 404 means an indexer that predates this endpoint — a specific, fixable thing. Treating
      // it as "the source is down" would drop the whole session into the simulation over one
      // missing route, and filling the table with invented traders would be worse still.
      if (error instanceof HttpError && error.status === 404) {
        console.warn("[gm] indexer has no /leaderboard endpoint — upgrade the indexer");
        return { entries: [], capabilities: full, unsupported: true };
      }
      throw error;
    }
  },

  portfolio: (address: string) =>
    resolve<Portfolio>({
      subgraph: () => subgraphApi.portfolio(address),
      path: `/accounts/${address}/portfolio`,
      mock: () => {
        const result = getMockChain().portfolio(address);
        return {
          holdings: result.holdings,
          created: result.created,
          totalValueWei: result.totalValueWei.toString(),
          tradeCount: result.tradeCount,
          volumeWei: result.volumeWei.toString(),
        };
      },
    }),
};
