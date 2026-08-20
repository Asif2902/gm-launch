import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useNavigate, useParams } from "react-router-dom";
import { useState } from "react";
import { isAddress } from "viem";
import { useAccount } from "wagmi";

import { PortfolioTable } from "@/components/PortfolioTable";
import { ProfileEditor } from "@/components/ProfileEditor";
import { SocialLinks } from "@/components/SocialLinks";
import { TokenImage } from "@/components/TokenImage";
import { explorerAddress } from "@/lib/config";
import { shortAddress, timeAgo } from "@/lib/format";
import { Usd } from "@/components/Money";
import {
  fetchProfile,
  fetchProfileByUsername,
  fetchTokenMetaBatch,
  type UserProfile,
} from "@/lib/metaApi";
import { api } from "@/lib/api";
import { ExternalLinkIcon } from "@/components/Icons";

type Tab = "portfolio" | "created";

/**
 * Public profile.
 *
 * The `[handle]` segment resolves either way — `/u/degenmaxi` or `/u/0xabc…` — so a profile is
 * always reachable by address even before the owner has claimed a username.
 *
 * The two halves come from different places on purpose: identity (avatar, handle, bio, links)
 * is off-chain in Turso because it is mutable and cosmetic, while the portfolio is derived from
 * chain events and is not editable by anyone, including the profile's owner. Someone can style
 * their page however they like; they cannot misrepresent what they hold.
 */
export function ProfilePage() {
  const params = useParams();
  const navigate = useNavigate();
  const handle = String(params.handle ?? "");
  const { address: connected } = useAccount();

  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<Tab>("portfolio");

  const isAddressHandle = isAddress(handle);

  const profileQuery = useQuery({
    queryKey: ["profile", handle],
    queryFn: () =>
      isAddressHandle ? fetchProfile(handle) : fetchProfileByUsername(handle),
    enabled: handle.length > 0,
    // A missing profile resolves to null; only an unreachable service throws. Retrying that a
    // few times is what turns a brief API blip into a page that fills itself in rather than one
    // that has to be reloaded by hand.
    retry: 3,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
  });

  // Rendered straight from the query, never from local editor state. If a save didn't actually
  // persist, the page shows that immediately instead of masking it with an optimistic copy.
  const profile = profileQuery.data ?? null;
  const address = profile?.address ?? (isAddressHandle ? handle.toLowerCase() : null);

  const portfolioQuery = useQuery({
    queryKey: ["portfolio", address],
    queryFn: () => api.portfolio(address!),
    enabled: Boolean(address),
    refetchInterval: 15_000,
  });

  const heldAddresses = [
    ...(portfolioQuery.data?.holdings.map((holding) => holding.token) ?? []),
    ...(portfolioQuery.data?.created ?? []),
  ];

  const metaQuery = useQuery({
    queryKey: ["token-meta", heldAddresses.join(",")],
    queryFn: () => fetchTokenMetaBatch(heldAddresses),
    enabled: heldAddresses.length > 0,
    staleTime: 60_000,
  });

  const isOwn = Boolean(connected && address && connected.toLowerCase() === address);

  if (!address && !profileQuery.isLoading) {
    return (
      <div className="card p-16 text-center">
        <p className="text-lg font-bold">No profile here</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">
          Nobody has claimed <span className="font-mono text-white">@{handle}</span> yet.
        </p>
        <Link to="/" className="btn-primary mt-6">
          Back to discover
        </Link>
      </div>
    );
  }

  if (!address) return <div className="card shimmer h-64" />;

  const portfolio = portfolioQuery.data;
  const displayName = profile?.displayName || profile?.username || shortAddress(address, 4);

  return (
    <div className="space-y-4">
      {editing ? (
        <ProfileEditor
          profile={profile}
          onSaved={async (saved) => {
            setEditing(false);
            // Re-read from the server so what's displayed is what's stored.
            await profileQuery.refetch();
            // A username change moves the canonical URL; keep the address form as-is.
            if (!isAddressHandle && saved.username && saved.username !== handle) {
              navigate(`/u/${saved.username}`, { replace: true });
            }
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <section className="glass animate-fade-up overflow-hidden">
          {/* Banner: the uploaded image if there is one, otherwise a deterministic gradient. */}
          <div className="relative h-28 sm:h-36">
            {profile?.bannerUrl ? (
              <img src={profile.bannerUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div
                className="h-full w-full"
                style={{
                  background: `linear-gradient(120deg, hsl(${
                    220 + (parseInt(address.slice(2, 6), 16) % 60)
                  } 70% 22%), #0C0E13)`,
                }}
              />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-surface via-transparent to-transparent" />
          </div>

          {/* `relative` is load-bearing: the banner's overlay is absolutely positioned, and a
              positioned element paints above later *non*-positioned siblings regardless of DOM
              order. Without this the name is drawn underneath the banner gradient. */}
          <div className="relative px-5 pb-5">
            <div className="-mt-10 flex flex-wrap items-end gap-4">
              <div className="rounded-2xl ring-4 ring-surface">
                <TokenImage
                  address={address}
                  symbol={(profile?.username ?? address.slice(2)).slice(0, 3)}
                  imageUrl={profile?.avatarUrl}
                  size={76}
                />
              </div>

              <div className="min-w-0 flex-1 pb-1">
                <h1 className="truncate text-2xl font-black tracking-tight">{displayName}</h1>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dim">
                  {profile?.username && (
                    <span className="font-semibold text-brand-light">@{profile.username}</span>
                  )}
                  <a
                    href={explorerAddress(address)}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono transition-colors hover:text-brand-light"
                  >
                    {shortAddress(address, 5)} <ExternalLinkIcon />
                  </a>
                </p>
              </div>

              {isOwn && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className={profile ? "btn-ghost btn-sm" : "btn-primary btn-sm"}
                >
                  {profile ? "Edit profile" : "Set up profile"}
                </button>
              )}
            </div>

            {profile?.bio && (
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">{profile.bio}</p>
            )}

            {/* No stored profile: show the address identity plainly rather than inventing one.
                An unreachable service is reported as such — claiming "no profile" when we simply
                could not look would be asserting an absence we have no evidence for. */}
            {profileQuery.isError && (
              <p className="mt-3 text-sm text-warn">
                Couldn&apos;t load this profile. The rest of the page is read from the chain and
                is unaffected.
              </p>
            )}

            {/* Only a *successful* read can claim an absence. Testing for "not loading and not
                errored" instead let a query that had merely not answered yet — pending, or
                paused because the browser is offline — render as a confident "no profile". */}
            {profileQuery.isSuccess && !profile && (
              <p className="mt-3 text-sm text-dim">
                {isOwn
                  ? "You haven't set up a profile yet."
                  : "This address hasn't set up a profile."}
              </p>
            )}

            {profile && <SocialLinks links={profile} showLabels className="mt-3" />}

            <dl className="mt-5 grid grid-cols-2 gap-x-8 gap-y-4 border-t border-hairline pt-4 sm:grid-cols-4">
              <Stat
                label="Portfolio value"
                node={portfolio ? <Usd wei={portfolio.totalValueWei} /> : "—"}
                accent
              />
              <Stat label="Positions" value={String(portfolio?.holdings.length ?? "—")} />
              <Stat label="Tokens launched" value={String(portfolio?.created.length ?? "—")} />
              <Stat
                label="Volume traded"
                node={portfolio ? <Usd wei={portfolio.volumeWei} /> : "—"}
              />
            </dl>
          </div>
        </section>
      )}

      <div className="segmented w-fit">
        {(
          [
            ["portfolio", `Portfolio${portfolio ? ` (${portfolio.holdings.length})` : ""}`],
            ["created", `Launched${portfolio ? ` (${portfolio.created.length})` : ""}`],
          ] as Array<[Tab, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            data-active={tab === value}
            className="segmented-item"
          >
            {label}
          </button>
        ))}
      </div>

      {portfolioQuery.isLoading && <div className="card shimmer h-64" />}

      {portfolio && tab === "portfolio" && (
        <PortfolioTable portfolio={portfolio} meta={metaQuery.data} />
      )}

      {portfolio && tab === "created" && (
        <CreatedList tokens={portfolio.created} meta={metaQuery.data} />
      )}
    </div>
  );
}

function CreatedList({
  tokens,
  meta,
}: {
  tokens: string[];
  meta?: Record<string, ReturnType<typeof Object> | any>;
}) {
  if (tokens.length === 0) {
    return (
      <div className="card px-4 py-14 text-center">
        <p className="text-sm font-semibold">No launches yet</p>
        <p className="mx-auto mt-1.5 max-w-xs text-xs text-muted">
          Anyone can launch a token with a name and a ticker.
        </p>
        <Link to="/create" className="btn-primary mt-5">
          Create a token
        </Link>
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {tokens.map((token, index) => (
        <Link
          key={token}
          to={`/token/${token}`}
          className="card card-hover animate-fade-up flex items-center gap-3 p-3"
          style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
        >
          <TokenImage
            address={token}
            symbol={token.slice(2, 5)}
            imageUrl={meta?.[token.toLowerCase()]?.imageUrl}
            size={38}
          />
          <span className="min-w-0">
            <span className="block truncate font-semibold">{shortAddress(token, 6)}</span>
            <span className="text-[11px] text-dim">View token →</span>
          </span>
        </Link>
      ))}
    </div>
  );
}

function Stat({
  label,
  value,
  node,
  accent,
}: {
  label: string;
  value?: string;
  node?: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd
        className={`tnum mt-1 text-lg font-black tracking-tight ${
          accent ? "text-brand-light" : "text-white"
        }`}
      >
        {node ?? value}
      </dd>
    </div>
  );
}
