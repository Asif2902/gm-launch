import { Link, useLocation } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";

import { CHAIN_ID, NETWORK_NAME } from "@/lib/config";
import { activeSource } from "@/lib/api";
import { shortAddress } from "@/lib/format";
import { AccountLabel, useProfileFor } from "./Account";
import { BaseLogo } from "./BaseLogo";
import { EthRate } from "./Money";
import { useSession } from "./SessionProvider";

/**
 * The one persistent bar: where you are, what you're connected as, and the way to launch a coin.
 *
 * Everything optional has been pushed out of it. The network, the data source and the ETH rate
 * are still here because a testnet deployment serving simulated numbers must say so — but they
 * are sized as the diagnostics they are, and drop off entirely on narrow screens where the nav
 * and the wallet matter more.
 */

const NAV = [
  { href: "/", label: "Terminal" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/bridge", label: "Bridge" },
];

export function Header() {
  const pathname = useLocation().pathname;
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { session, status: sessionStatus, signIn, signOut } = useSession();

  // Your own profile, so the pill shows who you are rather than what your address is.
  const profile = useProfileFor(address);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  // Fixed for the session now that the simulation is opt-in — nothing switches it at runtime.
  const source = activeSource();
  const pickerRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);

  // One listener closes whichever popover is open when the click lands outside it.
  useEffect(() => {
    if (!pickerOpen && !accountOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!pickerRef.current?.contains(target)) setPickerOpen(false);
      if (!accountRef.current?.contains(target)) setAccountOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [pickerOpen, accountOpen]);

  /**
   * Being on another chain is only wrong where it stops you trading.
   *
   * The bridge exists precisely to move funds *from* somewhere else, so the wallet sitting on
   * Ethereum or Arbitrum there is the expected state — nagging about it would be telling the user
   * to undo the thing the page just asked them to do.
   */
  const wrongNetwork =
    isConnected && chainId !== CHAIN_ID && !pathname.startsWith("/bridge");
  const signedIn = sessionStatus === "ready";

  return (
    <header className="sticky top-0 z-50 border-b border-line/70 bg-canvas/85 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-[1600px] items-center gap-3 px-4 py-2.5 sm:gap-6">
        {/* --- wordmark --- */}
        <Link to="/" className="flex shrink-0 items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand text-white">
            <BaseLogo className="h-3.5 w-3.5" />
          </span>
          <span className="font-display text-[16px] font-bold tracking-tight">
            gm<span className="text-brand-light"> Launch</span>
          </span>
        </Link>

        {/* --- nav --- */}
        <nav className="flex items-center gap-1">
          {NAV.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                to={item.href}
                className={`rounded-lg px-2.5 py-1.5 text-[13px] font-semibold transition-colors sm:px-3 ${
                  active ? "text-brand-light" : "text-muted hover:text-white"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {/* Simulated data is always labelled — it is never passed off as live. */}
          {source === "demo" ? (
            <span className="chip border-gold/35 bg-gold/10 text-gold">
              <span className="h-1.5 w-1.5 rounded-full bg-gold" />
              <span className="hidden sm:inline">Demo data</span>
            </span>
          ) : (
            <span
              className="chip hidden border-line bg-elevated/70 text-muted 2xl:inline-flex"
              title={
                source === "subgraph"
                  ? "Market data from The Graph"
                  : "Market data from the REST indexer"
              }
            >
              <span className="live-dot" />
              {source === "subgraph" ? "Subgraph" : "Indexer"}
            </span>
          )}

          {/* Makes the source of every USD figure on the site visible rather than implicit. */}
          <EthRate className="tnum chip hidden border-line bg-elevated/70 text-muted xl:inline-flex" />

          <span className="chip hidden border-line bg-elevated/70 text-muted lg:inline-flex">
            <BaseLogo className="h-2.5 w-2.5 text-brand-light" />
            {NETWORK_NAME}
          </span>

          {wrongNetwork && (
            <button
              type="button"
              onClick={() => switchChain({ chainId: CHAIN_ID })}
              className="btn btn-sm border border-warn/40 bg-warn/10 text-warn hover:bg-warn/20"
            >
              Wrong network
            </button>
          )}

          <Link to="/create" className="btn-primary btn-sm rounded-full">
            <PlusIcon />
            Create
          </Link>

          {isConnected ? (
            <div className="relative" ref={accountRef}>
              <button
                type="button"
                onClick={() => setAccountOpen((open) => !open)}
                className="flex max-w-[170px] items-center gap-2 rounded-full border border-line bg-elevated/80 py-1 pl-1 pr-2.5 text-xs font-semibold transition-colors hover:border-brand/40"
              >
                <AccountLabel address={address ?? ""} profile={profile} size={22} />
              </button>

              {accountOpen && (
                <div className="glass absolute right-0 top-full z-50 mt-2 w-60 animate-fade-up overflow-hidden p-1">
                  {/* Sessions are invisible when they work, so the only place their state can be
                      read — and revoked — is here. */}
                  <div className="border-b border-line/70 px-3 py-2.5">
                    {/* The pill shows a name when there is one, so the address lives here —
                        it is still the thing you copy, verify and paste. */}
                    <div className="label">Wallet</div>
                    <p className="mt-1 font-mono text-xs text-muted">
                      {shortAddress(address ?? "", 6)}
                    </p>
                  </div>

                  <div className="border-b border-line/70 px-3 py-2.5">
                    <div className="label">Session</div>
                    {signedIn && session ? (
                      <p className="mt-1 text-xs text-muted">
                        {/* Read at render rather than memoised, so opening the menu shows what is
                            actually left. The session slides forward while you use the site, so
                            the meaningful number is the hard cap, not the current token. */}
                        Signed in · renews while you&apos;re here, ends{" "}
                        <span className="font-semibold text-white">
                          {formatRelativeDeadline(session.absoluteExpiresAt)}
                        </span>
                      </p>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void signIn()}
                        disabled={sessionStatus === "signing"}
                        className="mt-1 text-xs font-semibold text-brand-light hover:underline disabled:opacity-50"
                      >
                        {sessionStatus === "signing" ? "Check your wallet…" : "Sign in to edit"}
                      </button>
                    )}
                  </div>

                  <Link
                    to={`/u/${address}`}
                    onClick={() => setAccountOpen(false)}
                    className="mt-1 flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-raised"
                  >
                    <PersonIcon />
                    My profile
                  </Link>
                  <button
                    type="button"
                    onClick={() => {
                      // Disconnecting is an explicit "log me out": drop the session with it,
                      // rather than leaving a live token behind for the next connect.
                      signOut();
                      disconnect();
                      setAccountOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-muted transition-colors hover:bg-raised hover:text-down-light"
                  >
                    <ExitIcon />
                    Disconnect
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="relative" ref={pickerRef}>
              <button
                type="button"
                onClick={() => {
                  if (connectors.length === 1) connect({ connector: connectors[0] });
                  else setPickerOpen((open) => !open);
                }}
                disabled={isPending || connectors.length === 0}
                className="btn-ghost btn-sm rounded-full"
              >
                {isPending
                  ? "Connecting…"
                  : connectors.length === 0
                    ? "No wallet"
                    : "Connect"}
              </button>

              {pickerOpen && connectors.length > 1 && (
                <div className="glass absolute right-0 top-full z-50 mt-2 w-60 animate-fade-up overflow-hidden p-1">
                  {connectors.map((connector) => (
                    <button
                      key={connector.uid}
                      type="button"
                      onClick={() => {
                        connect({ connector });
                        setPickerOpen(false);
                      }}
                      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-raised"
                    >
                      {connector.icon ? (
                        <img src={connector.icon} alt="" className="h-5 w-5 rounded" />
                      ) : (
                        <span className="h-5 w-5 rounded bg-raised" />
                      )}
                      {connector.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

/** "in 6 days" / "in 3 hours" — the shape of answer a session deadline actually wants. */
function formatRelativeDeadline(timestamp: number): string {
  const minutes = Math.max(0, Math.round((timestamp - Date.now()) / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      className="h-3 w-3"
      aria-hidden
    >
      <path d="M6 2v8M2 6h8" />
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="h-3.5 w-3.5"
      aria-hidden
    >
      <circle cx="8" cy="5.5" r="2.75" />
      <path d="M2.75 13.5a5.25 5.25 0 0 1 10.5 0" strokeLinecap="round" />
    </svg>
  );
}

function ExitIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className="h-3.5 w-3.5"
      aria-hidden
    >
      <path d="M6 2.75H3.75a1 1 0 0 0-1 1v8.5a1 1 0 0 0 1 1H6" />
      <path d="M10.5 5.5 13 8l-2.5 2.5M13 8H6.5" />
    </svg>
  );
}
