import { TokenStatus } from "@/lib/config";

/**
 * Status is always spelled out in words — colour is a reinforcement, never the sole carrier of
 * meaning.
 *
 * `overlay` is for badges sitting on top of token artwork. The uploaded image is arbitrary and
 * could be any colour, so the translucent chip backgrounds that read fine on a dark card can wash
 * out completely there; the overlay variant swaps in an opaque dark base plus a blur so the label
 * is legible over anything.
 */
export function StatusBadge({
  status,
  bps,
  overlay = false,
}: {
  status: number;
  bps?: number;
  overlay?: boolean;
}) {
  // A token in the last stretch of the curve gets its own treatment; that's the moment degens
  // care about, and it is genuinely different information from "still trading".
  const nearlyThere = status === TokenStatus.Trading && (bps ?? 0) >= 8_000;
  const base = overlay ? "bg-canvas/75 backdrop-blur-md" : "";

  if (status === TokenStatus.Migrated) {
    return (
      <span className={`chip border-brand/40 text-brand-light ${base || "bg-brand/15"}`}>
        <BurnIcon />
        Graduated
      </span>
    );
  }

  if (status === TokenStatus.PendingMigration) {
    return (
      <span
        className={`chip animate-pulse border-gold/45 text-gold shadow-glow-gold ${
          base || "bg-gold/15"
        }`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-gold" />
        Migrating
      </span>
    );
  }

  if (nearlyThere) {
    return (
      <span className={`chip border-up/45 text-up-light ${base || "bg-up/15"}`}>
        <span className="live-dot" />
        Almost there
      </span>
    );
  }

  return (
    <span className={`chip border-line text-muted ${base || "bg-elevated/70"}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-dim" />
      On curve
    </span>
  );
}

function BurnIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden>
      <path
        d="M6 1c1.5 2 3.5 3 3.5 5.5A3.5 3.5 0 0 1 6 10a3.5 3.5 0 0 1-3.5-3.5C2.5 4.5 4.5 3.5 6 1Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
