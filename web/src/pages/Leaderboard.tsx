import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";

import { AccountLabel, useProfiles } from "@/components/Account";
import { DataError, NotConfigured } from "@/components/DataError";
import { Usd } from "@/components/Money";
import {
  api,
  type LeaderboardBoard,
  type LeaderboardSort,
  type LeaderboardWindow,
} from "@/lib/api";
import { IS_CONFIGURED } from "@/lib/config";
import { timeAgo } from "@/lib/format";
import type { UserProfile } from "@/lib/metaApi";
import type { LeaderboardCreator, LeaderboardTrader } from "@/lib/types";

/**
 * Who is actually doing well on the launchpad.
 *
 * Two boards, because "best" means two different things here: traders are ranked on what they
 * moved and what it was worth, creators on what they launched and whether it graduated.
 *
 * The PnL column is the one number worth being careful about. It is realised cash flow plus the
 * current value of what the account still holds, which is only a true profit figure over the
 * all-time window — over 24h it would credit an account for a position it bought last month. So
 * choosing PnL switches the window to all-time rather than quietly reporting a different thing
 * under the same heading.
 *
 * Which controls exist at all depends on the answering source. A subgraph-backed deployment has
 * lifetime counters and no cash flow, so it gets no window pills and no PnL column — an inert
 * "24h" tab showing all-time numbers would be worse than not offering one.
 */

const WINDOWS: Array<{ value: LeaderboardWindow; label: string }> = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All time" },
];

const TRADER_SORTS: Array<{ value: LeaderboardSort; label: string }> = [
  { value: "volume", label: "Volume" },
  { value: "pnl", label: "PnL" },
  { value: "trades", label: "Trades" },
];

const CREATOR_SORTS: Array<{ value: LeaderboardSort; label: string }> = [
  { value: "volume", label: "Volume" },
  { value: "graduated", label: "Graduated" },
  { value: "tokens", label: "Launched" },
  { value: "marketCap", label: "Market cap" },
];

export function LeaderboardPage() {
  const { address } = useAccount();

  const [board, setBoard] = useState<LeaderboardBoard>("traders");
  const [sort, setSort] = useState<LeaderboardSort>("volume");
  const [range, setRange] = useState<LeaderboardWindow>("24h");

  const pnlMode = board === "traders" && sort === "pnl";
  const effectiveWindow: LeaderboardWindow = pnlMode ? "all" : range;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["leaderboard", board, sort, effectiveWindow],
    queryFn: () => api.leaderboard({ board, sort, window: effectiveWindow, limit: 100 }),
    refetchInterval: 20_000,
    enabled: IS_CONFIGURED,
  });

  const entries = data?.entries ?? [];
  // One lookup for the whole board, so ranked wallets read as people.
  const profiles = useProfiles(entries.map((entry) => entry.address));
  // Assume the richer source until one answers, so the controls don't flicker on first paint.
  const capabilities = data?.capabilities ?? { windows: true, pnl: true };

  // A source that cannot compute PnL must not leave the page ranked by it.
  useEffect(() => {
    if (!capabilities.pnl && sort === "pnl") setSort("volume");
  }, [capabilities.pnl, sort]);

  const sorts = (board === "traders" ? TRADER_SORTS : CREATOR_SORTS).filter(
    (option) => option.value !== "pnl" || capabilities.pnl,
  );
  const showPnl = board === "traders" && capabilities.pnl;

  const switchBoard = (next: LeaderboardBoard) => {
    setBoard(next);
    // "Graduated" is meaningless for a trader and "PnL" for a creator; volume exists on both.
    setSort("volume");
  };

  if (!IS_CONFIGURED) return <NotConfigured />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Leaderboard</h1>
          <p className="mt-1 text-xs text-muted">
            {board === "traders"
              ? "Ranked on launchpad trades — buys and sells on the bonding curve."
              : "Ranked on the tokens each wallet has launched."}
          </p>
        </div>

        <div className="segmented">
          {(["traders", "creators"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => switchBoard(value)}
              data-active={board === value}
              className="segmented-item capitalize"
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="segmented scrollbar-none overflow-x-auto">
          {sorts.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setSort(option.value)}
              data-active={sort === option.value}
              className="segmented-item whitespace-nowrap"
            >
              {option.label}
            </button>
          ))}
        </div>

        {capabilities.windows ? (
          <div className="segmented scrollbar-none overflow-x-auto">
            {WINDOWS.map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={pnlMode}
                onClick={() => setRange(option.value)}
                data-active={effectiveWindow === option.value}
                className="segmented-item whitespace-nowrap disabled:opacity-40"
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : (
          <span
            className="chip border-line bg-elevated/70 text-muted"
            title="This deployment reads from a subgraph, which keeps lifetime totals rather than time buckets"
          >
            All time
          </span>
        )}

        {pnlMode && (
          <span className="text-[11px] text-dim">
            PnL is all-time: realised cash flow plus the value of open positions.
          </span>
        )}
      </div>

      {isError ? (
        <DataError
          title="Couldn't load the rankings"
          error={error}
          onRetry={() => void refetch()}
        />
      ) : (
      <div className="card overflow-hidden">
        <div className="scrollbar-none overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-hairline text-left">
                <Th className="w-14 pl-4">#</Th>
                <Th>Account</Th>
                {board === "traders" ? (
                  <>
                    <Th align="right">Volume</Th>
                    <Th align="right">Trades</Th>
                    <Th align="right" className={showPnl ? "" : "pr-4"}>
                      Tokens
                    </Th>
                    {showPnl && (
                      <Th align="right" className="pr-4">
                        PnL
                      </Th>
                    )}
                  </>
                ) : (
                  <>
                    <Th align="right">Volume</Th>
                    <Th align="right">Launched</Th>
                    <Th align="right">Graduated</Th>
                    <Th align="right" className="pr-4">
                      Market cap
                    </Th>
                  </>
                )}
              </tr>
            </thead>

            <tbody>
              {isLoading &&
                Array.from({ length: 10 }).map((_, index) => (
                  <tr key={index} className="border-b border-hairline/60">
                    <td colSpan={6} className="px-4 py-3">
                      <div className="shimmer h-5 rounded bg-elevated" />
                    </td>
                  </tr>
                ))}

              {!isLoading &&
                entries.map((entry, index) =>
                  board === "traders" ? (
                    <TraderRow
                      key={entry.address}
                      rank={index + 1}
                      entry={entry as LeaderboardTrader}
                      showPnl={showPnl}
                      profile={profiles[entry.address.toLowerCase()]}
                      you={entry.address.toLowerCase() === address?.toLowerCase()}
                    />
                  ) : (
                    <CreatorRow
                      key={entry.address}
                      rank={index + 1}
                      entry={entry as LeaderboardCreator}
                      profile={profiles[entry.address.toLowerCase()]}
                      you={entry.address.toLowerCase() === address?.toLowerCase()}
                    />
                  ),
                )}
            </tbody>
          </table>
        </div>

        {!isLoading && entries.length === 0 && (
          <p className="p-10 text-center text-sm text-muted">
            {data?.unsupported
              ? "This indexer doesn't serve rankings yet — it needs a build with the /leaderboard endpoint."
              : "Nothing in this window yet."}
          </p>
        )}
      </div>
      )}
    </div>
  );
}

function TraderRow({
  rank,
  entry,
  showPnl,
  profile,
  you,
}: {
  rank: number;
  entry: LeaderboardTrader;
  showPnl: boolean;
  profile?: UserProfile | null;
  you: boolean;
}) {
  const pnl = entry.pnl == null ? null : BigInt(entry.pnl);

  return (
    <tr className="group border-b border-hairline/60 transition-colors last:border-0 hover:bg-elevated/50">
      <Rank rank={rank} />
      <Account
        address={entry.address}
        profile={profile}
        you={you}
        subtitle={entry.last_trade_at ? `last trade ${timeAgo(entry.last_trade_at)}` : undefined}
      />
      <Td align="right">
        <Usd wei={entry.volume} className="font-semibold" />
      </Td>
      <Td align="right" muted>
        {entry.trades.toLocaleString()}
      </Td>
      <Td align="right" muted className={showPnl ? "" : "pr-4"}>
        {entry.tokens}
      </Td>
      {showPnl && (
        <Td align="right" className="pr-4">
          {pnl === null ? (
            <span className="text-dim">—</span>
          ) : (
            <span
              className={`font-semibold ${
                pnl > 0n ? "text-up-light" : pnl < 0n ? "text-down-light" : "text-muted"
              }`}
            >
              {pnl > 0n && "+"}
              <Usd wei={entry.pnl} />
            </span>
          )}
        </Td>
      )}
    </tr>
  );
}

function CreatorRow({
  rank,
  entry,
  profile,
  you,
}: {
  rank: number;
  entry: LeaderboardCreator;
  profile?: UserProfile | null;
  you: boolean;
}) {
  return (
    <tr className="group border-b border-hairline/60 transition-colors last:border-0 hover:bg-elevated/50">
      <Rank rank={rank} />
      <Account
        address={entry.address}
        profile={profile}
        you={you}
        subtitle={
          entry.last_created_at ? `last launch ${timeAgo(entry.last_created_at)}` : undefined
        }
      />
      <Td align="right">
        <Usd wei={entry.volume} className="font-semibold" />
      </Td>
      <Td align="right" muted>
        {entry.tokens_created}
      </Td>
      <Td align="right">
        <span className={entry.tokens_migrated > 0 ? "font-semibold text-brand-light" : "text-dim"}>
          {entry.tokens_migrated}
        </span>
      </Td>
      <Td align="right" className="pr-4">
        <Usd wei={entry.market_cap} className="font-semibold" />
      </Td>
    </tr>
  );
}

/** Medals for the top three; a plain number after that. */
function Rank({ rank }: { rank: number }) {
  const medal =
    rank === 1
      ? "bg-gold/15 text-gold ring-gold/30"
      : rank === 2
        ? "bg-white/10 text-white ring-white/20"
        : rank === 3
          ? "bg-down/15 text-down-light ring-down/25"
          : "";

  return (
    <td className="py-2.5 pl-4">
      {medal ? (
        <span
          className={`tnum grid h-6 w-6 place-items-center rounded-full text-xs font-bold ring-1 ${medal}`}
        >
          {rank}
        </span>
      ) : (
        <span className="tnum pl-1.5 text-xs text-dim">{rank}</span>
      )}
    </td>
  );
}

function Account({
  address,
  profile,
  you,
  subtitle,
}: {
  address: string;
  profile?: UserProfile | null;
  you: boolean;
  subtitle?: string;
}) {
  return (
    <td className="py-2.5">
      <Link to={`/u/${profile?.username ?? address}`} className="flex items-center gap-2.5">
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <AccountLabel
              address={address}
              profile={profile}
              size={26}
              nameLength={5}
              nameClassName="text-[13px] font-semibold group-hover:text-brand-light"
            />
            {you && (
              <span className="shrink-0 rounded bg-brand/15 px-1.5 py-0.5 text-[10px] font-bold text-brand-light">
                You
              </span>
            )}
          </span>
          {subtitle && <span className="ml-[34px] block text-[11px] text-dim">{subtitle}</span>}
        </span>
      </Link>
    </td>
  );
}

function Th({
  children,
  align = "left",
  className = "",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <th
      className={`label py-2.5 font-semibold ${align === "right" ? "text-right" : ""} ${className}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  muted = false,
  className = "",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  muted?: boolean;
  className?: string;
}) {
  return (
    <td
      className={`tnum py-2.5 ${align === "right" ? "text-right" : ""} ${
        muted ? "text-muted" : ""
      } ${className}`}
    >
      {children}
    </td>
  );
}
