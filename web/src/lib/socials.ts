/**
 * Normalisation and validation for user-supplied links.
 *
 * These strings end up in `href` attributes, so the parsing here is a security boundary, not a
 * convenience: only `http` and `https` survive. `javascript:`, `data:`, `vbscript:` and
 * protocol-relative `//evil.com` are all rejected rather than sanitised, because a link that
 * cannot be safely represented should not be stored at all.
 *
 * Handles are accepted as well as URLs — people type `@someone` far more often than a full
 * profile URL — and are expanded to the canonical form for their platform.
 */

export type SocialPlatform = "website" | "twitter" | "telegram" | "discord" | "github";

export const SOCIAL_LIMITS = {
  description: 500,
  bio: 280,
  username: 20,
  displayName: 32,
  url: 200,
} as const;

const SAFE_PROTOCOLS = new Set(["http:", "https:"]);

/** Parses a full URL, returning null unless it is a plain http(s) address. */
function safeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.length > SOCIAL_LIMITS.url) return null;

  // Protocol-relative URLs inherit the page's scheme and hide the host from a casual read.
  if (trimmed.startsWith("//")) return null;

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(candidate);
    if (!SAFE_PROTOCOLS.has(url.protocol)) return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Strips a leading `@` and any surrounding whitespace from a handle. */
function handle(raw: string): string | null {
  const cleaned = raw.trim().replace(/^@+/, "");
  if (cleaned === "") return null;
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(cleaned)) return null;
  return cleaned;
}

/** Pulls the final path segment out of a URL, e.g. `x.com/foo` -> `foo`. */
function lastSegment(url: string): string | null {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split("/").filter(Boolean).pop();
    return segment ?? null;
  } catch {
    return null;
  }
}

/**
 * Normalises one social field. Returns `null` for empty input (meaning "not set") and throws
 * for input that is present but unusable, so the caller can surface a specific message.
 */
export function normaliseSocial(platform: SocialPlatform, raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim();
  if (value === "") return null;

  const looksLikeUrl = value.includes("/") || value.includes(".");

  switch (platform) {
    case "website": {
      const url = safeUrl(value);
      if (!url) throw new Error("Website must be a valid http(s) link");
      return url;
    }

    case "twitter": {
      if (looksLikeUrl) {
        const url = safeUrl(value);
        const segment = url ? lastSegment(url) : null;
        if (!segment) throw new Error("Could not read an X handle from that link");
        return `https://x.com/${segment}`;
      }
      const name = handle(value);
      if (!name) throw new Error("Invalid X handle");
      return `https://x.com/${name}`;
    }

    case "telegram": {
      if (looksLikeUrl) {
        const url = safeUrl(value);
        const segment = url ? lastSegment(url) : null;
        if (!segment) throw new Error("Could not read a Telegram handle from that link");
        return `https://t.me/${segment}`;
      }
      const name = handle(value);
      if (!name) throw new Error("Invalid Telegram handle");
      return `https://t.me/${name}`;
    }

    case "discord": {
      // Discord invites are opaque codes; only the invite hosts are meaningful here.
      const url = safeUrl(value);
      if (url) {
        const host = new URL(url).hostname.replace(/^www\./, "");
        if (host === "discord.gg" || host === "discord.com" || host === "discordapp.com") {
          return url;
        }
        throw new Error("Discord link must be a discord.gg or discord.com invite");
      }
      const code = handle(value);
      if (!code) throw new Error("Invalid Discord invite");
      return `https://discord.gg/${code}`;
    }

    case "github": {
      if (looksLikeUrl) {
        const url = safeUrl(value);
        const segment = url ? lastSegment(url) : null;
        if (!segment) throw new Error("Could not read a GitHub handle from that link");
        return `https://github.com/${segment}`;
      }
      const name = handle(value);
      if (!name) throw new Error("Invalid GitHub handle");
      return `https://github.com/${name}`;
    }
  }
}

/** Short label for a normalised link, e.g. `https://x.com/foo` -> `@foo`. */
export function socialLabel(platform: SocialPlatform, url: string): string {
  if (platform === "website") {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  }
  if (platform === "discord") return "Discord";
  const segment = lastSegment(url);
  return segment ? `@${segment}` : url;
}

/** Usernames are the public identity in a profile URL, so keep the character set tight. */
export function validateUsername(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value.length < 3) throw new Error("Username must be at least 3 characters");
  if (value.length > SOCIAL_LIMITS.username) {
    throw new Error(`Username must be at most ${SOCIAL_LIMITS.username} characters`);
  }
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new Error("Username can only contain letters, numbers and underscores");
  }
  // Would otherwise collide with /u/<address> style lookups.
  if (/^0x/.test(value)) throw new Error("Username cannot start with 0x");
  return value;
}

export function clampText(raw: string | null | undefined, limit: number): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value === "") return null;
  return value.length > limit ? value.slice(0, limit) : value;
}
