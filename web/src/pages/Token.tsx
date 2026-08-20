import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useParams } from "react-router-dom";
import { useCallback } from "react";
import { isAddress } from "viem";
import { useReadContract } from "wagmi";

import { ActivityPanel } from "@/components/TradeHistory";
import { MigrationStatus } from "@/components/MigrationStatus";
import { Usd, UsdPrice } from "@/components/Money";
import { PriceChart } from "@/components/PriceChart";
import { ProgressBar } from "@/components/ProgressBar";
import { StatusBadge } from "@/components/StatusBadge";
import { TokenDetailsPanel } from "@/components/TokenDetailsPanel";
import { TokenImage } from "@/components/TokenImage";
import { TradePanel } from "@/components/TradePanel";
import { FACTORY_ABI } from "@/lib/abi";
import { api } from "@/lib/api";
import { FACTORY_ADDRESS, PROTOCOL, explorerAddress } from "@/lib/config";
import { fetchTokenMeta } from "@/lib/metaApi";
import {
  formatChange,
  formatEth,
  formatPriceGwei,
  formatTokenAmount,
  shortAddress,
  timeAgo,
} from "@/lib/format";
import type { OnChainToken } from "@/lib/types";
import { ExternalLinkIcon } from "@/components/Icons";

export function TokenPage() {
  const params = useParams();
  const address = String(params.address ?? "");
  const queryClient = useQueryClient();

  const valid = isAddress(address);

  // Indexed data: history, volume, holders, migration record.
  const indexed = useQuery({
    queryKey: ["token", address],
    queryFn: () => api.token(address),
    enabled: valid,
    refetchInterval: 5_000,
  });

  // Off-chain metadata: picture, blurb, links. Never affects any traded number.
  const meta = useQuery({
    queryKey: ["token-meta", address],
    queryFn: () => fetchTokenMeta(address),
    enabled: valid,
    staleTime: 60_000,
  });

  // Live chain state. Where the two disagree — reserves, price, status — the chain wins.
  const onChain = useReadContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: "getToken",
    args: valid ? [address as `0x${string}`] : undefined,
    query: { enabled: valid, refetchInterval: 6_000, retry: false },
  });

  const refresh = useCallback(() => {
    void onChain.refetch();
    for (const key of ["token", "trades", "candles", "holders"]) {
      void queryClient.invalidateQueries({ queryKey: [key, address] });
    }
  }, [address, onChain, queryClient]);

  if (!valid) {
    return <Message title="Invalid address" body="That doesn't look like a token address." />;
  }

  const chain = onChain.data as OnChainToken | undefined;
  const token = indexed.data?.token;

  if (indexed.isError && !chain) {
    return (
      <Message
        title="Token not found"
        body="No launchpad token at this address, or the chain and indexer are both unreachable."
      />
    );
  }

  if (!chain && !token) return <TokenSkeleton />;

  // Prefer chain values; fall back to the indexer only when the RPC read has not landed.
  const name = chain?.name ?? token?.name ?? "";
  const symbol = chain?.symbol ?? token?.symbol ?? "";
  const creator = chain?.creator ?? token?.creator ?? "";
  const status = Number(chain?.status ?? token?.status ?? 1);
  const price = chain?.tokenPrice ?? BigInt(token?.price ?? "0");
  const marketCap = chain?.marketCap ?? BigInt(token?.market_cap ?? "0");
  const fdv = chain?.fullyDilutedValuation ?? BigInt(token?.fdv ?? "0");
  const ethReserve = chain?.ethReserve ?? BigInt(token?.eth_reserve ?? "0");
  const tokenReserve = chain?.tokenReserve ?? BigInt(token?.token_reserve ?? "0");
  const virtualEthReserve = chain?.virtualEthReserve ?? BigInt(token?.virtual_eth_reserve ?? "0");
  const progressBps = Number(chain?.migrationProgressBps ?? token?.migration_progress_bps ?? 0);
  const createdAt = Number(chain?.createdAt ?? token?.created_at ?? 0);

  // Derive the still-purchasable amount when the chain read is unavailable, so the panel never
  // shows a misleading zero.
  const tokensAvailable =
    chain?.tokensAvailable ??
    (tokenReserve > PROTOCOL.tokenReserveAtMigration
      ? tokenReserve - PROTOCOL.tokenReserveAtMigration
      : 0n);

  const change24h =
    token?.open_24h && Number(token.open_24h) > 0
      ? (Number(price) / Number(token.open_24h) - 1) * 100
      : null;

  return (
    <div className="space-y-4">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-dim transition-colors hover:text-white"
      >
        <span aria-hidden>←</span> Discover
      </Link>

      {/* --- header ---------------------------------------------------------------------- */}
      <section className="glass animate-fade-up relative overflow-hidden p-5">
        {/* The token's own artwork, blurred out to a wash, tints its page. Cheap to render, and
            it makes two tokens' pages feel like different places at a glance. */}
        {meta.data?.imageUrl && (
          <>
            <img
              src={meta.data.imageUrl}
              alt=""
              aria-hidden
              className="pointer-events-none absolute -top-1/2 left-0 h-[200%] w-full scale-125 object-cover opacity-25 blur-3xl"
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent to-surface/80" />
          </>
        )}

        <div className="relative flex flex-wrap items-start gap-4">
          <TokenImage
            address={address}
            symbol={symbol}
            imageUrl={meta.data?.imageUrl}
            size={88}
            glow
          />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-black tracking-tight sm:text-3xl">{name}</h1>
              <span className="rounded-lg bg-elevated px-2 py-0.5 font-mono text-sm font-bold text-muted">
                {symbol}
              </span>
              <StatusBadge status={status} bps={progressBps} />
            </div>

            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-dim">
              <a
                href={explorerAddress(address)}
                target="_blank"
                rel="noreferrer"
                className="font-mono transition-colors hover:text-brand-light"
              >
                {shortAddress(address, 6)} <ExternalLinkIcon />
              </a>
              <span aria-hidden>·</span>
              <span>
                by{" "}
                <Link
                  to={`/u/${creator}`}
                  className="font-mono transition-colors hover:text-brand-light"
                >
                  {shortAddress(creator)}
                </Link>
              </span>
              {createdAt > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span>{timeAgo(createdAt)}</span>
                </>
              )}
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
            <HeaderStat
              label="Price"
              value={<UsdPrice price={price} className="text-xl font-black" showGwei />}
              delta={change24h}
            />
            <HeaderStat
              label="Market cap"
              value={<Usd wei={marketCap} className="text-xl font-black" />}
            />
            <HeaderStat label="FDV" value={<Usd wei={fdv} className="text-xl font-black" />} />
            <HeaderStat
              label="24h volume"
              value={<Usd wei={token?.volume_24h ?? "0"} className="text-xl font-black" />}
            />
          </dl>
        </div>

        <div className="mt-5">
          <ProgressBar bps={progressBps} ethReserve={ethReserve} size="lg" />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <PriceChart address={address} currentPrice={price.toString()} />
          <TokenDetailsPanel
            token={address}
            symbol={symbol}
            creator={creator}
            meta={meta.data}
          />
          <ActivityPanel address={address} symbol={symbol} />
        </div>

        <div className="space-y-4">
          <TradePanel
            token={address as `0x${string}`}
            symbol={symbol}
            status={status}
            ethReserve={ethReserve}
            tokenReserve={tokenReserve}
            onTraded={refresh}
          />

          <MigrationStatus
            token={address as `0x${string}`}
            symbol={symbol}
            status={status}
            ethReserve={ethReserve.toString()}
            progressBps={progressBps}
            migration={indexed.data?.migration ?? null}
            onMigrated={refresh}
          />

          {/* --- curve state ---------------------------------------------------------- */}
          <div className="card p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="font-bold">Curve state</h2>
              <span className="text-[10px] text-dim">
                {chain ? "on-chain" : "indexed"}
              </span>
            </div>

            <dl className="mt-3 space-y-2 text-xs">
              <Row label="ETH reserve (real)" value={`${formatEth(ethReserve)} ETH`} />
              <Row label="Virtual ETH reserve" value={`${formatEth(virtualEthReserve)} ETH`} />
              <Row label="Token reserve" value={`${formatTokenAmount(tokenReserve)} ${symbol}`} />
              <Row
                label="Tokens left on curve"
                value={`${formatTokenAmount(tokensAvailable)} ${symbol}`}
              />
              <Row
                label="Circulating"
                value={`${formatTokenAmount(
                  chain?.circulatingSupply ?? BigInt(token?.total_supply ?? "0") - tokenReserve,
                )} ${symbol}`}
              />
              <Row
                label="Total supply"
                value={`${formatTokenAmount(token?.total_supply ?? "1000000000000000000000000000")} ${symbol}`}
              />
              <div className="border-t border-hairline pt-2" />
              <Row label="Holders" value={String(token?.holder_count ?? "—")} />
              <Row label="Trades" value={String(token?.trade_count ?? "—")} />
              <Row label="Total volume" value={`${formatEth(token?.volume_eth ?? "0")} ETH`} />
              <Row label="Fees paid" value={`${formatEth(token?.fees_eth ?? "0")} ETH`} />
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}

function HeaderStat({
  label,
  value,
  unit,
  delta,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  delta?: number | null;
}) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="tnum mt-1 flex items-baseline gap-1.5 text-xl font-black tracking-tight">
        {value}
        {unit && <span className="text-[10px] font-medium text-dim">{unit}</span>}
        {delta !== null && delta !== undefined && (
          <span
            className={`text-[11px] font-bold ${delta >= 0 ? "text-up-light" : "text-down-light"}`}
          >
            {formatChange(delta)}
          </span>
        )}
      </dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-dim">{label}</dt>
      <dd className="tnum text-right font-semibold">{value}</dd>
    </div>
  );
}

function TokenSkeleton() {
  return (
    <div className="space-y-4">
      <div className="card shimmer h-40" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <div className="card shimmer h-[480px]" />
          <div className="card shimmer h-64" />
        </div>
        <div className="space-y-4">
          <div className="card shimmer h-80" />
          <div className="card shimmer h-56" />
        </div>
      </div>
    </div>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-16 text-center">
      <p className="text-lg font-bold">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">{body}</p>
      <Link to="/" className="btn-primary mt-6">
        Back to discover
      </Link>
    </div>
  );
}
