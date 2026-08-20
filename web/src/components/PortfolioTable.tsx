import { Link } from "react-router-dom";

import { formatTokenAmount } from "@/lib/format";
import { Usd, UsdPrice } from "./Money";
import type { Portfolio } from "@/lib/apiTypes";
import type { TokenMeta } from "@/lib/metaApi";
import { StatusBadge } from "./StatusBadge";
import { TokenImage } from "./TokenImage";

/**
 * An address's open positions, valued at the live curve (or pool) price.
 *
 * Balances come from ERC-20 Transfer logs rather than launchpad trade events, so a position
 * stays accurate even when it was acquired by a peer-to-peer send or bought on Uniswap after
 * the token graduated — neither of which the launchpad ever sees.
 */
export function PortfolioTable({
  portfolio,
  meta,
}: {
  portfolio: Portfolio;
  meta?: Record<string, TokenMeta>;
}) {
  if (portfolio.holdings.length === 0) {
    return (
      <div className="card px-4 py-14 text-center">
        <p className="text-sm font-semibold">No open positions</p>
        <p className="mx-auto mt-1.5 max-w-xs text-xs text-muted">
          Tokens bought on the curve — or received from anyone — will show up here.
        </p>
        <Link to="/" className="btn-primary mt-5">
          Browse tokens
        </Link>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              <Th>Token</Th>
              <Th align="right">Balance</Th>
              <Th align="right">Price</Th>
              <Th align="right">Value</Th>
              <Th align="right">Supply</Th>
            </tr>
          </thead>
          <tbody>
            {portfolio.holdings.map((holding, index) => (
              <tr
                key={holding.token}
                className="animate-fade-up border-b border-hairline transition-colors last:border-0 hover:bg-elevated/50"
                style={{ animationDelay: `${Math.min(index, 10) * 35}ms` }}
              >
                <td className="px-4 py-3">
                  <Link to={`/token/${holding.token}`} className="group flex items-center gap-2.5">
                    <TokenImage
                      address={holding.token}
                      symbol={holding.symbol}
                      imageUrl={meta?.[holding.token.toLowerCase()]?.imageUrl}
                      size={30}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-semibold transition-colors group-hover:text-brand-light">
                        {holding.name}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="font-mono text-[10px] text-dim">{holding.symbol}</span>
                        {holding.status === 3 && <StatusBadge status={3} />}
                      </span>
                    </span>
                  </Link>
                </td>
                <Td align="right">{formatTokenAmount(holding.balance)}</Td>
                <Td align="right" muted>
                  <UsdPrice price={holding.price} />
                </Td>
                <Td align="right" strong>
                  <Usd wei={holding.valueWei} />
                </Td>
                <Td align="right" muted>
                  {(holding.shareBps / 100).toFixed(2)}%
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
  muted,
  strong,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  muted?: boolean;
  strong?: boolean;
}) {
  return (
    <td
      className={`tnum px-4 py-3 ${align === "right" ? "text-right" : "text-left"} ${
        muted ? "text-muted" : ""
      } ${strong ? "font-bold" : ""}`}
    >
      {children}
    </td>
  );
}
