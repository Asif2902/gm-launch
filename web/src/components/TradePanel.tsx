import { useEffect, useMemo, useState } from "react";
import { formatUnits, maxUint256 } from "viem";
import {
  useAccount,
  useBalance,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { ERC20_ABI, FACTORY_ABI } from "@/lib/abi";
import { CHAIN_ID, FACTORY_ADDRESS, TokenStatus, explorerTx } from "@/lib/config";
import { previewBuy, previewSell } from "@/lib/curve";
import {
  formatEth,
  formatPriceGwei,
  formatTokenAmount,
  formatTokenExact,
  parseAmount,
} from "@/lib/format";
import { ExternalLinkIcon, RocketIcon } from "./Icons";

type Side = "buy" | "sell";

const SLIPPAGE_OPTIONS = [50n, 100n, 300n, 1000n]; // basis points
const DEADLINE_SECONDS = 20 * 60;
const ETH_PRESETS = ["0.01", "0.05", "0.1", "0.5"];

interface Props {
  token: `0x${string}`;
  symbol: string;
  status: number;
  /** Live curve reserves, used for the local preview while the on-chain quote is in flight. */
  ethReserve: bigint;
  tokenReserve: bigint;
  onTraded?: () => void;
}

export function TradePanel({
  token,
  symbol,
  status,
  ethReserve,
  tokenReserve,
  onTraded,
}: Props) {
  const { address, isConnected, chainId } = useAccount();
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100n);

  const tradingOpen = status === TokenStatus.Trading;
  const wrongNetwork = isConnected && chainId !== CHAIN_ID;

  const ethBalance = useBalance({ address, query: { enabled: Boolean(address) } });

  const tokenBalance = useReadContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address), refetchInterval: 8_000 },
  });

  const allowance = useReadContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, FACTORY_ADDRESS] : undefined,
    query: { enabled: Boolean(address) && side === "sell", refetchInterval: 8_000 },
  });

  const parsed = useMemo(() => parseAmount(amount), [amount]);

  // Quotes come from the contract — the chain is the only authority on what a trade returns.
  const buyQuote = useReadContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: "quoteBuy",
    args: [token, parsed],
    query: { enabled: tradingOpen && side === "buy" && parsed > 0n, refetchInterval: 8_000 },
  });

  const sellQuote = useReadContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: "quoteSell",
    args: [token, parsed],
    query: { enabled: tradingOpen && side === "sell" && parsed > 0n, refetchInterval: 8_000 },
  });

  // Local preview is display-only: it fills the gap before the RPC answers, and lets the panel
  // stay meaningful in demo mode where no factory is deployed. It never feeds a transaction.
  const localBuy = useMemo(
    () => previewBuy(parsed, ethReserve, tokenReserve),
    [parsed, ethReserve, tokenReserve],
  );
  const localSell = useMemo(
    () => previewSell(parsed, ethReserve, tokenReserve),
    [parsed, ethReserve, tokenReserve],
  );

  const buy = buyQuote.data
    ? {
        fee: buyQuote.data[0],
        ethAfterFee: buyQuote.data[1],
        tokensOut: buyQuote.data[2],
        refund: buyQuote.data[3],
        triggersMigration: buyQuote.data[5],
      }
    : localBuy;

  const sell = sellQuote.data
    ? {
        grossEthOut: sellQuote.data[0],
        fee: sellQuote.data[1],
        ethOut: sellQuote.data[2],
      }
    : localSell;

  const quoteIsLive = side === "buy" ? Boolean(buyQuote.data) : Boolean(sellQuote.data);

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (!receipt.isSuccess) return;
    setAmount("");
    void tokenBalance.refetch();
    void allowance.refetch();
    void ethBalance.refetch();
    onTraded?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess]);

  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
  const applySlippage = (value: bigint) => (value * (10_000n - slippageBps)) / 10_000n;

  const heldTokens = (tokenBalance.data as bigint | undefined) ?? 0n;
  const currentAllowance = (allowance.data as bigint | undefined) ?? 0n;
  const needsApproval = side === "sell" && parsed > 0n && currentAllowance < parsed;

  const submit = () => {
    if (parsed === 0n) return;
    reset();

    if (side === "buy") {
      if (!buyQuote.data) return; // never sign against a local estimate
      writeContract({
        address: FACTORY_ADDRESS,
        abi: FACTORY_ABI,
        functionName: "buy",
        args: [token, applySlippage(buyQuote.data[2]), deadline()],
        value: parsed,
      });
      return;
    }

    if (needsApproval) {
      writeContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [FACTORY_ADDRESS, maxUint256],
      });
      return;
    }

    if (!sellQuote.data) return;
    writeContract({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI,
      functionName: "sell",
      args: [token, parsed, applySlippage(sellQuote.data[2]), deadline()],
    });
  };

  const busy = isPending || receipt.isLoading;
  const insufficient =
    side === "buy" ? parsed > (ethBalance.data?.value ?? 0n) : parsed > heldTokens;

  return (
    <div className="card overflow-hidden">
      {/* --- side switch --- */}
      <div className="relative grid grid-cols-2 p-1.5">
        <span
          className="absolute inset-y-1.5 w-[calc(50%-6px)] rounded-xl transition-transform duration-300 ease-out"
          style={{
            transform: side === "buy" ? "translateX(6px)" : "translateX(calc(100% + 6px))",
            background:
              side === "buy"
                ? "linear-gradient(135deg, rgb(12 166 120 / 0.22), rgb(32 217 160 / 0.10))"
                : "linear-gradient(135deg, rgb(232 89 12 / 0.22), rgb(255 131 65 / 0.10))",
            boxShadow:
              side === "buy"
                ? "inset 0 0 0 1px rgb(32 217 160 / 0.35)"
                : "inset 0 0 0 1px rgb(255 131 65 / 0.35)",
          }}
          aria-hidden
        />
        {(["buy", "sell"] as Side[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setSide(option);
              setAmount("");
            }}
            className={`relative z-10 rounded-xl py-2.5 text-sm font-bold capitalize transition-colors ${
              side === option
                ? option === "buy"
                  ? "text-up-light"
                  : "text-down-light"
                : "text-muted hover:text-white"
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <div className="space-y-4 px-4 pb-4">
        {!tradingOpen ? (
          <div className="rounded-xl border border-line bg-elevated/60 px-4 py-8 text-center">
            <p className="text-sm font-semibold">
              {status === TokenStatus.PendingMigration
                ? "Curve filled"
                : "Graduated to Uniswap"}
            </p>
            <p className="mt-1.5 text-xs text-muted">
              {status === TokenStatus.PendingMigration
                ? "The curve hit 5 ETH. Trading is closed until liquidity migrates."
                : "This token now trades on the Uniswap V2 pair."}
            </p>
          </div>
        ) : (
          <>
            {/* --- amount --- */}
            <div>
              <div className="mb-2 flex items-baseline justify-between">
                <span className="label">{side === "buy" ? "You pay" : "You sell"}</span>
                <button
                  type="button"
                  onClick={() =>
                    setAmount(
                      side === "buy"
                        ? formatUnits(ethBalance.data?.value ?? 0n, 18)
                        : formatUnits(heldTokens, 18),
                    )
                  }
                  className="tnum text-[11px] text-dim transition-colors hover:text-brand-light"
                >
                  Balance:{" "}
                  {side === "buy"
                    ? `${formatEth(ethBalance.data?.value ?? 0n)} ETH`
                    : `${formatTokenExact(heldTokens)}`}
                </button>
              </div>

              <div className="relative">
                <input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder="0.0"
                  inputMode="decimal"
                  className="input py-4 pr-20 text-xl font-bold"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm font-bold text-muted">
                  {side === "buy" ? "ETH" : symbol}
                </span>
              </div>

              <div className="mt-2 grid grid-cols-4 gap-1.5">
                {side === "buy"
                  ? ETH_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setAmount(preset)}
                        className="rounded-lg border border-line bg-elevated/70 py-1.5 text-[11px] font-semibold text-muted transition-all hover:border-brand/50 hover:text-white"
                      >
                        {preset}
                      </button>
                    ))
                  : [25, 50, 75, 100].map((percent) => (
                      <button
                        key={percent}
                        type="button"
                        onClick={() =>
                          setAmount(formatUnits((heldTokens * BigInt(percent)) / 100n, 18))
                        }
                        className="rounded-lg border border-line bg-elevated/70 py-1.5 text-[11px] font-semibold text-muted transition-all hover:border-brand/50 hover:text-white"
                      >
                        {percent}%
                      </button>
                    ))}
              </div>
            </div>

            {/* --- quote breakdown: the fee is stated outright, never folded into the rate --- */}
            {parsed > 0n && (
              <div className="animate-fade-up space-y-2 rounded-xl border border-line bg-canvas/70 p-3.5 text-xs">
                {side === "buy" ? (
                  <>
                    <QuoteRow
                      label="You receive"
                      value={`${formatTokenAmount(buy.tokensOut)} ${symbol}`}
                      emphasis
                    />
                    <QuoteRow label="Platform fee · 0.20%" value={`${formatEth(buy.fee)} ETH`} />
                    <QuoteRow label="Into the curve" value={`${formatEth(buy.ethAfterFee)} ETH`} />
                    {buy.refund > 0n && (
                      <QuoteRow
                        label="Refunded · curve is full"
                        value={`${formatEth(buy.refund)} ETH`}
                      />
                    )}
                    {buy.triggersMigration && (
                      <p className="flex items-start gap-2 rounded-lg border border-gold/30 bg-gold/10 px-2.5 py-2 text-gold">
                        <RocketIcon className="mt-px h-3.5 w-3.5 shrink-0" />
                        This buy fills the curve and sends it to Uniswap V2.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <QuoteRow
                      label="You receive"
                      value={`${formatEth(sell.ethOut)} ETH`}
                      emphasis
                    />
                    <QuoteRow label="Curve pays" value={`${formatEth(sell.grossEthOut)} ETH`} />
                    <QuoteRow label="Platform fee · 0.30%" value={`−${formatEth(sell.fee)} ETH`} />
                  </>
                )}

                <div className="flex items-center justify-between border-t border-hairline pt-2.5">
                  <span className="text-dim">Max slippage</span>
                  <div className="flex gap-1">
                    {SLIPPAGE_OPTIONS.map((option) => (
                      <button
                        key={String(option)}
                        type="button"
                        onClick={() => setSlippageBps(option)}
                        className={`rounded-md px-2 py-0.5 font-semibold transition-colors ${
                          slippageBps === option
                            ? "bg-raised text-white"
                            : "text-dim hover:text-white"
                        }`}
                      >
                        {Number(option) / 100}%
                      </button>
                    ))}
                  </div>
                </div>

                {!quoteIsLive && (
                  <p className="text-[10px] leading-relaxed text-dim">
                    Estimated locally. The exact amount is quoted on-chain before you sign.
                  </p>
                )}
              </div>
            )}

            {/* --- action --- */}
            {!isConnected ? (
              <div className="rounded-xl border border-line bg-elevated/60 px-4 py-3 text-center text-xs text-muted">
                Connect a wallet to trade
              </div>
            ) : wrongNetwork ? (
              <div className="rounded-xl border border-warn/30 bg-warn/10 px-4 py-3 text-center text-xs font-semibold text-warn">
                Switch to Base Sepolia
              </div>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={parsed === 0n || busy || insufficient || !quoteIsLive}
                className={`w-full py-3.5 text-base ${side === "buy" ? "btn-buy" : "btn-sell"}`}
              >
                {busy
                  ? isPending
                    ? "Confirm in wallet…"
                    : "Processing…"
                  : insufficient
                    ? "Insufficient balance"
                    : parsed > 0n && !quoteIsLive
                      ? "Fetching quote…"
                      : needsApproval
                        ? `Approve ${symbol}`
                        : side === "buy"
                          ? `Buy ${symbol}`
                          : `Sell ${symbol}`}
              </button>
            )}

            {error && (
              <p className="break-words rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-[11px] text-down-light">
                {error.message.split("\n")[0].slice(0, 180)}
              </p>
            )}

            {hash && receipt.isSuccess && (
              <a
                href={explorerTx(hash)}
                target="_blank"
                rel="noreferrer"
                className="block animate-fade-up rounded-lg border border-up/30 bg-up/10 px-3 py-2 text-center text-[11px] font-semibold text-up-light"
              >
                Confirmed — view on Basescan <ExternalLinkIcon />
              </a>
            )}

            <p className="tnum text-center text-[10px] text-dim">
              Price impact moves with the curve · next price{" "}
              {formatPriceGwei(side === "buy" ? localBuy.priceAfter : localSell.priceAfter)} gwei
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function QuoteRow({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-dim">{label}</span>
      <span
        className={`tnum ${emphasis ? "text-base font-bold text-white" : "font-medium text-white/85"}`}
      >
        {value}
      </span>
    </div>
  );
}
