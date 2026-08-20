/**
 * Deterministic identicon derived from the token address.
 *
 * Tokens carry no off-chain metadata by design (spec §7 — nothing critical may live outside the
 * chain), so the visual identity is generated from the address itself: same address, same mark,
 * everywhere, with no image host to depend on. Hues are biased toward the Base-blue half of the
 * wheel so a wall of them still reads as one product.
 */
export function TokenAvatar({
  address,
  symbol,
  size = 44,
  glow = false,
}: {
  address: string;
  symbol: string;
  size?: number;
  glow?: boolean;
}) {
  const seed = parseInt(address.slice(2, 10), 16) || 0;
  // 190°–290° keeps every mark in the cyan→blue→violet range.
  const hue = 190 + (seed % 100);
  const hue2 = hue + 40;

  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {glow && (
        <div
          className="absolute inset-0 rounded-2xl opacity-60 blur-lg"
          style={{ background: `hsl(${hue} 85% 55%)` }}
        />
      )}
      <div
        className="relative grid h-full w-full place-items-center rounded-2xl font-black text-white"
        style={{
          fontSize: size * 0.3,
          letterSpacing: "-0.02em",
          background: `linear-gradient(140deg, hsl(${hue} 88% 60%), hsl(${hue2} 80% 42%))`,
          boxShadow: "inset 0 1px 0 rgb(255 255 255 / 0.25)",
        }}
      >
        {symbol.slice(0, 3).toUpperCase()}
      </div>
    </div>
  );
}
