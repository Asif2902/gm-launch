import { useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { decodeEventLog, parseEther } from "viem";
import {
  useAccount,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { BaseLogo } from "@/components/BaseLogo";
import { Usd, UsdPrice } from "@/components/Money";
import { TokenImage } from "@/components/TokenImage";
import {
  TokenDetailsFields,
  emptyTokenDetails,
  type TokenDetailsDraft,
} from "@/components/TokenDetailsFields";
import { FACTORY_ABI } from "@/lib/abi";
import { CHAIN_ID, FACTORY_ADDRESS, PROTOCOL, explorerTx } from "@/lib/config";
import { previewBuy } from "@/lib/curve";
import { formatEth, formatTokenAmount, parseAmount } from "@/lib/format";
import { saveTokenMeta } from "@/lib/metaApi";
import { ExternalLinkIcon } from "@/components/Icons";
import { useAuthedWrite } from "@/components/SessionProvider";

const MAX_NAME_LENGTH = 64;
const MAX_SYMBOL_LENGTH = 16;

/**
 * The curve's opening price: 0.5 ETH virtual reserve over 1B tokens = 5e8 wei per whole token.
 * Computed rather than hard-coded so it stays tied to the constants it derives from.
 */
const GENESIS_PRICE_WEI =
  (PROTOCOL.virtualEthReserve * PROTOCOL.priceUnit) / PROTOCOL.totalSupply;

/**
 * Fully diluted value the moment the curve closes: the final price across the full 1B supply.
 * 60.5 ETH — see docs/ECONOMICS.md §4.
 */
const FDV_AT_MIGRATION =
  (((PROTOCOL.virtualEthReserve + PROTOCOL.migrationThreshold) * PROTOCOL.priceUnit) /
    PROTOCOL.tokenReserveAtMigration) *
  (PROTOCOL.totalSupply / PROTOCOL.priceUnit);

export function CreateTokenPage() {
  const navigate = useNavigate();
  const { address, isConnected, chainId } = useAccount();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [initialBuy, setInitialBuy] = useState("");
  const [details, setDetails] = useState<TokenDetailsDraft>(emptyTokenDetails);
  const [savingDetails, setSavingDetails] = useState(false);

  const authedWrite = useAuthedWrite();
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });

  // A receipt can be delivered more than once by wagmi; the launch flow must run exactly once.
  const handledReceipt = useRef(false);

  /**
   * The token address only exists once `TokenCreated` is mined, so the off-chain details are
   * saved after the transaction confirms, then we navigate.
   *
   * A failure to save details never blocks the redirect: the token is already live on-chain and
   * tradable, and the creator can add a description at any time from the token page. Treating a
   * metadata hiccup as a launch failure would be actively misleading.
   */
  useEffect(() => {
    if (!receipt.data || handledReceipt.current) return;

    const created = receipt.data.logs
      .filter((log) => log.address.toLowerCase() === FACTORY_ADDRESS.toLowerCase())
      .map((log) => {
        try {
          return decodeEventLog({ abi: FACTORY_ABI, data: log.data, topics: log.topics });
        } catch {
          return null;
        }
      })
      .find((decoded) => decoded?.eventName === "TokenCreated");

    if (!created) return;
    handledReceipt.current = true;

    const token = (created.args as { token: string }).token;

    void (async () => {
      const hasDetails = Boolean(
        details.description.trim() ||
          details.website.trim() ||
          details.twitter.trim() ||
          details.telegram.trim() ||
          details.discord.trim() ||
          details.imageKey,
      );

      if (hasDetails && address) {
        setSavingDetails(true);
        try {
          await authedWrite((authorization) =>
            saveTokenMeta(token, authorization, {
            description: details.description,
            website: details.website,
            twitter: details.twitter,
            telegram: details.telegram,
              discord: details.discord,
              ...(details.imageKey ? { imageKey: details.imageKey } : {}),
            }),
          );
        } catch {
          // Non-fatal — the launch succeeded regardless.
        } finally {
          setSavingDetails(false);
        }
      }

      navigate(`/token/${token}`);
    })();
  }, [receipt.data, navigate, address, details, authedWrite]);

  const trimmedName = name.trim();
  const trimmedSymbol = symbol.trim();
  const wrongNetwork = isConnected && chainId !== CHAIN_ID;
  const valid =
    trimmedName.length > 0 &&
    trimmedName.length <= MAX_NAME_LENGTH &&
    trimmedSymbol.length > 0 &&
    trimmedSymbol.length <= MAX_SYMBOL_LENGTH;

  const busy = isPending || receipt.isLoading || savingDetails;

  // What the optional launch buy would get at genesis reserves.
  const snipe = previewBuy(parseAmount(initialBuy), 0n, PROTOCOL.totalSupply);

  const submit = () => {
    if (!valid) return;
    reset();
    writeContract({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI,
      functionName: "createToken",
      args: [trimmedName, trimmedSymbol],
      value: initialBuy ? parseEther(initialBuy) : 0n,
    });
  };

  return (
    <div className="mx-auto max-w-5xl py-4">
      <div className="mb-8 text-center">
        <span className="chip border-brand/35 bg-brand/10 text-brand-light">
          <BaseLogo className="h-2.5 w-2.5" />
          Deploys on Base Sepolia
        </span>
        <h1 className="mt-4 text-4xl font-black tracking-tight sm:text-5xl">
          <span className="gradient-text">Launch your coin</span>
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm text-muted">
          Two fields. No configuration, no owner keys, no way to rug the supply.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* ---- form ---------------------------------------------------------------------- */}
        <form
          className="glass animate-fade-up space-y-5 p-6"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field
            label="Token name"
            hint={`${trimmedName.length}/${MAX_NAME_LENGTH}`}
            overLimit={trimmedName.length > MAX_NAME_LENGTH}
          >
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Based Doge"
              className="input py-3.5 text-lg font-semibold"
              autoFocus
            />
          </Field>

          <Field
            label="Ticker"
            hint={`${trimmedSymbol.length}/${MAX_SYMBOL_LENGTH}`}
            overLimit={trimmedSymbol.length > MAX_SYMBOL_LENGTH}
          >
            <input
              value={symbol}
              onChange={(event) => setSymbol(event.target.value.toUpperCase())}
              placeholder="BDOGE"
              className="input py-3.5 font-mono text-lg font-bold uppercase tracking-wide"
            />
          </Field>

          <div className="border-t border-hairline pt-5">
            <TokenDetailsFields draft={details} onChange={setDetails} disabled={busy} />
          </div>

          <details className="group rounded-xl border border-line bg-canvas/50 p-3">
            <summary className="cursor-pointer list-none text-xs font-semibold text-muted transition-colors hover:text-white">
              <span className="inline-block transition-transform group-open:rotate-90" aria-hidden>
                ▸
              </span>{" "}
              Buy in the same transaction (optional)
            </summary>

            <div className="mt-3 space-y-2">
              <div className="relative">
                <input
                  value={initialBuy}
                  onChange={(event) => setInitialBuy(event.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder="0.0"
                  inputMode="decimal"
                  className="input pr-14"
                />
                <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs font-bold text-muted">
                  ETH
                </span>
              </div>

              {snipe.tokensOut > 0n && (
                <div className="tnum flex items-center justify-between rounded-lg bg-elevated/60 px-3 py-2 text-[11px]">
                  <span className="text-dim">You&apos;d receive</span>
                  <span className="font-bold">
                    {formatTokenAmount(snipe.tokensOut)} {trimmedSymbol || "tokens"}
                  </span>
                </div>
              )}

              <p className="text-[11px] leading-relaxed text-dim">
                Buys on the curve in the launch transaction, before anyone else can. Leave blank
                to skip.
              </p>
            </div>
          </details>

          {!isConnected ? (
            <div className="rounded-xl border border-line bg-elevated/60 px-4 py-3.5 text-center text-sm text-muted">
              Connect a wallet to launch
            </div>
          ) : wrongNetwork ? (
            <div className="rounded-xl border border-warn/30 bg-warn/10 px-4 py-3.5 text-center text-sm font-semibold text-warn">
              Switch to Base Sepolia to launch
            </div>
          ) : (
            <button
              type="submit"
              disabled={!valid || busy}
              className="btn-primary w-full py-4 text-base"
            >
              {isPending
                ? "Confirm in wallet…"
                : receipt.isLoading
                  ? "Deploying…"
                  : savingDetails
                    ? "Saving details…"
                    : "Launch token"}
            </button>
          )}

          {error && (
            <p className="break-words rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-[11px] text-down-light">
              {error.message.split("\n")[0].slice(0, 180)}
            </p>
          )}

          {hash && (
            <a
              href={explorerTx(hash)}
              target="_blank"
              rel="noreferrer"
              className="block text-center text-[11px] text-brand-light hover:underline"
            >
              View transaction <ExternalLinkIcon />
            </a>
          )}
        </form>

        {/* ---- live preview + terms -------------------------------------------------------- */}
        <div className="space-y-4">
          <div className="card animate-fade-up p-4 animation-delay-100">
            <div className="label mb-3">Preview</div>
            <div className="flex items-center gap-3">
              <TokenImage
                address={FACTORY_ADDRESS}
                symbol={trimmedSymbol || "NEW"}
                imageUrl={details.imageUrl}
                size={48}
                glow
              />
              <div className="min-w-0">
                <div className="truncate font-bold">{trimmedName || "Your token"}</div>
                <div className="font-mono text-xs text-muted">
                  {trimmedSymbol || "TICKER"}
                </div>
              </div>
            </div>

            {/* Every launch opens on the same curve, so these are constants, not estimates —
                derived in docs/ECONOMICS.md. Shown in USD like the rest of the app, with the
                ETH figure kept alongside because that is the unit the contract uses. */}
            <dl className="mt-4 space-y-2 border-t border-hairline pt-3 text-xs">
              <Row
                label="Starting price"
                node={<UsdPrice price={GENESIS_PRICE_WEI} showGwei />}
              />
              <Row
                label="Starting market cap"
                node={<Usd wei={PROTOCOL.virtualEthReserve} showEth />}
              />
              <Row
                label="At graduation"
                node={<Usd wei={FDV_AT_MIGRATION} showEth />}
                highlight
              />
            </dl>
          </div>

          <div className="card animate-fade-up space-y-2.5 p-4 text-xs animation-delay-200">
            <div className="label">Fixed for every launch</div>
            <Row label="Supply" value="1,000,000,000" />
            <Row label="Minting after launch" value="Impossible" />
            <Row
              label="Virtual liquidity"
              value={`${formatEth(PROTOCOL.virtualEthReserve)} ETH`}
            />
            <Row label="Buy fee" value="0.20%" />
            <Row label="Sell fee" value="0.30%" />
            <Row
              label="Graduates at"
              value={`${formatEth(PROTOCOL.migrationThreshold)} ETH`}
            />
            <Row label="LP after migration" value="Burned" highlight />

            <p className="border-t border-hairline pt-3 text-[11px] leading-relaxed text-dim">
              You get no special powers over the token — no mint, no owner, no blacklist, no
              transfer tax. Every launch is the same clone of the same audited-shape contract.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  overLimit,
  children,
}: {
  label: string;
  hint: string;
  overLimit: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <label className="label">{label}</label>
        <span className={`tnum text-[11px] ${overLimit ? "text-down-light" : "text-dim"}`}>
          {hint}
        </span>
      </div>
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  node,
  highlight,
}: {
  label: string;
  value?: string;
  node?: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-dim">{label}</dt>
      <dd className={`tnum text-right font-semibold ${highlight ? "text-brand-light" : ""}`}>
        {node ?? value}
      </dd>
    </div>
  );
}
