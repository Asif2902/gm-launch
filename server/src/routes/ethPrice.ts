import { Router } from "express";

import { getCachedPrice, setCachedPrice } from "../db";

export const ethPrice = Router();

const PRICE_KEY = "eth-usd";
const TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  usd: number;
  fetchedAt: number;
  source: string;
}

// Process-local tier. Free, but per-instance and lost on restart — which is why the durable
// tier below exists.
let cache: CacheEntry | null = null;
let inFlight: Promise<CacheEntry | null> | null = null;

/**
 * Two sources, tried in order. A single free endpoint failing would otherwise blank every price
 * on the site, and these two have independent operators and infrastructure.
 */
const SOURCES: Array<{ name: string; url: string; parse: (body: any) => number }> = [
  {
    name: "coinbase",
    url: "https://api.coinbase.com/v2/prices/ETH-USD/spot",
    parse: (body) => Number(body?.data?.amount),
  },
  {
    name: "coingecko",
    url: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    parse: (body) => Number(body?.ethereum?.usd),
  },
];

async function fetchFromSources(): Promise<CacheEntry | null> {
  for (const source of SOURCES) {
    try {
      const response = await fetch(source.url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) continue;

      const usd = source.parse(await response.json());
      // Sanity-bound the value: a malformed response that parses to 0 — or to something absurd —
      // would silently mislabel every figure on the site.
      if (!Number.isFinite(usd) || usd <= 0 || usd > 1_000_000) continue;

      return { usd, fetchedAt: Date.now(), source: source.name };
    } catch {
      // try the next source
    }
  }
  return null;
}

const isFresh = (entry: CacheEntry | null): entry is CacheEntry =>
  entry !== null && Date.now() - entry.fetchedAt < TTL_MS;

/**
 * Two cache tiers: process memory, then Turso.
 *
 * The database tier is the real 30-minute global cache — shared across instances, surviving
 * restarts and cold starts. That is what stops a keyless public endpoint from rate limiting us.
 * If Turso is unconfigured the memory tier still applies and nothing breaks.
 */
async function getPrice(): Promise<{ entry: CacheEntry | null; stale: boolean }> {
  if (isFresh(cache)) return { entry: cache, stale: false };

  const stored = await getCachedPrice(PRICE_KEY).catch(() => null);
  if (isFresh(stored)) {
    cache = stored;
    return { entry: stored, stale: false };
  }

  // Collapse concurrent refreshes within this instance into one upstream call.
  if (!inFlight) {
    inFlight = fetchFromSources().finally(() => {
      inFlight = null;
    });
  }

  const fetched = await inFlight;
  if (fetched) {
    cache = fetched;
    await setCachedPrice(PRICE_KEY, fetched).catch(() => {
      // A failed cache write must not fail the request — we still have the price.
    });
    return { entry: fetched, stale: false };
  }

  // Both sources failed. A price from an hour ago is far more useful than none — ETH does not
  // move enough in that window to change any decision this figure informs.
  const fallback = cache ?? stored;
  return { entry: fallback, stale: Boolean(fallback) };
}

ethPrice.get("/", async (_req, res) => {
  const { entry, stale } = await getPrice();

  if (!entry) {
    res.status(503).json({ usd: null, error: "Price feed unavailable" });
    return;
  }

  // Half the TTL so a CDN copy never outlives the server's own idea of freshness.
  res.set("Cache-Control", "public, s-maxage=900, stale-while-revalidate=3600");
  res.json({
    usd: entry.usd,
    fetchedAt: entry.fetchedAt,
    source: entry.source,
    stale,
    ttlSeconds: TTL_MS / 1000,
  });
});
