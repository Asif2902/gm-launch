import { PROTOCOL } from "@/lib/config";
import { formatEth } from "@/lib/format";

interface Props {
  /** Migration progress in basis points (0–10000). */
  bps: number;
  /** Real ETH held by the curve, in wei. Shown as "x / 5 ETH" when provided. */
  ethReserve?: bigint | string;
  showLabel?: boolean;
  size?: "sm" | "md" | "lg";
}

/**
 * Progress toward the 5 ETH migration threshold, measured on the curve's *real* ETH reserve
 * (net of platform fees) — the same quantity the contract tests against.
 */
export function ProgressBar({ bps, ethReserve, showLabel = true, size = "md" }: Props) {
  const clamped = Math.max(0, Math.min(10_000, Number(bps)));
  const percent = clamped / 100;
  const complete = clamped >= 10_000;
  const hot = clamped >= 8_000;

  const height = size === "sm" ? "h-1.5" : size === "lg" ? "h-3" : "h-2";

  return (
    <div className="w-full">
      {showLabel && (
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span className="label">
            {complete ? "Curve filled" : "Bonding curve"}
          </span>
          <span
            className={`tnum text-xs font-bold ${
              complete ? "text-gold" : hot ? "text-up-light" : "text-white"
            }`}
          >
            {percent.toFixed(1)}%
          </span>
        </div>
      )}

      <div
        className={`relative w-full overflow-hidden rounded-full bg-elevated ${height}`}
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Bonding curve progress toward migration"
      >
        <div
          className="relative h-full rounded-full transition-[width] duration-700 ease-out"
          style={{
            width: `${Math.max(percent, clamped > 0 ? 2 : 0)}%`,
            background: complete
              ? "linear-gradient(90deg, #FFB020, #F0B90B)"
              : hot
                ? "linear-gradient(90deg, #0CA678, #20D9A0)"
                : "linear-gradient(90deg, #0038B8, #0052FF, #4C8DFF)",
            boxShadow: complete
              ? "0 0 12px rgb(255 176 32 / 0.65)"
              : hot
                ? "0 0 12px rgb(32 217 160 / 0.55)"
                : "0 0 12px rgb(0 82 255 / 0.55)",
          }}
        >
          {/* Travelling highlight — reads as "this is still filling". */}
          {!complete && clamped > 0 && (
            <span className="shimmer absolute inset-0 rounded-full" />
          )}
        </div>
      </div>

      {ethReserve !== undefined && showLabel && (
        <div className="tnum mt-2 flex items-baseline justify-between text-xs">
          <span className="text-muted">
            <span className="font-semibold text-white">{formatEth(ethReserve)}</span>
            {" / "}
            {formatEth(PROTOCOL.migrationThreshold)} ETH
          </span>
          <span className="text-dim">
            {complete ? "ready for Uniswap" : `${formatEth(BigInt(PROTOCOL.migrationThreshold) - BigInt(ethReserve))} ETH to go`}
          </span>
        </div>
      )}
    </div>
  );
}
