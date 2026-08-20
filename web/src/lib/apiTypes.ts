import type { IndexedTrade } from "./types";

/**
 * Shapes shared by every data source — REST indexer, subgraph, and the simulation.
 *
 * They live here rather than in any one client so the three can't drift, and so importing a type
 * doesn't drag in an implementation (which would create a cycle between `api.ts`,
 * `subgraphApi.ts` and `mock.ts`).
 */

/** A trade with its token's identity attached, for the cross-token ticker. */
export interface TickerTrade extends IndexedTrade {
  symbol: string;
  name: string;
}

export interface PortfolioHolding {
  token: string;
  name: string;
  symbol: string;
  status: number;
  balance: string;
  price: string;
  valueWei: string;
  shareBps: number;
}

export interface Portfolio {
  holdings: PortfolioHolding[];
  created: string[];
  totalValueWei: string;
  tradeCount: number;
  volumeWei: string;
}
