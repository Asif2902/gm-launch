/**
 * Shared UI marks, drawn inline.
 *
 * These exist because emoji don't work as icons. An emoji is rendered by the *platform's* font,
 * so the same character is a flat glyph on one machine and a glossy 3D sticker on another; it
 * ignores `currentColor`, so it can't tint with the gold "ready to graduate" text it sits beside;
 * its metrics are set by the emoji font rather than the layout, so it drifts off the baseline and
 * shrugs off `h-*`/`w-*`; and it carries a name a screen reader will announce ("rocket") whether
 * or not that helps.
 *
 * Inline SVG has none of those problems, matches the social marks and the per-file glyphs used
 * elsewhere in the app, adds no network request, and survives a strict CSP.
 */

interface IconProps {
  className?: string;
}

/** Migration imminent — the curve is about to fill and send the token to Uniswap. */
export function RocketIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinejoin="round"
      strokeLinecap="round"
      className={className}
      aria-hidden
    >
      {/* Deliberately chunky — the body spans ~43% of the viewBox and the window is a filled dot.
          A narrower, more "accurate" rocket turns to mush at the 14px this is usually drawn at. */}
      <path d="M8 1.3c2.4 2.4 3.6 5 3.4 7.7L8 11.2 4.6 9C4.4 6.3 5.6 3.7 8 1.3Z" />
      <path d="M4.7 8.5 2.8 10.3l.4 2.5 2.2-1.4M11.3 8.5l1.9 1.8-.4 2.5-2.2-1.4" />
      <path d="M8 12v2.4" />
      <circle cx="8" cy="5.4" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Marks a link that leaves the app — an explorer, a creator's site. */
export function ExternalLinkIcon({ className = "h-3 w-3" }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`inline-block shrink-0 align-[-0.1em] ${className}`}
      aria-hidden
    >
      <path d="M6.5 3.5h6v6" />
      <path d="M12.5 3.5 7 9" />
      <path d="M11 9.8v2.7a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 2 12.5v-6A1.5 1.5 0 0 1 3.5 5h2.7" />
    </svg>
  );
}
