import { useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";

import { FACTORY_ABI } from "@/lib/abi";
import { FACTORY_ADDRESS, TokenStatus, explorerAddress, explorerTx } from "@/lib/config";
import { formatEth, formatPriceGwei, formatTokenAmount } from "@/lib/format";
import { ProgressBar } from "./ProgressBar";
import type { IndexedMigration } from "@/lib/types";
import { ExternalLinkIcon, RocketIcon } from "./Icons";

interface Props {
  token: `0x${string}`;
  symbol: string;
  status: number;
  ethReserve: string;
  progressBps: number;
  migration: IndexedMigration | null;
  onMigrated?: () => void;
}

export function MigrationStatus({
  token,
  symbol,
  status,
  ethReserve,
  progressBps,
  migration,
  onMigrated,
}: Props) {
  const preview = useReadContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: "previewMigration",
    args: [token],
    query: { enabled: status !== TokenStatus.Migrated },
  });

  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });

  if (receipt.isSuccess) onMigrated?.();

  // --- already on Uniswap ----------------------------------------------------------------------
  if (status === TokenStatus.Migrated) {
    return (
      <div className="card relative overflow-hidden p-4">
        <div className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand/20 blur-3xl" />

        <div className="relative flex items-center justify-between gap-2">
          <h2 className="font-bold">Graduated</h2>
          <span className="chip border-brand/40 bg-brand/15 text-brand-light">LP burned</span>
        </div>

        <p className="relative mt-1 text-xs text-muted">
          Liquidity moved to Uniswap V2 and the LP tokens were destroyed.
        </p>

        {migration?.pair && (
          <a
            href={explorerAddress(migration.pair)}
            target="_blank"
            rel="noreferrer"
            className="relative mt-3 block truncate rounded-lg border border-line bg-canvas/60 px-3 py-2 font-mono text-[11px] text-brand-light transition-colors hover:border-brand/50"
          >
            {migration.pair} <ExternalLinkIcon />
          </a>
        )}

        <dl className="relative mt-3 space-y-2 text-xs">
          <Row label="ETH into pool" value={`${formatEth(migration?.eth_deposited ?? "0")} ETH`} />
          <Row
            label="Tokens into pool"
            value={`${formatTokenAmount(migration?.tokens_deposited ?? "0")} ${symbol}`}
          />
          <Row
            label="Tokens burned"
            value={`${formatTokenAmount(migration?.tokens_burned ?? "0")} ${symbol}`}
          />
          <Row
            label="LP tokens burned"
            value={formatTokenAmount(migration?.lp_tokens_burned ?? "0")}
            highlight
          />
          <Row
            label="Opening price"
            value={`${formatPriceGwei(migration?.opening_price ?? "0")} gwei`}
          />
        </dl>

        <p className="relative mt-3 border-t border-hairline pt-3 text-[11px] leading-relaxed text-dim">
          Every LP token minted went to{" "}
          <code className="rounded bg-elevated px-1 text-white">0x…dEaD</code> in the same
          transaction. The liquidity is locked permanently and anyone can verify it on-chain —
          not even the protocol can pull it.
        </p>
      </div>
    );
  }

  // --- threshold reached, awaiting the migrate() call ---------------------------------------------
  if (status === TokenStatus.PendingMigration) {
    return (
      <div className="card relative overflow-hidden border-gold/35 p-4">
        <div className="pointer-events-none absolute inset-0 animate-glow-breathe bg-gradient-to-br from-gold/10 via-transparent to-transparent" />

        <div className="relative flex items-center gap-2">
          <RocketIcon className="h-4 w-4 shrink-0 text-gold" />
          <h2 className="font-bold text-gold">Ready to graduate</h2>
        </div>

        <p className="relative mt-1.5 text-xs text-muted">
          The curve hit 5 ETH and trading is closed. Anyone can finalise the migration — it
          doesn&apos;t depend on the team.
        </p>

        {preview.data && (
          <dl className="relative mt-3 space-y-2 text-xs">
            <Row label="ETH to pool" value={`${formatEth(preview.data[0])} ETH`} />
            <Row
              label="Tokens to pool"
              value={`${formatTokenAmount(preview.data[1])} ${symbol}`}
            />
            <Row label="Tokens burned" value={`${formatTokenAmount(preview.data[2])} ${symbol}`} />
            <Row label="Opening price" value={`${formatPriceGwei(preview.data[3])} gwei`} />
          </dl>
        )}

        <button
          type="button"
          onClick={() =>
            writeContract({
              address: FACTORY_ADDRESS,
              abi: FACTORY_ABI,
              functionName: "migrate",
              args: [token],
            })
          }
          disabled={isPending || receipt.isLoading}
          className="btn-primary relative mt-4 w-full"
        >
          {isPending
            ? "Confirm in wallet…"
            : receipt.isLoading
              ? "Migrating…"
              : "Send it to Uniswap"}
        </button>

        {error && (
          <p className="relative mt-2 break-words text-[11px] text-down-light">
            {error.message.split("\n")[0].slice(0, 160)}
          </p>
        )}
        {hash && (
          <a
            href={explorerTx(hash)}
            target="_blank"
            rel="noreferrer"
            className="relative mt-2 block text-center text-[11px] text-brand-light hover:underline"
          >
            View transaction <ExternalLinkIcon />
          </a>
        )}
      </div>
    );
  }

  // --- still on the curve --------------------------------------------------------------------------
  return (
    <div className="card p-4">
      <h2 className="font-bold">Road to Uniswap</h2>
      <div className="mt-3">
        <ProgressBar bps={progressBps} ethReserve={ethReserve} size="lg" />
      </div>

      {preview.data && preview.data[1] > 0n && (
        <dl className="mt-4 space-y-2 border-t border-hairline pt-3 text-xs">
          <Row label="Tokens for pool (now)" value={formatTokenAmount(preview.data[1])} />
          <Row label="Would burn" value={formatTokenAmount(preview.data[2])} />
        </dl>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-dim">
        At 5 ETH the curve closes and everything is paired into a Uniswap V2 pool at exactly the
        final curve price — no gap down for the last buyers. The LP tokens are burned on the spot.
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-dim">{label}</dt>
      <dd
        className={`tnum text-right font-semibold ${highlight ? "text-brand-light" : "text-white"}`}
      >
        {value}
      </dd>
    </div>
  );
}
