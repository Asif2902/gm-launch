/**
 * Deterministic round mark for a wallet address.
 *
 * Every address gets *something* — a blank circle next to a row of hex is worse than a
 * generated one, and most addresses on a launchpad will never upload a picture. The hue comes
 * from the address itself, so the same wallet looks the same in the ticker, the feed and the
 * leaderboard without a lookup.
 *
 * `src` takes over when a profile avatar exists, since a chosen picture always beats a computed
 * one.
 */
export function AddressAvatar({
  address,
  src,
  size = 20,
  className = "",
}: {
  address: string;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const seed = parseInt(address.slice(2, 10), 16) || 0;
  // Same 190°–290° band as the token art, so accounts and tokens read as one product.
  const hue = 190 + (seed % 100);
  // A second stop plus an off-centre highlight gives each mark a little structure, so two
  // neighbouring hues are still distinguishable at 20px.
  const tilt = 25 + ((seed >> 8) % 90);

  if (src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        loading="lazy"
        decoding="async"
        className={`shrink-0 rounded-full object-cover ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={`shrink-0 rounded-full ${className}`}
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 30% 25%, hsl(${hue + 40} 90% 68%), hsl(${hue} 80% 46%) 45%, hsl(${hue + tilt} 70% 24%))`,
        boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.12)",
      }}
    />
  );
}
