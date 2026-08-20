import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { shortAddress } from "@/lib/format";
import { fetchProfileBatch, type UserProfile } from "@/lib/metaApi";
import { AddressAvatar } from "./AddressAvatar";

/**
 * Showing a wallet as a person rather than as a hex string.
 *
 * Anywhere an address appears in a list — the trade ticker, the leaderboard, the creator line on
 * a card — it should carry whatever identity its owner has actually set. A launchpad is a social
 * product; `0x7d9c…4a7f` scrolling past tells you nothing, and it is the same nothing for every
 * row.
 *
 * Lookups are batched and cached by the address set, so a ticker of twenty trades costs one
 * request rather than twenty, and the header's own profile is shared with every other consumer
 * through the same query cache.
 */

type ProfileMap = Record<string, UserProfile>;

/**
 * Profiles for a set of addresses.
 *
 * The query key is the sorted, de-duplicated address list, so scrolling a list that keeps showing
 * the same wallets does not refetch. Identity changes rarely; five minutes of staleness is
 * generous and keeps this off the critical path.
 */
export function useProfiles(addresses: Array<string | null | undefined>): ProfileMap {
  const keys = useMemo(() => {
    const unique = new Set<string>();
    for (const address of addresses) {
      if (address && /^0x[0-9a-fA-F]{40}$/.test(address)) unique.add(address.toLowerCase());
    }
    return [...unique].sort();
  }, [addresses]);

  const { data } = useQuery({
    queryKey: ["profiles", keys.join(",")],
    queryFn: () => fetchProfileBatch(keys),
    enabled: keys.length > 0,
    staleTime: 5 * 60_000,
  });

  return data ?? {};
}

/** The single-address case, for the header and anywhere else holding just one wallet. */
export function useProfileFor(address: string | null | undefined): UserProfile | null {
  const single = useMemo(() => [address], [address]);
  const profiles = useProfiles(single);
  return address ? (profiles[address.toLowerCase()] ?? null) : null;
}

/** The name to show for a wallet: display name, then handle, then the address itself. */
export function accountName(
  address: string,
  profile: UserProfile | null | undefined,
  size = 4,
): string {
  return profile?.displayName || profile?.username || shortAddress(address, size);
}

/**
 * Avatar plus name for one wallet.
 *
 * Falls back cleanly at every step: the generated mark when there is no uploaded avatar, the
 * shortened address when there is no name. Nothing here is ever blank, and nothing is invented —
 * a generated *mark* is decoration, a generated *name* would be a claim.
 */
export function AccountLabel({
  address,
  profile,
  size = 20,
  nameLength = 4,
  className = "",
  nameClassName = "",
  showName = true,
}: {
  address: string;
  profile?: UserProfile | null;
  size?: number;
  nameLength?: number;
  className?: string;
  nameClassName?: string;
  showName?: boolean;
}) {
  const named = Boolean(profile?.displayName || profile?.username);

  return (
    <span className={`flex min-w-0 items-center gap-1.5 ${className}`}>
      <AddressAvatar address={address} src={profile?.avatarUrl} size={size} />
      {showName && (
        <span
          // A handle is text; an address is a machine identifier and reads better in mono.
          className={`truncate ${named ? "" : "font-mono"} ${nameClassName}`}
          title={address}
        >
          {accountName(address, profile, nameLength)}
        </span>
      )}
    </span>
  );
}
