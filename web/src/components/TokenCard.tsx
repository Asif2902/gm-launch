import { Link } from "react-router-dom";

import { formatChange, timeAgo } from "@/lib/format";
import { Usd } from "./Money";
import type { TokenMeta, UserProfile } from "@/lib/metaApi";
import type { IndexedToken } from "@/lib/types";
import { AccountLabel } from "./Account";
import { SocialLinks } from "./SocialLinks";
import { StatusBadge } from "./StatusBadge";
import { TokenCover } from "./TokenCover";

/**
 * A token in the feed, built image-first.
 *
 * The picture is the card's largest element and its identity — a 40px avatar beside a wall of
 * numbers made every token look like every other token. Everything below it is ordered the way
 * it gets read: what it's called, what it says it is, how it's moving, who made it, and finally
 * the pair of figures that decide whether you click.
 *
 * That last pair is **market cap now and market cap at its peak**, side by side. One number alone
 * says nothing about a memecoin: $28K is a fresh launch or a corpse depending entirely on whether
 * it was ever $3M, and putting the two together is the fastest honest summary of a token's life
 * that fits on a card.
 *
 * The image is square rather than 4:3 because that is the shape people upload: a square frame
 * shows a logo whole instead of cropping or letterboxing it.
 */
export function TokenCard({
  token,
  meta,
  creator,
  index = 0,
}: {
  token: IndexedToken;
  meta?: TokenMeta | null;
  /** The creator's profile, when they have one — looked up in bulk by the feed. */
  creator?: UserProfile | null;
  index?: number;
}) {
  const bps = Number(token.migration_progress_bps);
  const percent = Math.max(0, Math.min(100, bps / 100));

  const change = changeOver24h(token);

  // Absent on deployments whose indexer or subgraph predates the field. The peak is never below
  // the present, so the current cap is the honest floor to fall back to.
  const ath = token.ath_market_cap ?? null;

  return (
    <Link
      to={`/token/${token.address}`}
      className="group card card-hover flex animate-fade-up flex-col overflow-hidden"
      // Staggered entrance so a grid of cards cascades rather than snapping in at once.
      style={{ animationDelay: `${Math.min(index, 11) * 40}ms` }}
    >
      {/* ---- artwork ------------------------------------------------------------------------ */}
      <div className="relative aspect-square w-full overflow-hidden">
        <TokenCover address={token.address} symbol={token.symbol} imageUrl={meta?.imageUrl} />

        {/* Status is the only thing allowed to sit on the artwork; the rest of the card is
            below it, where text is legible whatever the user uploaded. */}
        <div className="absolute right-3 top-3">
          <StatusBadge status={token.status} bps={bps} overlay />
        </div>
      </div>

      {/* ---- identity ----------------------------------------------------------------------- */}
      <div className="flex flex-1 flex-col gap-2.5 p-3.5">
        <div>
          <span className="inline-block rounded-md bg-raised px-2 py-0.5 font-display text-xs font-bold tracking-wide text-white">
            {token.symbol}
          </span>
          <h3 className="mt-2 truncate font-display text-[17px] font-bold leading-tight transition-colors group-hover:text-brand-light">
            {token.name}
          </h3>
          <p className="mt-1 line-clamp-1 text-xs leading-relaxed text-muted">
            {meta?.description || `${token.trade_count} trades · ${token.buy_count} buys`}
          </p>
        </div>

        {/* ---- the moving numbers ---- */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] font-semibold text-dim">
              24h
            </span>
            <span
              className={`tnum font-bold ${
                change === null
                  ? "text-dim"
                  : change >= 0
                    ? "text-up-light"
                    : "text-down-light"
              }`}
            >
              {change === null ? "—" : formatChange(change)}
            </span>
          </span>

          <span className="flex items-center gap-1.5">
            <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] font-semibold text-dim">
              Vol
            </span>
            <Usd
              wei={token.volume_24h ?? "0"}
              compactFrom={1_000}
              className="tnum font-semibold text-white"
            />
          </span>

          <span className="ml-auto flex items-center gap-1 text-muted">
            <HolderIcon />
            <span className="tnum font-semibold text-white">
              {compactCount(token.holder_count)}
            </span>
          </span>
        </div>

        {/* ---- who and when ---- */}
        <div className="flex items-center justify-between gap-2 text-xs">
          <AccountLabel
            address={token.creator}
            profile={creator}
            size={18}
            nameLength={3}
            nameClassName="text-muted"
          />
          {meta && (meta.website || meta.twitter || meta.telegram || meta.discord) ? (
            <SocialLinks links={meta} size="sm" className="origin-right scale-90" />
          ) : (
            <span className="shrink-0 text-dim">{timeAgo(token.created_at)}</span>
          )}
        </div>
      </div>

      {/* ---- valuation strip -----------------------------------------------------------------
          Pinned to the bottom of the card, full-bleed, so the figures and the progress bars line
          up across a row of cards whose descriptions run to different lengths. */}
      <div className="mt-auto border-t border-hairline bg-elevated/50">
        <div className="flex items-baseline justify-between gap-2 px-3.5 py-2.5">
          <span className="flex items-baseline gap-1.5">
            <span className="text-[11px] font-semibold text-dim">MC</span>
            <Usd
              wei={token.market_cap}
              compactFrom={1_000}
              className="tnum text-sm font-bold text-white"
            />
          </span>
          <span className="flex items-baseline gap-1.5">
            <span className="text-[11px] font-semibold text-dim">ATH</span>
            {ath === null ? (
              <span className="tnum text-sm font-bold text-dim" title="Needs an updated indexer">
                —
              </span>
            ) : (
              <Usd wei={ath} compactFrom={1_000} className="tnum text-sm font-bold text-gold" />
            )}
          </span>
        </div>

        {/* Runs the full width of the card, flush to its edges — the card's own progress toward
            graduation, read as a fill line rather than as another number. */}
        <div
          className="h-1.5 w-full bg-raised"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${percent.toFixed(1)}% toward migration`}
        >
          <div
            className="h-full transition-[width] duration-700 ease-out"
            style={{
              width: `${Math.max(percent, bps > 0 ? 1.5 : 0)}%`,
              background:
                percent >= 100
                  ? "linear-gradient(90deg, #FFB020, #F0B90B)"
                  : percent >= 80
                    ? "linear-gradient(90deg, #0CA678, #20D9A0)"
                    : "linear-gradient(90deg, #0052FF, #4C8DFF)",
              boxShadow:
                percent >= 100
                  ? "0 0 10px rgb(255 176 32 / 0.5)"
                  : percent >= 80
                    ? "0 0 10px rgb(32 217 160 / 0.45)"
                    : "0 0 10px rgb(0 82 255 / 0.45)",
            }}
          />
        </div>
      </div>
    </Link>
  );
}

/**
 * Percentage move over the last 24 hours.
 *
 * Prefers the indexer's `open_24h`, which is the first trade price inside the window and so is
 * genuinely 24-hour. The sparkline is the fallback: it is only the last 24 *trades*, which on a
 * quiet token can reach back weeks — close enough to draw a shape, not close enough to label as
 * a daily change unless there is nothing better.
 */
function changeOver24h(token: IndexedToken): number | null {
  const open = token.open_24h ? Number(token.open_24h) : 0;
  const price = Number(token.price);
  if (open > 0 && price > 0) return (price / open - 1) * 100;

  const points = token.sparkline;
  if (points && points.length >= 2) {
    const first = Number(points[0]);
    const last = Number(points[points.length - 1]);
    if (first > 0) return (last / first - 1) * 100;
  }

  return null;
}

/** Holder counts run to five figures on a popular token; the card has room for four characters. */
function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function HolderIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="h-3.5 w-3.5"
      aria-hidden
    >
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 13.25a5 5 0 0 1 10 0" strokeLinecap="round" />
    </svg>
  );
}
