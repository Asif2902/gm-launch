import { socialLabel, type SocialPlatform } from "@/lib/socials";
import { PLATFORM_LABEL, SocialIcon } from "./SocialIcons";

export interface SocialSet {
  website?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  discord?: string | null;
  github?: string | null;
}

const ORDER: SocialPlatform[] = ["website", "twitter", "telegram", "discord", "github"];

/**
 * Row of social links.
 *
 * `rel="noopener noreferrer nofollow ugc"` on every link: these URLs are user-submitted, so the
 * target must not get a handle on our window, must not receive our referrer, and must not
 * inherit any search-ranking signal. The scheme is already restricted to http(s) at write time
 * (`lib/socials.ts`), which is the actual protection against `javascript:` hrefs.
 */
export function SocialLinks({
  links,
  size = "md",
  showLabels = false,
  className = "",
}: {
  links: SocialSet;
  size?: "sm" | "md";
  showLabels?: boolean;
  className?: string;
}) {
  const present = ORDER.filter((platform) => Boolean(links[platform]));
  if (present.length === 0) return null;

  const iconSize = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  const padding = showLabels ? "gap-1.5 px-2.5 py-1.5" : "p-2";

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {present.map((platform) => {
        const href = links[platform]!;
        return (
          <a
            key={platform}
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow ugc"
            title={`${PLATFORM_LABEL[platform]} · ${socialLabel(platform, href)}`}
            aria-label={`${PLATFORM_LABEL[platform]} (opens in a new tab)`}
            className={`inline-flex items-center rounded-lg border border-line bg-elevated/70 text-muted transition-all duration-200 hover:-translate-y-0.5 hover:border-brand/50 hover:text-white ${padding}`}
          >
            <SocialIcon platform={platform} className={iconSize} />
            {showLabels && (
              <span className="text-xs font-semibold">{socialLabel(platform, href)}</span>
            )}
          </a>
        );
      })}
    </div>
  );
}
