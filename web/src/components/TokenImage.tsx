import { TokenAvatar } from "./TokenAvatar";

/**
 * A token's picture: the uploaded image when one exists, otherwise the generated address mark.
 *
 * The fallback matters. Image hosting is off-chain and optional, so a token must look complete
 * without it — the generated mark is deterministic from the address, so a token with no upload
 * still gets a stable identity rather than a broken-image icon or a grey box.
 */
export function TokenImage({
  address,
  symbol,
  imageUrl,
  size = 44,
  glow = false,
  className = "",
}: {
  address: string;
  symbol: string;
  imageUrl?: string | null;
  size?: number;
  glow?: boolean;
  className?: string;
}) {
  if (!imageUrl) {
    return <TokenAvatar address={address} symbol={symbol} size={size} glow={glow} />;
  }

  return (
    <div className={`relative shrink-0 ${className}`} style={{ width: size, height: size }}>
      {glow && (
        <div
          className="absolute inset-0 rounded-2xl bg-brand/40 blur-lg"
          aria-hidden
        />
      )}
      <img
        src={imageUrl}
        alt={`${symbol} logo`}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        className="relative h-full w-full rounded-2xl object-cover"
        style={{ boxShadow: "inset 0 1px 0 rgb(255 255 255 / 0.18)" }}
      />
    </div>
  );
}
