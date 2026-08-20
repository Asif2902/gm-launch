import { formatUnits } from "viem";

const SUBSCRIPTS = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];

function toSubscript(count: number): string {
  return String(count)
    .split("")
    .map((digit) => SUBSCRIPTS[Number(digit)])
    .join("");
}

/**
 * Compact fixed-point rendering that stays readable across ~15 orders of magnitude.
 *
 * Bonding-curve prices start around 5e-10 ETH, so plain `toFixed` would render every young
 * token as "0.000000". Long runs of leading zeros collapse to subscript notation
 * (`0.0₉5` = 0.0000000005), the same convention DEX aggregators use.
 */
export function formatDecimal(value: bigint, decimals: number, significant = 4): string {
  if (value === 0n) return "0";

  const raw = formatUnits(value, decimals);
  const [whole, fraction = ""] = raw.split(".");

  if (whole !== "0") {
    const wholeNumber = Number(whole);
    if (wholeNumber >= 1_000_000) return `${(wholeNumber / 1_000_000).toFixed(2)}M`;
    if (wholeNumber >= 1_000) return `${(wholeNumber / 1_000).toFixed(2)}K`;
    const decimalsToShow = wholeNumber >= 100 ? 2 : wholeNumber >= 1 ? 4 : 6;
    return Number(raw).toFixed(decimalsToShow).replace(/\.?0+$/, "");
  }

  const leadingZeros = fraction.length - fraction.replace(/^0+/, "").length;
  const digits = fraction.slice(leadingZeros, leadingZeros + significant).replace(/0+$/, "");
  if (digits === "") return "0";

  if (leadingZeros >= 4) return `0.0${toSubscript(leadingZeros)}${digits}`;
  return `0.${"0".repeat(leadingZeros)}${digits}`;
}

/** ETH amount (wei) for display, e.g. "1.2345". */
export function formatEth(wei: bigint | string, significant = 4): string {
  return formatDecimal(BigInt(wei), 18, significant);
}

/** Price in wei-per-whole-token rendered as ETH. */
export function formatPrice(price: bigint | string): string {
  return formatDecimal(BigInt(price), 18, 4);
}

/**
 * Price rendered in **gwei per token**, the unit the UI leads with.
 *
 * Stored prices are wei per whole token, which puts a fresh curve at 5e-10 ETH — every young
 * token would read as `0.000000`. Gwei maps the whole lifecycle onto `0.5 → 60.5` (genesis →
 * migration) with no precision loss, since the values sit far below 2^53.
 */
export function formatPriceGwei(price: bigint | string, digits = 3): string {
  const gwei = Number(BigInt(price)) / 1e9;
  if (gwei === 0) return "0";
  if (gwei >= 100) return gwei.toFixed(1);
  if (gwei >= 1) return gwei.toFixed(2);
  return gwei.toFixed(digits);
}

/** Token amount in base units rendered as whole tokens with thousands separators. */
export function formatTokenAmount(amount: bigint | string, maximumFractionDigits = 2): string {
  const value = Number(formatUnits(BigInt(amount), 18));
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toLocaleString(undefined, { maximumFractionDigits });
}

/** Full-precision token amount, for input fields and balances. */
export function formatTokenExact(amount: bigint | string): string {
  return Number(formatUnits(BigInt(amount), 18)).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
}

/**
 * USD for display, across the full range this app produces.
 *
 * A token price can be a millionth of a cent while a graduated market cap is six figures, so a
 * single `toFixed` is wrong at one end or the other. Long runs of leading zeros collapse to
 * subscript notation (`$0.0₅151`), and large values compact to K/M/B.
 */
export function formatUsd(
  value: number | null,
  options: { compact?: boolean; compactFrom?: number } = {},
): string {
  if (value === null || !Number.isFinite(value)) return "—";

  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(value);

  // Anything below a trillionth of a cent is zero for display purposes. Without this floor a
  // near-zero axis tick renders as "$0.0₂₀0", which is noise pretending to be precision.
  if (magnitude < 1e-12) return "$0";

  if (options.compact !== false) {
    if (magnitude >= 1_000_000_000) return `${sign}$${(magnitude / 1_000_000_000).toFixed(2)}B`;
    if (magnitude >= 1_000_000) return `${sign}$${(magnitude / 1_000_000).toFixed(2)}M`;
    // Thousands compact later than millions by default, because "$12,480.55" is still readable
    // and more precise. Dense contexts — a card strip, a ticker — pass a lower threshold, where
    // the exact cents are noise and the column width is the binding constraint.
    if (magnitude >= (options.compactFrom ?? 10_000)) {
      return `${sign}$${(magnitude / 1_000).toFixed(1)}K`;
    }
  }

  if (magnitude >= 1) {
    return `${sign}$${magnitude.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (magnitude >= 0.01) return `${sign}$${magnitude.toFixed(4)}`;

  // Sub-cent: count the leading zeros and subscript them rather than rounding to nothing.
  const text = magnitude.toFixed(20);
  const fraction = text.split(".")[1] ?? "";
  const leadingZeros = fraction.length - fraction.replace(/^0+/, "").length;
  const digits = fraction.slice(leadingZeros, leadingZeros + 3).replace(/0+$/, "") || "0";

  if (leadingZeros >= 4) return `${sign}$0.0${toSubscript(leadingZeros)}${digits}`;
  return `${sign}$0.${"0".repeat(leadingZeros)}${digits}`;
}

export function shortAddress(address: string, size = 4): string {
  if (!address || address.length < 2 * size + 2) return address;
  return `${address.slice(0, 2 + size)}…${address.slice(-size)}`;
}

export function timeAgo(timestampSeconds: number | string | bigint): string {
  const seconds = Math.floor(Date.now() / 1000) - Number(timestampSeconds);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(Number(timestampSeconds) * 1000).toLocaleDateString();
}

export function formatPercent(bps: number | string, digits = 1): string {
  return `${(Number(bps) / 100).toFixed(digits)}%`;
}

/**
 * Price change, switching to a multiplier past 10x.
 *
 * A token can climb 121x from genesis to graduation, and "+8788.8%" is a number nobody parses
 * at a glance. "89.9×" is the same fact, readable instantly.
 */
export function formatChange(percent: number): string {
  if (!Number.isFinite(percent)) return "—";
  if (percent >= 900) return `${(percent / 100 + 1).toFixed(1)}×`;
  if (percent <= -99.5) return "-99.9%";
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(percent >= 100 ? 0 : 1)}%`;
}

/** Parses a user-typed decimal into base units, tolerating empty and partial input. */
export function parseAmount(input: string, decimals = 18): bigint {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed === ".") return 0n;
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  try {
    return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
  } catch {
    return 0n;
  }
}
