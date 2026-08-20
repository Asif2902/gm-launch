import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAccount, useSignMessage } from "wagmi";

import {
  SessionExpiredError,
  clearStoredSession,
  loadSession,
  onSessionRotated,
  openSession,
  refreshSession,
  type WalletSession,
} from "@/lib/session";

/**
 * Holds the wallet session for the whole app.
 *
 * The prompt fires once, automatically, the first time a wallet connects — that is the moment a
 * signature request makes sense, because the user just chose to connect and the message they see
 * explains exactly what the session covers.
 *
 * If they decline, that is an answer, not an error to retry: the app stays usable (all of it is
 * readable without a session, and trading needs transactions rather than this token) and the
 * prompt only returns when they ask for it or attempt a write. Re-prompting a wallet that has
 * already said no is how a site ends up looking like malware.
 *
 * After that, the session renews itself. Every authenticated request carries a rotated token back
 * on its response, and an open tab heartbeats so that simply reading the site counts as being
 * here — so an active user is never asked to sign again until the hard cap set at sign-in. Close
 * the tab and the heartbeat stops, which is what lets the idle window be generous without the
 * credential outliving its owner's attention.
 */

export type SessionStatus = "idle" | "signing" | "ready" | "declined" | "error";

/**
 * How often an open tab checks whether its session wants renewing.
 *
 * Five minutes is far below any idle window worth configuring, so a renewal never races an
 * expiry, and it costs one tiny request per five minutes only while the tab is actually visible.
 */
const HEARTBEAT_MS = 5 * 60_000;

/**
 * How much life must be left before a heartbeat bothers renewing.
 *
 * Comfortably longer than the heartbeat interval, so a renewal is attempted many times over
 * before anything could lapse, and short enough that a session with hours remaining generates no
 * traffic at all.
 */
const RENEW_WHEN_UNDER_MS = 60 * 60_000;

interface SessionContextValue {
  session: WalletSession | null;
  token: string | null;
  status: SessionStatus;
  error: string | null;
  /** Opens a session, reusing a live one. Returns null if the user declines. */
  signIn: () => Promise<WalletSession | null>;
  /** Drops the session locally; the token simply stops being sent. */
  signOut: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const [session, setSession] = useState<WalletSession | null>(null);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  // Which address we have already offered to sign in, so a decline isn't asked again on every
  // render — and so switching accounts *does* get its own prompt.
  const promptedFor = useRef<string | null>(null);
  const inFlight = useRef<Promise<WalletSession | null> | null>(null);

  // Follow tokens the server rotates onto responses, so React state matches what is stored.
  useEffect(() => onSessionRotated(setSession), []);

  // Adopt any stored session whenever the connected account changes.
  useEffect(() => {
    const stored = loadSession(address);
    setSession(stored);
    setStatus(stored ? "ready" : "idle");
    setError(null);
    if (address?.toLowerCase() !== promptedFor.current) promptedFor.current = null;
  }, [address]);

  const signIn = useCallback(async (): Promise<WalletSession | null> => {
    if (!address) return null;

    const existing = loadSession(address);
    if (existing) {
      setSession(existing);
      setStatus("ready");
      return existing;
    }

    // Two components can ask at once (the header on mount, a save button a moment later). One
    // wallet prompt, one promise, both callers get the same answer.
    if (inFlight.current) return inFlight.current;

    promptedFor.current = address.toLowerCase();
    setStatus("signing");
    setError(null);

    const attempt = (async () => {
      try {
        const opened = await openSession(address, (message) => signMessageAsync({ message }));
        setSession(opened);
        setStatus("ready");
        return opened;
      } catch (signInError) {
        const message =
          signInError instanceof Error ? signInError.message : "Could not sign in";
        // A rejected prompt is a decision; anything else is a fault worth showing.
        const declined = /reject|denied|cancel/i.test(message);
        setStatus(declined ? "declined" : "error");
        setError(declined ? null : message);
        return null;
      } finally {
        inFlight.current = null;
      }
    })();

    inFlight.current = attempt;
    return attempt;
  }, [address, signMessageAsync]);

  const signOut = useCallback(() => {
    clearStoredSession();
    setSession(null);
    setStatus("idle");
    setError(null);
    promptedFor.current = null;
  }, []);

  // The one automatic prompt, on first connect with no live session.
  useEffect(() => {
    if (!isConnected || !address) return;
    if (session || status === "signing") return;
    if (promptedFor.current === address.toLowerCase()) return;
    void signIn();
  }, [isConnected, address, session, status, signIn]);

  /**
   * Heartbeat: an open tab renews its own session.
   *
   * Reads are unauthenticated, so without this a session would only ever be renewed by a write —
   * and someone who browsed for an hour before clicking "edit" would be asked to sign at exactly
   * the wrong moment. Renewal needs a live token and cannot pass the hard cap, so this extends
   * convenience, not authority.
   *
   * It is skipped while the tab is hidden: a background tab is not somebody using the site, and
   * keeping a credential alive for one would defeat the idle timeout.
   */
  useEffect(() => {
    if (!session) return;

    const beat = () => {
      // A background tab is not somebody using the site.
      if (document.visibilityState !== "visible") return;

      // Renewing a token that has hours left is pure churn; wait until it is actually getting on.
      const remaining = session.expiresAt - Date.now();
      if (remaining > RENEW_WHEN_UNDER_MS) return;

      // Against the hard cap, no renewal can extend anything — stop asking and let it end.
      if (session.expiresAt >= session.absoluteExpiresAt) return;

      void refreshSession(session).then((renewed) => {
        if (renewed) setSession(renewed);
      });
    };

    const timer = setInterval(beat, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", beat);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", beat);
    };
  }, [session]);

  // Expire in place, so a tab left open past the hard cap shows "sign in" rather than a dead token.
  useEffect(() => {
    if (!session) return;
    const remaining = session.expiresAt - Date.now();
    if (remaining <= 0) {
      setSession(null);
      setStatus("idle");
      return;
    }
    const timer = setTimeout(() => {
      setSession(null);
      setStatus("idle");
      clearStoredSession();
    }, remaining);
    return () => clearTimeout(timer);
  }, [session]);

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      token: session?.token ?? null,
      status,
      error,
      signIn,
      signOut,
    }),
    [session, status, error, signIn, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside <SessionProvider>");
  return value;
}

/**
 * A token for a write that is about to happen, prompting for one if the session lapsed.
 *
 * Call sites use this rather than reading `token` directly so an expired session recovers with a
 * single signature instead of failing the save.
 */
export function useAuthToken(): () => Promise<string | null> {
  const { token, signIn } = useSession();
  return useCallback(async () => {
    if (token) return token;
    const opened = await signIn();
    return opened?.token ?? null;
  }, [token, signIn]);
}

/**
 * Runs a write with a session token, recovering once if the server rejects the session.
 *
 * The token can be stale in ways the client cannot see — the API restarted with a new signing
 * key, the session was renewed in another tab, the clocks disagree by a hair. Every one of those
 * surfaces as a 401 on an otherwise valid-looking session, and making the user find the save
 * button again is a poor way to tell them. So: drop the dead token, sign in once, retry once.
 *
 * Exactly once. A second 401 after a fresh signature is a real refusal, not a stale token, and
 * looping on it would be a wallet prompt that never ends.
 */
export function useAuthedWrite(): <T>(run: (token: string) => Promise<T>) => Promise<T> {
  const { signIn, signOut } = useSession();
  const getToken = useAuthToken();

  return useCallback(
    async <T,>(run: (token: string) => Promise<T>): Promise<T> => {
      const token = await getToken();
      if (!token) throw new Error("Sign in with your wallet to save changes");

      try {
        return await run(token);
      } catch (error) {
        if (!(error instanceof SessionExpiredError)) throw error;

        signOut();
        const renewed = await signIn();
        if (!renewed) throw error;
        return run(renewed.token);
      }
    },
    [getToken, signIn, signOut],
  );
}
