import { formatEth, formatPriceGwei, formatUsd } from "@/lib/format";
import { useEthPrice, usdFromTokenPrice, usdFromWei } from "@/lib/ethPrice";

/**
 * USD display with an ETH fallback.
 *
 * Centralised so the fallback is consistent: if the price feed is down, every figure quietly
 * reverts to ETH rather than showing "—" or, worse, a stale-looking `$0.00`. ETH is always
 * correct because it is the unit the protocol actually denominates in — USD is a convenience
 * layer, and the UI should degrade to the truth rather than to nothing.
 */

/** A wei amount — market cap, volume, reserves, portfolio value. */
export function Usd({
  wei,
  className = "",
  compact = true,
  compactFrom,
  showEth = false,
}: {
  wei: bigint | string | null | undefined;
  className?: string;
  /** Compact large values to K/M/B. */
  compact?: boolean;
  /** Compact to "K" from this value up. Defaults to 10,000; pass 1,000 in tight layouts. */
  compactFrom?: number;
  /** Append the ETH amount in muted text, for figures where the unit matters. */
  showEth?: boolean;
}) {
  const { usd: rate } = useEthPrice();

  if (wei === null || wei === undefined) return <span className={className}>—</span>;

  const value = usdFromWei(wei, rate);

  if (value === null) {
    return (
      <span className={className}>
        {formatEth(wei)}
        <span className="ml-1 text-[0.7em] font-normal text-dim">ETH</span>
      </span>
    );
  }

  return (
    <span className={className}>
      {formatUsd(value, { compact, compactFrom })}
      {showEth && (
        <span className="ml-1.5 text-[0.7em] font-normal text-dim">{formatEth(wei)} ETH</span>
      )}
    </span>
  );
}

/**
 * A token price — wei per whole token.
 *
 * These land far below a cent (a fresh curve is ~5e-10 ETH), which is why the formatter uses
 * subscript notation instead of rounding to `$0.00`.
 */
export function UsdPrice({
  price,
  className = "",
  showGwei = false,
}: {
  price: bigint | string | null | undefined;
  className?: string;
  showGwei?: boolean;
}) {
  const { usd: rate } = useEthPrice();

  if (price === null || price === undefined) return <span className={className}>—</span>;

  const value = usdFromTokenPrice(price, rate);

  if (value === null) {
    return (
      <span className={className}>
        {formatPriceGwei(price)}
        <span className="ml-1 text-[0.7em] font-normal text-dim">gwei</span>
      </span>
    );
  }

  return (
    <span className={className}>
      {formatUsd(value, { compact: false })}
      {showGwei && (
        <span className="ml-1.5 text-[0.7em] font-normal text-dim">
          {formatPriceGwei(price)} gwei
        </span>
      )}
    </span>
  );
}

/** Small ETH/USD readout for the header, so the source of every USD figure is visible. */
export function EthRate({ className = "" }: { className?: string }) {
  const { usd, stale } = useEthPrice();
  if (usd === null) return null;

  return (
    <span
      className={className}
      title={
        stale
          ? "Price feed is temporarily unavailable — showing the last known rate"
          : "ETH/USD, cached for 30 minutes"
      }
    >
      ETH{" "}
      <span className={stale ? "text-warn" : "text-white"}>
        ${usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
      </span>
    </span>
  );
}
