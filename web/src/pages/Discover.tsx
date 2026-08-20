import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useState } from "react";

import { useProfiles } from "@/components/Account";
import { DataError, NotConfigured } from "@/components/DataError";
import { TokenCard } from "@/components/TokenCard";
import { TokenCover } from "@/components/TokenCover";
import { Usd } from "@/components/Money";
import { api, type TokenSort } from "@/lib/api";
import { IS_CONFIGURED, TokenStatus } from "@/lib/config";
import { fetchTokenMetaBatch } from "@/lib/metaApi";
import type { IndexedToken } from "@/lib/types";

/**
 * The feed. Everything else on the site is reachable from here, so it opens straight onto
 * tokens: a strip of what is moving, one row of controls, then the grid.
 *
 * There is deliberately no hero. A launchpad's landing page is a market, and a screen of
 * marketing copy above the market is a screen of tokens you cannot see — the protocol's terms
 * live in the footer and on the create page, where someone is actually deciding to use them.
 */

const SORTS: Array<{ value: TokenSort; label: string }> = [
  { value: "lastTrade", label: "Latest trade" },
  { value: "marketCap", label: "Market cap" },
  { value: "volume", label: "24h volume" },
  { value: "newest", label: "Newest" },
  { value: "progress", label: "Graduating" },
];

const FILTERS: Array<{ value: number | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: TokenStatus.Trading, label: "On curve" },
  { value: TokenStatus.PendingMigration, label: "Migrating" },
  { value: TokenStatus.Migrated, label: "Graduated" },
];

export function DiscoverPage() {
  const [sort, setSort] = useState<TokenSort>("lastTrade");
  const [status, setStatus] = useState<number | "all">("all");
  const [search, setSearch] = useState("");

  // Nothing deployed means nothing to ask for — every query would fail identically.
  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: api.stats,
    refetchInterval: 8_000,
    enabled: IS_CONFIGURED,
  });

  const trending = useQuery({
    queryKey: ["trending"],
    queryFn: () => api.tokens({ sort: "volume", status: TokenStatus.Trading, limit: 6 }),
    refetchInterval: 15_000,
    enabled: IS_CONFIGURED,
  });

  const tokens = useQuery({
    queryKey: ["tokens", sort, status, search],
    queryFn: () => api.tokens({ sort, status, q: search || undefined, limit: 60 }),
    refetchInterval: 6_000,
    enabled: IS_CONFIGURED,
  });

  // One batched metadata request covering both the trending strip and the grid, rather than a
  // fetch per card. Keyed on the address list so it only refires when the set of visible tokens
  // actually changes — not on every 6s price refresh.
  const addresses = [
    ...(trending.data?.tokens ?? []),
    ...(tokens.data?.tokens ?? []),
  ].map((token) => token.address);
  const uniqueAddresses = [...new Set(addresses)];

  const meta = useQuery({
    queryKey: ["token-meta", uniqueAddresses.join(",")],
    queryFn: () => fetchTokenMetaBatch(uniqueAddresses),
    enabled: uniqueAddresses.length > 0,
    staleTime: 60_000,
  });

  const metaFor = (address: string) => meta.data?.[address.toLowerCase()];

  // Creator identities for the whole grid in one lookup.
  const creators = useProfiles((tokens.data?.tokens ?? []).map((token) => token.creator));

  if (!IS_CONFIGURED) return <NotConfigured />;

  return (
    <div className="space-y-5">
      {/* ---- trending ---------------------------------------------------------------------- */}
      {(trending.data?.tokens.length ?? 0) > 0 && (
        <section>
          <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="font-display text-base font-bold tracking-tight">Trending now 🔥</h2>

            {/* Protocol scale, sized as a caption. It is context for the feed, not a headline. */}
            <p className="tnum flex flex-wrap items-center gap-x-3 text-[11px] text-dim">
              <span>
                <span className="font-semibold text-muted">{stats.data?.tokens ?? "—"}</span> tokens
              </span>
              <span>
                <span className="font-semibold text-muted">{stats.data?.migrated ?? "—"}</span>{" "}
                graduated
              </span>
              <span className="flex items-center gap-1">
                <Usd wei={stats.data?.volume_24h ?? "0"} className="font-semibold text-muted" />
                24h volume
              </span>
            </p>
          </div>

          <div className="scrollbar-none -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {trending.data?.tokens.map((token, index) => (
              <TrendingCard
                key={token.address}
                token={token}
                rank={index + 1}
                imageUrl={metaFor(token.address)?.imageUrl}
              />
            ))}
          </div>
        </section>
      )}

      {/* ---- controls ---------------------------------------------------------------------- */}
      <section id="feed" className="flex scroll-mt-20 flex-wrap items-center gap-2">
        <div className="tabs scrollbar-none order-2 overflow-x-auto sm:order-1">
          {SORTS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setSort(option.value)}
              data-active={sort === option.value}
              className="tab whitespace-nowrap"
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="order-1 ml-auto flex flex-1 items-center gap-2 sm:order-2 sm:flex-none">
          <div className="relative min-w-[180px] flex-1 sm:w-56 sm:flex-none">
            <SearchIcon />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, ticker, address"
              className="input rounded-full py-2 pl-9 text-xs"
            />
          </div>

          <div className="segmented scrollbar-none overflow-x-auto">
            {FILTERS.map((filter) => (
              <button
                key={String(filter.value)}
                type="button"
                onClick={() => setStatus(filter.value)}
                data-active={status === filter.value}
                className="segmented-item whitespace-nowrap"
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ---- feed -------------------------------------------------------------------------- */}
      {tokens.isLoading && <SkeletonGrid />}

      {tokens.isError && (
        <DataError
          title="Couldn't load the feed"
          error={tokens.error}
          onRetry={() => void tokens.refetch()}
        />
      )}

      {tokens.data && tokens.data.tokens.length === 0 && (
        <div className="card p-16 text-center">
          <p className="text-lg font-bold">Nothing here yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            {search
              ? `No token matches "${search}".`
              : "Be the first to launch one — all it takes is a name and a ticker."}
          </p>
          <Link to="/create" className="btn-primary mt-6">
            Create the first token
          </Link>
        </div>
      )}

      {tokens.data && tokens.data.tokens.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {tokens.data.tokens.map((token, index) => (
            <TokenCard
              key={token.address}
              token={token}
              meta={metaFor(token.address)}
              creator={creators[token.creator.toLowerCase()]}
              index={index}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Compact entry in the trending strip: art, ticker, name, market cap. */
function TrendingCard({
  token,
  rank,
  imageUrl,
}: {
  token: IndexedToken;
  rank: number;
  imageUrl?: string | null;
}) {
  return (
    <Link
      to={`/token/${token.address}`}
      className="group flex w-[240px] shrink-0 items-center gap-3 rounded-xl border border-line bg-surface p-2.5 transition-all duration-200 hover:-translate-y-0.5 hover:border-brand/50"
    >
      <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg">
        <TokenCover address={token.address} symbol={token.symbol} imageUrl={imageUrl} />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="tnum text-[10px] font-bold text-dim">#{rank}</span>
          <span className="truncate rounded bg-raised px-1.5 font-display text-[10px] font-bold">
            {token.symbol}
          </span>
        </span>
        <span className="mt-0.5 block truncate font-display text-[13px] font-bold group-hover:text-brand-light">
          {token.name}
        </span>
        <span className="tnum mt-0.5 block text-[10px] text-dim">
          MC <Usd wei={token.market_cap} compactFrom={1_000} className="font-semibold text-muted" />
        </span>
      </span>
    </Link>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-dim"
      fill="none"
      aria-hidden
    >
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function SkeletonGrid() {
  // Mirrors the real card's shape — square cover, then body — so the feed doesn't jump.
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, index) => (
        <div
          key={index}
          className="card animate-fade-up overflow-hidden"
          style={{ animationDelay: `${index * 40}ms` }}
        >
          <div className="shimmer aspect-square w-full bg-elevated" />
          <div className="space-y-2.5 p-3.5">
            <div className="shimmer h-5 w-1/3 rounded bg-elevated" />
            <div className="shimmer h-5 w-2/3 rounded bg-elevated" />
            <div className="shimmer h-10 rounded bg-elevated" />
          </div>
          <div className="shimmer h-12 border-t border-hairline bg-elevated/50" />
        </div>
      ))}
    </div>
  );
}
