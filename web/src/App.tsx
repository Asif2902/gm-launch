import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, lazy, useEffect, useState } from "react";
import { Link, Route, Routes, useLocation, useNavigationType } from "react-router-dom";
import { createClient, http } from "viem";
import { WagmiProvider, createConfig } from "wagmi";

import { Header } from "./components/Header";
import { SessionProvider } from "./components/SessionProvider";
import { TradeTicker } from "./components/TradeTicker";
import { homeChain } from "./lib/chains";
import { IS_MAINNET, NETWORK_NAME, RPC_URL } from "./lib/config";
import { CreateTokenPage } from "./pages/CreateToken";
import { DiscoverPage } from "./pages/Discover";
import { LeaderboardPage } from "./pages/Leaderboard";
import { ProfilePage } from "./pages/Profile";
import { TokenPage } from "./pages/Token";

/**
 * The bridge is split out of the main bundle.
 *
 * `@lifi/widget` brings its own UI framework and wallet adapters for several ecosystems — several
 * hundred kilobytes that most visitors, who came to look at tokens, would otherwise download
 * before the feed could paint.
 */
const BridgePage = lazy(() =>
  import("./pages/Bridge").then((module) => ({ default: module.BridgePage })),
);

/**
 * Only the launchpad's own chain, up front.
 *
 * An earlier version of this file listed a handful of mainnets here on the theory that the LI.FI
 * widget read its chain picker from wagmi. It does not — the widget calls LI.FI's `/v1/chains`
 * and renders that, which is why chains that were never in this list showed up in it anyway.
 *
 * What wagmi's list *does* decide is which chains the wallet can be switched to, because in
 * external-wallet mode the widget bridges through wagmi's own `switchChain`. A chain missing from
 * here is therefore offered by the picker and then fails the moment it is chosen. Keeping the two
 * lists in agreement is LI.FI's documented requirement, and the bridge page does it properly: it
 * syncs this config against the same chain list the widget renders. So this stays minimal, and
 * the page that needs more asks for more.
 */
const chains = [homeChain] as const;

/**
 * No `connectors` array on purpose.
 *
 * wagmi discovers wallets via EIP-6963 (`multiInjectedProviderDiscovery`, on by default), which
 * lists every installed wallet separately instead of collapsing them into one ambiguous
 * "injected" entry — and keeps the connectors barrel, which drags in the Coinbase CDP SDK and
 * its optional dependencies, out of the bundle.
 */
const wagmiConfig = createConfig({
  chains,
  /**
   * A factory rather than a static `transports` map, because the chain list is not static.
   *
   * When the bridge syncs in the chains LI.FI supports, a fixed map would have no entry for any
   * of them and every read on those chains would throw. Resolving the transport per chain means a
   * newly added chain arrives already working, on its own public RPC — while the one chain this
   * app actually trades on keeps the endpoint it was configured with.
   */
  client({ chain }) {
    return createClient({
      chain,
      transport: chain.id === homeChain.id ? http(RPC_URL) : http(),
    });
  },
});

export function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Curve state moves with every trade; keep it fresh but avoid hammering the RPC.
            staleTime: 5_000,
            refetchOnWindowFocus: true,
            retry: 1,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <ScrollToTop />
          <Header />
          <TradeTicker />

          <main className="mx-auto w-full max-w-[1600px] px-4 pb-24 pt-4">
            <Routes>
              <Route path="/" element={<DiscoverPage />} />
              <Route path="/create" element={<CreateTokenPage />} />
              <Route path="/leaderboard" element={<LeaderboardPage />} />
              {/*
                The trailing `*` is load-bearing. The widget runs its own nested router for chain
                selection, token selection, routes and settings — without the splat this parent
                route stops matching the moment you open any of them and React unmounts the whole
                widget mid-interaction, which reads exactly like "the bridge is broken".
              */}
              <Route
                path="/bridge/*"
                element={
                  <Suspense fallback={<BridgeSkeleton />}>
                    <BridgePage />
                  </Suspense>
                }
              />
              <Route path="/token/:address" element={<TokenPage />} />
              <Route path="/u/:handle" element={<ProfilePage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </main>

          <Footer />
        </SessionProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

/**
 * Sends a new page to the top, the way a document load would.
 *
 * A client-side router keeps the scroll position across a navigation, so clicking a card halfway
 * down the feed lands you halfway down the token page — past its header, staring at the chart.
 * POP (back/forward) is left alone: the browser restores those positions itself, and that is the
 * behaviour people expect from the back button.
 */
function ScrollToTop() {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    if (navigationType !== "POP") window.scrollTo(0, 0);
  }, [pathname, navigationType]);

  return null;
}

/** Holds the bridge's shape while its chunk downloads, so the page doesn't collapse and jump. */
function BridgeSkeleton() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="shimmer h-8 w-40 rounded-lg bg-elevated" />
      <div className="shimmer mt-3 h-4 w-96 max-w-full rounded bg-elevated" />
      <div className="shimmer mx-auto mt-6 h-[560px] w-full max-w-[420px] rounded-2xl bg-elevated" />
    </div>
  );
}

function NotFound() {
  return (
    <div className="card p-16 text-center">
      <p className="text-lg font-bold">Page not found</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">
        That route doesn&apos;t exist.
      </p>
      <Link to="/" className="btn-primary mt-6">
        Back to the terminal
      </Link>
    </div>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line/60 py-6">
      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-5 gap-y-2 px-4 text-[11px] text-dim">
        <span className="font-display font-semibold text-muted">gm Launch</span>
        <span>1B fixed supply</span>
        <span>0.5 ETH virtual liquidity</span>
        <span>0.20% buy / 0.30% sell</span>
        <span>5 ETH → Uniswap V2, LP burned</span>
        <span className="ml-auto">
          {NETWORK_NAME} · {IS_MAINNET ? "real funds" : "testnet"}
        </span>
      </div>
    </footer>
  );
}
