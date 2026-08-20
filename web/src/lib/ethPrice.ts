import { useQuery } from "@tanstack/react-query";

import { API_BASE } from "./config";

/**
 * ETH/USD for display.
 *
 * Fetched from `/api/eth-price`, which holds a 30-minute server-side cache — so this hook can be
 * called from as many components as you like: react-query dedupes within the page, and the
 * server dedupes across visitors.
 *
 * Presentational only. Every trade is quoted, signed and settled in ETH/wei; the USD figure is a
 * label placed on top of it. When the feed is unavailable `usd` is null and callers fall back to
 * showing ETH, which is always correct because it is the actual unit.
 */

const THIRTY_MINUTES = 30 * 60 * 1000;

export interface EthPrice {
  usd: number | null;
  fetchedAt?: number;
  source?: string;
  stale?: boolean;
}

export function useEthPrice(): EthPrice {
  const { data } = useQuery({
    queryKey: ["eth-price"],
    queryFn: async (): Promise<EthPrice> => {
      const response = await fetch(`${API_BASE}/eth-price`);
      if (!response.ok) return { usd: null };
      return (await response.json()) as EthPrice;
    },
    // Matches the server cache: refetching sooner would only ever return the same value.
    staleTime: THIRTY_MINUTES,
    gcTime: THIRTY_MINUTES * 2,
    refetchInterval: THIRTY_MINUTES,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  return data ?? { usd: null };
}

/** Converts a wei amount to USD. */
export function usdFromWei(wei: bigint | string, ethUsd: number | null): number | null {
  if (ethUsd === null) return null;
  return (Number(BigInt(wei)) / 1e18) * ethUsd;
}

/**
 * Converts a token price to USD.
 *
 * Prices are stored as **wei per whole token**, so dividing by 1e18 gives ETH per token before
 * applying the rate. A fresh curve sits near 5e-10 ETH, i.e. fractions of a cent — which is why
 * the formatter has to handle very small numbers rather than rounding them to `$0.00`.
 */
export function usdFromTokenPrice(priceWei: bigint | string, ethUsd: number | null): number | null {
  if (ethUsd === null) return null;
  return (Number(BigInt(priceWei)) / 1e18) * ethUsd;
}
