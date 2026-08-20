import { getMockChain } from "./mock";

/**
 * Off-chain metadata for the demo: token descriptions, social links and user profiles.
 *
 * On a real deployment these live in Turso and the images live in R2. Here they are derived
 * deterministically from the address, so the same token always gets the same blurb and the same
 * user always gets the same handle — the pages look populated without any credentials.
 *
 * Avatars are inline SVG data URIs rather than links to an image host: self-contained, no
 * network request, and nothing to break when the demo is opened offline.
 */

export interface MockTokenMeta {
  address: string;
  description: string;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  discord: string | null;
  imageUrl: string | null;
  bannerUrl: string | null;
}

export interface MockProfile {
  address: string;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string;
  bannerUrl: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  discord: string | null;
  github: string | null;
  createdAt: number;
}

// ---- deterministic helpers ---------------------------------------------------------------------

function seedOf(address: string): number {
  return parseInt(address.slice(2, 10), 16) || 1;
}

function pickBy<T>(seed: number, items: readonly T[], salt = 0): T {
  return items[(seed + salt * 7919) % items.length];
}

// ---- flavour ------------------------------------------------------------------------------------

const BLURBS = [
  "No roadmap. No promises. Just a bonding curve and vibes.",
  "The community token that graduated before the pitch deck existed.",
  "Fair launch, fixed supply, burned LP. Everything else is noise.",
  "Built during Onchain Summer and never went home.",
  "We're not a serious project and that is precisely the point.",
  "1B supply, zero owner keys, one very determined community.",
  "If you're reading this, you're early. Or extremely late.",
  "Started as a joke in a group chat. The curve disagreed.",
  "Pure price discovery. No presale, no team allocation, no unlocks.",
  "Every LP token was burned. Nobody can pull the rug, including us.",
];

const HANDLES = [
  "degenmaxi", "basedanon", "curvechad", "onchainsam", "gm_wizard", "liquidity_ape",
  "bluepilled", "sepolia_whale", "exitliquidity", "diamondgrip", "rugproof", "toshifan",
  "moonboi", "fullport", "copeharder", "sendit", "probablynothing", "numbergoup",
  "wenlambo", "grasstoucher", "anoncap", "higherhighs", "lastbuyer", "infinitemoney",
];

const BIOS = [
  "Trading the curve since block one. Mostly down bad, occasionally not.",
  "Launching coins and touching zero grass. Base maxi.",
  "I read the contract before I ape. Usually.",
  "Onchain since the last cycle. Still here.",
  "Collecting tickers like they're baseball cards.",
  "Liquidity provider by day, exit liquidity by night.",
  "If the LP isn't burned I'm not interested.",
  "Here for the bonding curve mathematics, staying for the memes.",
];

/**
 * A deterministic geometric avatar. Two overlapping gradient shapes keyed off the address, so
 * every account gets a stable, distinguishable mark with no image host involved.
 */
function avatarDataUri(address: string): string {
  const seed = seedOf(address);
  const hue = 190 + (seed % 110);
  const hue2 = (hue + 55) % 360;
  const rotate = seed % 90;
  const radius = 26 + (seed % 18);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
<defs>
<linearGradient id="a" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="hsl(${hue} 88% 62%)"/>
<stop offset="100%" stop-color="hsl(${hue2} 82% 42%)"/>
</linearGradient>
</defs>
<rect width="120" height="120" fill="url(#a)"/>
<circle cx="${40 + (seed % 40)}" cy="${34 + (seed % 30)}" r="${radius}" fill="hsl(${hue2} 90% 72%)" opacity="0.55"/>
<rect x="${20 + (seed % 30)}" y="${58 + (seed % 20)}" width="56" height="56" rx="14" fill="hsl(${hue} 95% 78%)" opacity="0.4" transform="rotate(${rotate} 60 60)"/>
</svg>`;

  // encodeURIComponent keeps this a valid data URI without a base64 round-trip.
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg.replace(/\n/g, ""))}`;
}

// ---- token metadata ------------------------------------------------------------------------------

export function getMockTokenMeta(address: string): MockTokenMeta | null {
  const chain = getMockChain();
  const token = chain.tokens.get(address.toLowerCase());
  if (!token) return null;

  const seed = seedOf(token.address);
  const slug = token.symbol.toLowerCase();

  // Not every token gets every link — a feed where all four icons are always present looks fake.
  return {
    address: token.address,
    description: pickBy(seed, BLURBS),
    website: seed % 3 === 0 ? `https://${slug}.fun` : null,
    twitter: seed % 2 === 0 ? `https://x.com/${slug}` : null,
    telegram: seed % 5 !== 0 ? `https://t.me/${slug}` : null,
    discord: seed % 4 === 0 ? `https://discord.gg/${slug}` : null,
    imageUrl: null, // falls back to the generated TokenAvatar mark
    bannerUrl: null,
  };
}

// ---- profiles --------------------------------------------------------------------------------------

export function getMockProfile(address: string): MockProfile {
  const key = address.toLowerCase();
  const seed = seedOf(key);
  const handle = pickBy(seed, HANDLES);
  // Suffix keeps handles unique when two addresses land on the same base name.
  const username = `${handle}${(seed % 97).toString(36)}`;

  return {
    address: key,
    username,
    displayName: handle.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    bio: pickBy(seed, BIOS, 3),
    avatarUrl: avatarDataUri(key),
    bannerUrl: null,
    website: seed % 4 === 0 ? `https://${handle}.xyz` : null,
    twitter: seed % 2 === 0 ? `https://x.com/${handle}` : null,
    telegram: seed % 3 === 0 ? `https://t.me/${handle}` : null,
    discord: null,
    github: seed % 6 === 0 ? `https://github.com/${handle}` : null,
    createdAt: Math.floor(Date.now() / 1000) - (seed % 5_000_000),
  };
}

/** Reverse lookup so `/u/<username>` resolves in demo mode. */
export function findMockProfileByUsername(username: string): MockProfile | null {
  const needle = username.toLowerCase();
  const chain = getMockChain();

  for (const address of chain.accounts()) {
    const profile = getMockProfile(address);
    if (profile.username === needle) return profile;
  }
  return null;
}
