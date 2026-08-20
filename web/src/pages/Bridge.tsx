import { useSyncWagmiConfig } from "@lifi/wallet-management";
import { LiFiWidget, type WidgetConfig } from "@lifi/widget";
import { useMemo } from "react";
import type { CreateConnectorFn } from "wagmi";
import { useConfig } from "wagmi";
import { base, mainnet } from "wagmi/chains";

import { homeChain } from "@/lib/chains";
import { IS_MAINNET, NETWORK_NAME } from "@/lib/config";
import { useLifiMainnetChains } from "@/lib/lifiChains";

/** LI.FI's identifier for a chain's native asset (ETH, MATIC, BNB…). */
const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";

/**
 * Stable empty array, so syncing does not re-run on every render.
 *
 * The app declares no explicit connectors — wallets arrive through EIP-6963 discovery — and the
 * sync re-derives the discovered ones itself, so there is nothing to contribute here.
 */
const NO_CONNECTORS: CreateConnectorFn[] = [];

/**
 * Bridging in, via the LI.FI widget.
 *
 * Deliberately not built from scratch. A bridge aggregator is route discovery across dozens of
 * chains and bridges, quote comparison, allowance handling, execution, and — the part nobody
 * budgets for — recovery when a transfer stalls mid-flight. LI.FI already does all of it, so the
 * work here is making it look like it belongs rather than reimplementing it.
 *
 * It picks up the app's existing `WagmiProvider` automatically, so a wallet already connected in
 * the header carries straight over — but it keeps its own wallet menu, because bridging starts on
 * a chain the header's connect button does not target.
 *
 * The widget is loaded lazily by the router: it carries its own UI framework and multi-ecosystem
 * wallet adapters, which is a large amount of JavaScript for a page most visitors never open.
 */
export function BridgePage() {
  const wagmiConfig = useConfig();
  const chainsQuery = useLifiMainnetChains();
  const mainnetChains = chainsQuery.data;

  /**
   * Teaches wagmi about every chain the widget is going to offer.
   *
   * With an external wagmi config the widget does not connect wallets itself — it calls wagmi's
   * `switchChain`, which only knows the chains its config was built with. LI.FI's docs are blunt
   * about the consequence: "It's important to keep the Wagmi chains configuration in sync with
   * the Widget chain list so all functionality, like switching chains, works correctly." Skip
   * this and the picker lists sixty-odd chains of which only one can actually be selected, which
   * is precisely what "no chain works as a source" looks like from the outside.
   *
   * The launchpad's own chain is pinned to the front so it stays `chains[0]`, and keeps this
   * app's curated definition — its configured RPC, its multicall address — rather than being
   * replaced by LI.FI's copy.
   */
  const syncedChains = useMemo(
    () =>
      mainnetChains && [homeChain, ...mainnetChains.filter((chain) => chain.id !== homeChain.id)],
    [mainnetChains],
  );

  useSyncWagmiConfig(wagmiConfig, NO_CONNECTORS, syncedChains);

  /** Memoised so the widget config below is not rebuilt — and the widget remounted — every render. */
  const allowedChainIds = useMemo(
    () => mainnetChains?.map((chain) => chain.id) ?? [],
    [mainnetChains],
  );

  /**
   * Themed from the same palette as the rest of the app, rather than left on LI.FI's default
   * purple. The values are the literal hexes from `tailwind.config.ts` — the widget renders in
   * its own MUI theme with no access to our CSS variables, so they have to be restated here.
   * If the palette moves, this moves with it.
   */
  const config = useMemo<WidgetConfig>(
    () => ({
      integrator: "gm-launch",
      variant: "compact",
      appearance: "dark",

      /**
       * The exact set of chains wagmi was just synced with — one list, two consumers.
       *
       * This is what keeps testnets out. LI.FI's `/v1/chains` ships Base Sepolia, OP Sepolia,
       * Arbitrum Sepolia and Arc Testnet alongside the real networks, and the widget renders the
       * response as-is; there is no testnet switch to turn off, so the only documented lever is
       * this allow-list. Stating it positively rather than denying four ids by number means a
       * testnet LI.FI adds tomorrow is excluded on the day it appears.
       */
      chains: { allow: allowedChainIds },

      /**
       * Opens on the route almost everyone wants: ETH on Ethereum into ETH on Base.
       *
       * Both sides are pre-filled because an empty form quotes nothing — routes are only
       * computed once a source token, a destination token *and* an amount all exist, so a widget
       * that opens blank looks broken until you have made three separate choices. Everything
       * stays changeable; this is a starting point, not a restriction.
       *
       * The zero address is LI.FI's identifier for a chain's native asset.
       */
      fromChain: mainnet.id,
      fromToken: NATIVE_TOKEN,
      toChain: base.id,
      toToken: NATIVE_TOKEN,

      theme: {
        colorSchemes: {
          dark: {
            palette: {
              primary: { main: "#0052FF" },
              secondary: { main: "#4C8DFF" },
              background: {
                default: "#0C0E13", // surface
                paper: "#13161D", // elevated
              },
              text: {
                primary: "#FFFFFF",
                secondary: "#7C8698", // muted
              },
              grey: {
                200: "#1E222B", // line
                300: "#1E222B",
                700: "#535C6D", // dim
                800: "#13161D",
              },
              success: { main: "#0CA678" },
              error: { main: "#E8590C" },
              warning: { main: "#F0B90B" },
            },
          },
        },
        shape: {
          borderRadius: 12,
          borderRadiusSecondary: 12,
          borderRadiusTertiary: 16,
        },
        typography: {
          fontFamily:
            '"Space Grotesk Variable", "Inter Variable", system-ui, -apple-system, sans-serif',
        },
        container: {
          border: "1px solid #1E222B",
          borderRadius: "16px",
          boxShadow: "0 18px 40px -18px rgb(0 0 0 / 0.9)",
        },
      },

      /**
       * Only the theme toggle and branding are hidden.
       *
       * The wallet menu deliberately stays. Hiding it hands responsibility for connecting to the
       * host app, and this app's own connect button targets the launchpad's chain — which is the
       * *destination*, not the source you are bridging from. Leaving LI.FI's menu in place means
       * the widget can connect and switch networks on its own terms, which is the whole reason
       * bridging works at all.
       */
      hiddenUI: ["appearance", "poweredBy"],
    }),
    [allowedChainIds],
  );

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold tracking-tight">Bridge</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted">
          Move funds in from any chain, routed by{" "}
          <a
            href="https://li.fi"
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-brand-light hover:underline"
          >
            LI.FI
          </a>{" "}
          across every bridge and DEX it aggregates. Opens on ETH → Base; change either side
          freely.
        </p>
      </header>

      {/*
        LI.FI routes mainnet liquidity only. On a testnet deployment bridged funds would land on
        Base *mainnet* and could not be spent here, which is the difference between a demo and a
        trap — so the page says so rather than quietly taking the transfer.
      */}
      {!IS_MAINNET && (
        <div className="mb-5 flex gap-3 rounded-xl border border-warn/30 bg-warn/[0.07] px-4 py-3">
          <WarningIcon />
          <p className="text-xs leading-relaxed text-warn">
            <span className="font-bold">This launchpad is on {NETWORK_NAME}.</span> Bridges move
            real funds between real networks — there is no testnet routing — so anything you bridge
            here arrives on Base mainnet and cannot be used to trade on this deployment.
          </p>
        </div>
      )}

      {/*
        The widget is held back until the chain list resolves.

        Rendering it first and filtering afterwards would work, but for a moment the picker is
        LI.FI's raw response — testnets included — and a moment is long enough to click. Waiting
        costs a skeleton; not waiting costs the guarantee.
      */}
      <div className="flex justify-center">
        {chainsQuery.isError ? (
          <ChainsUnavailable error={chainsQuery.error} onRetry={() => void chainsQuery.refetch()} />
        ) : allowedChainIds.length ? (
          <LiFiWidget integrator="gm-launch" config={config} />
        ) : (
          <div className="shimmer h-[560px] w-full max-w-[420px] rounded-2xl bg-elevated" />
        )}
      </div>
    </div>
  );
}

/**
 * Shown when LI.FI's chain list could not be read.
 *
 * Nothing is lost by refusing to render the widget here: it needs the same service for tokens,
 * quotes and routes, so a bridge that cannot reach `li.quest` has nothing to offer either way.
 * What is gained is that the failure never resolves into a picker we have not vetted.
 */
function ChainsUnavailable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const detail = error instanceof Error ? error.message : null;

  return (
    <div className="card w-full max-w-[420px] p-10 text-center">
      <div className="mx-auto grid h-11 w-11 place-items-center rounded-full border border-warn/30 bg-warn/10">
        <WarningIcon className="h-5 w-5 text-warn" />
      </div>

      <p className="mt-4 font-display text-lg font-bold">Bridge unavailable</p>

      <p className="mt-2 text-sm leading-relaxed text-muted">
        LI.FI&apos;s network list didn&apos;t load, so there is nothing to route between. Your
        wallet and your funds are untouched.
      </p>

      {detail && <p className="mt-3 break-words font-mono text-[11px] text-dim">{detail}</p>}

      <button type="button" onClick={onRetry} className="btn-ghost btn-sm mt-6">
        Try again
      </button>
    </div>
  );
}

function WarningIcon({ className = "mt-0.5 h-4 w-4 shrink-0 text-warn" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className={className}
      aria-hidden
    >
      <path d="M8 1.75 1.5 13.25h13L8 1.75Z" strokeLinejoin="round" />
      <path d="M8 6.5v3.25" />
      <circle cx="8" cy="11.5" r="0.5" fill="currentColor" />
    </svg>
  );
}
