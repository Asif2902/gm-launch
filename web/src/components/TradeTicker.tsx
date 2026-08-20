import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { api } from "@/lib/api";
import { IS_CONFIGURED } from "@/lib/config";
import { formatTokenAmount } from "@/lib/format";
import { AccountLabel, useProfiles } from "./Account";

/**
 * Continuously scrolling strip of the newest trades across the whole launchpad.
 *
 * The track holds two copies of the list and translates by exactly -50%, so the loop is seamless
 * with no JS measuring. It pauses on hover so a passing trade can actually be read and clicked.
 *
 * Each chip reads as a sentence — who, what, how much, which coin — rather than a row of figures,
 * because this is peripheral vision: it has to land in the half-second it is in front of you.
 */
export function TradeTicker() {
  const { data } = useQuery({
    queryKey: ["recent-trades"],
    queryFn: () => api.recentTrades(22),
    refetchInterval: 4_000,
    enabled: IS_CONFIGURED,
  });

  const trades = data?.trades ?? [];

  // One lookup for every trader on the strip, so a wallet with a profile shows as a person.
  // Called before the early return: hooks cannot run conditionally.
  const profiles = useProfiles(trades.map((trade) => trade.trader));

  if (trades.length === 0) return null;

  const track = [...trades, ...trades];

  return (
    <div className="mask-x group relative overflow-hidden border-b border-line/70 bg-canvas py-1.5">
      <div className="flex w-max animate-marquee gap-1.5 group-hover:[animation-play-state:paused]">
        {track.map((trade, index) => {
          const isBuy = trade.side === 0;

          return (
            <Link
              key={`${trade.tx_hash}-${trade.log_index}-${index}`}
              to={`/token/${trade.token}`}
              className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                isBuy
                  ? "border-up/30 bg-up/[0.06] hover:border-up/60"
                  : "border-down/30 bg-down/[0.06] hover:border-down/60"
              }`}
            >
              <AccountLabel
                address={trade.trader}
                profile={profiles[trade.trader.toLowerCase()]}
                size={14}
                nameLength={3}
                nameClassName="max-w-[110px] text-muted"
              />
              <span className={`font-bold ${isBuy ? "text-up-light" : "text-down-light"}`}>
                {isBuy ? "BOUGHT" : "SOLD"}
              </span>
              <span className="tnum font-semibold text-white">
                {formatTokenAmount(trade.token_amount, 0)}
              </span>
              <span className="text-dim">of</span>
              <span className="font-semibold text-brand-light">{trade.symbol}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
