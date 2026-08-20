/**
 * Full-bleed cover art for a token — the thing you actually see first in the feed.
 *
 * Two cases, and both have to fill the frame completely, because a card with a hole in it reads
 * as broken:
 *
 *   - **Uploaded image.** Drawn `object-contain` over a blurred, over-scaled copy of itself. A
 *     plain `object-cover` would crop a square logo top and bottom to fill a 4:3 frame, which is
 *     exactly the part of a logo people mean to show. Contain-over-blur keeps the whole image
 *     visible whatever its shape, and the blurred layer supplies the colour behind it.
 *   - **No upload.** A generated poster: gradient, drifting light, diagonal texture and the
 *     ticker set large. Derived entirely from the address, so the same token always gets the same
 *     poster — no image host, nothing to go missing (spec §7: nothing critical lives off-chain).
 *
 * The ticker is drawn as SVG text in a fixed viewBox rather than styled HTML, so it scales with
 * the card instead of needing a breakpoint per column count.
 */
export function TokenCover({
  address,
  symbol,
  imageUrl,
  className = "",
}: {
  address: string;
  symbol: string;
  imageUrl?: string | null;
  className?: string;
}) {
  if (imageUrl) {
    return (
      <div className={`absolute inset-0 overflow-hidden bg-elevated ${className}`}>
        <img
          src={imageUrl}
          alt=""
          aria-hidden
          loading="lazy"
          decoding="async"
          className="absolute inset-0 h-full w-full scale-125 object-cover opacity-70 blur-2xl"
        />
        <div className="absolute inset-0 bg-canvas/25" />
        <img
          src={imageUrl}
          alt={`${symbol} logo`}
          loading="lazy"
          decoding="async"
          className="relative h-full w-full object-contain transition-transform duration-500 ease-out group-hover:scale-[1.06]"
        />
      </div>
    );
  }

  const seed = parseInt(address.slice(2, 10), 16) || 0;
  // 190°–290° keeps every generated poster in the cyan → blue → violet range, so a full grid of
  // them still reads as one product rather than a paint chart.
  const hue = 190 + (seed % 100);
  const glyphs = symbol.slice(0, 5).toUpperCase() || "?";
  const fontSize = [40, 40, 38, 32, 25, 20][glyphs.length] ?? 20;

  return (
    <div
      className={`absolute inset-0 overflow-hidden ${className}`}
      style={{
        background: `linear-gradient(155deg, hsl(${hue} 88% 58%), hsl(${hue + 25} 78% 32%) 55%, hsl(${hue + 45} 70% 14%))`,
      }}
      aria-hidden
    >
      <div
        className="absolute -left-1/4 -top-1/4 h-[85%] w-[85%] animate-drift rounded-full blur-2xl"
        style={{ background: `hsl(${hue + 35} 95% 62% / 0.55)` }}
      />
      <div
        className="absolute -bottom-1/3 -right-1/4 h-[90%] w-[90%] animate-drift rounded-full blur-2xl"
        style={{ background: `hsl(${hue - 30} 92% 48% / 0.45)`, animationDelay: "-8s" }}
      />

      {/* Hand-drawn-feeling diagonal texture: also the fallback that carries identity when
          colour is unavailable (forced-colors, print, heavy CVD). */}
      <div
        className="absolute inset-0 opacity-[0.13]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(45deg, #fff 0 2px, transparent 2px 11px)",
        }}
      />

      <svg
        viewBox="0 0 120 90"
        preserveAspectRatio="xMidYMid meet"
        className="absolute inset-0 h-full w-full transition-transform duration-500 ease-out group-hover:scale-[1.06]"
      >
        <text
          x="60"
          y="46"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={fontSize}
          fontWeight="900"
          letterSpacing="-1.5"
          fill="#fff"
          fillOpacity="0.94"
          style={{ paintOrder: "stroke", filter: "drop-shadow(0 2px 8px rgb(0 0 0 / 0.45))" }}
        >
          {glyphs}
        </text>
      </svg>
    </div>
  );
}
