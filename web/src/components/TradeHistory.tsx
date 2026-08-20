import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useState } from "react";

import { api } from "@/lib/api";
import { explorerTx } from "@/lib/config";
import { formatEth, formatTokenAmount, shortAddress, timeAgo } from "@/lib/format";
import { UsdPrice } from "./Money";
import type { IndexedHolder, IndexedTrade } from "@/lib/types";

type Tab = "trades" | "holders";

export function ActivityPanel({ address, symbol }: { address: string; symbol: string }) {
  const [tab, setTab] = useState<Tab>("trades");

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-1 border-b border-line px-2">
        {(
          [
            ["trades", "Live trades"],
            ["holders", "Holders"],
          ] as Array<[Tab, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`relative px-3 py-3 text-sm font-semibold transition-colors ${
              tab === value ? "text-white" : "text-muted hover:text-white"
            }`}
          >
            {label}
            {tab === value && (
              <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-brand shadow-glow-sm" />
            )}
          </button>
        ))}

        {tab === "trades" && (
          <span className="ml-auto mr-3 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-dim">
            <span className="live-dot" />
            live
          </span>
        )}
      </div>

      {tab === "trades" ? (
        <TradeTable address={address} symbol={symbol} />
      ) : (
        <HolderTable address={address} symbol={symbol} />
      )}
    </div>
  );
}

function TradeTable({ address, symbol }: { address: string; symbol: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["trades", address],
    queryFn: () => api.trades(address, 100),
    refetchInterval: 4_000,
  });

  if (isLoading) return <Placeholder>Loading trades…</Placeholder>;
  if (isError) return <Placeholder>Trade history unavailable.</Placeholder>;
  if (!data || data.trades.length === 0) return <Placeholder>No trades yet.</Placeholder>;

  return (
    <div className="max-h-[440px] overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-surface/95 backdrop-blur">
          <tr className="border-b border-line">
            <Th>Type</Th>
            <Th>Trader</Th>
            <Th align="right">ETH</Th>
            <Th align="right">{symbol}</Th>
            <Th align="right">Price</Th>
            <Th align="right">Age</Th>
          </tr>
        </thead>
        <tbody>
          {data.trades.map((trade: IndexedTrade, index: number) => {
            const isBuy = trade.side === 0;
            return (
              <tr
                key={`${trade.tx_hash}-${trade.log_index}`}
                className="animate-slide-in-left border-b border-hairline transition-colors last:border-0 hover:bg-elevated/50"
                // Only the freshest rows stagger, so the table doesn't re-cascade on every poll.
                style={{ animationDelay: index < 8 ? `${index * 35}ms` : "0ms" }}
              >
                <Td>
                  {/* Direction is carried by the word, not only by colour. */}
                  <span
                    className={`inline-flex items-center gap-1.5 font-bold ${
                      isBuy ? "text-up-light" : "text-down-light"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${isBuy ? "bg-up" : "bg-down"}`}
                    />
                    {isBuy ? "Buy" : "Sell"}
                  </span>
                </Td>
                <Td>
                  {/* Internal link: a trader's profile is more useful here than a block explorer. */}
                  <Link
                    to={`/u/${trade.trader}`}
                    className="font-mono text-xs text-muted transition-colors hover:text-brand-light"
                  >
                    {shortAddress(trade.trader, 3)}
                  </Link>
                </Td>
                <Td align="right" mono>
                  {formatEth(isBuy ? trade.eth_in : trade.eth_out)}
                </Td>
                <Td align="right" mono>
                  {formatTokenAmount(trade.token_amount)}
                </Td>
                <Td align="right" mono muted>
                  <UsdPrice price={trade.price} />
                </Td>
                <Td align="right">
                  <a
                    href={explorerTx(trade.tx_hash)}
                    target="_blank"
                    rel="noreferrer"
                    className="whitespace-nowrap text-xs text-dim transition-colors hover:text-brand-light"
                  >
                    {timeAgo(trade.timestamp)}
                  </a>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HolderTable({ address, symbol }: { address: string; symbol: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["holders", address],
    queryFn: () => api.holders(address, 100),
    refetchInterval: 12_000,
  });

  if (isLoading) return <Placeholder>Loading holders…</Placeholder>;
  if (isError) return <Placeholder>Holder data unavailable.</Placeholder>;
  if (!data || data.holders.length === 0) return <Placeholder>No holders yet.</Placeholder>;

  const top = data.holders[0] ? Number(data.holders[0].share_bps ?? 0) : 0;

  return (
    <div className="max-h-[440px] overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-surface/95 backdrop-blur">
          <tr className="border-b border-line">
            <Th>#</Th>
            <Th>Holder</Th>
            <Th align="right">{symbol}</Th>
            <Th align="right">Share</Th>
          </tr>
        </thead>
        <tbody>
          {data.holders.map((holder: IndexedHolder, index: number) => {
            const share = Number(holder.share_bps ?? 0);
            return (
              <tr
                key={holder.address}
                className="relative border-b border-hairline last:border-0 hover:bg-elevated/50"
              >
                <Td muted>{index + 1}</Td>
                <Td>
                  <Link
                    to={`/u/${holder.address}`}
                    className="font-mono text-xs text-muted transition-colors hover:text-brand-light"
                  >
                    {shortAddress(holder.address, 5)}
                  </Link>
                </Td>
                <Td align="right" mono>
                  {formatTokenAmount(holder.balance)}
                </Td>
                <Td align="right" mono>
                  <span className="relative inline-flex items-center gap-2">
                    {/* Bar length encodes the share relative to the largest holder. */}
                    <span className="h-1 w-10 overflow-hidden rounded-full bg-elevated">
                      <span
                        className="block h-full rounded-full bg-brand"
                        style={{ width: `${top > 0 ? (share / top) * 100 : 0}%` }}
                      />
                    </span>
                    {(share / 100).toFixed(2)}%
                  </span>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className={`px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-dim ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  mono,
  muted,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  mono?: boolean;
  muted?: boolean;
}) {
  return (
    <td
      className={`px-4 py-2.5 ${align === "right" ? "text-right" : "text-left"} ${
        mono ? "tnum" : ""
      } ${muted ? "text-dim" : ""}`}
    >
      {children}
    </td>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-16 text-center text-sm text-muted">{children}</div>;
}
