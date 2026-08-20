import { INDEXER_URL, SUBGRAPH_URL } from "@/lib/config";

/**
 * Shown when market data could not be loaded.
 *
 * This panel exists because the alternative used to be worse: a failed request would quietly
 * swap in a simulated market, so a misconfigured endpoint looked like a working product until
 * someone noticed the tokens weren't real. Saying "this didn't load" is less impressive and far
 * more useful — it names the source that failed, so the fix is obvious rather than mysterious.
 */
export function DataError({
  title = "Couldn't load market data",
  error,
  onRetry,
}: {
  title?: string;
  error?: unknown;
  onRetry?: () => void;
}) {
  const source = SUBGRAPH_URL ? "subgraph" : "indexer";
  const endpoint = SUBGRAPH_URL || INDEXER_URL;
  const detail = error instanceof Error ? error.message : null;

  return (
    <div className="card p-10 text-center sm:p-14">
      <div className="mx-auto grid h-11 w-11 place-items-center rounded-full border border-warn/30 bg-warn/10">
        <WarningIcon />
      </div>

      <p className="mt-4 font-display text-lg font-bold">{title}</p>

      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
        The {source} did not answer. Nothing is wrong with your wallet — this is the service that
        reads the chain, and prices, trades and history all come from it.
      </p>

      <p className="mx-auto mt-3 max-w-md break-all font-mono text-[11px] text-dim">{endpoint}</p>

      {detail && (
        <p className="mx-auto mt-1 max-w-md break-words font-mono text-[11px] text-dim">{detail}</p>
      )}

      {onRetry && (
        <button type="button" onClick={onRetry} className="btn-ghost btn-sm mt-6">
          Try again
        </button>
      )}
    </div>
  );
}

function WarningIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className="h-5 w-5 text-warn"
      aria-hidden
    >
      <path d="M8 1.75 1.5 13.25h13L8 1.75Z" strokeLinejoin="round" />
      <path d="M8 6.5v3.25" />
      <circle cx="8" cy="11.5" r="0.5" fill="currentColor" />
    </svg>
  );
}

/**
 * Shown before a launchpad exists: the app is running, nothing has been deployed against it yet.
 *
 * Separate from {@link DataError} because the remedy is completely different — there is no
 * outage to wait out and nothing to retry, only a deploy that has not happened. Telling someone
 * their connection failed when they simply have not shipped the contract sends them hunting for
 * a fault that isn't there.
 */
export function NotConfigured() {
  return (
    <div className="card p-10 text-center sm:p-14">
      <div className="mx-auto grid h-11 w-11 place-items-center rounded-full border border-brand/30 bg-brand/10">
        <RocketIcon />
      </div>

      <p className="mt-4 font-display text-lg font-bold">No launchpad deployed yet</p>

      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
        This build has no factory address, so there is nothing to read. Deploy the contracts and
        wire every package from the deployment record:
      </p>

      <pre className="mx-auto mt-4 w-fit rounded-lg border border-line bg-canvas px-4 py-2 text-left font-mono text-xs text-brand-light">
        npm run deploy:base
      </pre>

      <p className="mx-auto mt-3 max-w-md text-xs text-dim">
        Then point <span className="font-mono">VITE_SUBGRAPH_URL</span> at your deployed subgraph.
      </p>
    </div>
  );
}

function RocketIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 text-brand-light"
      aria-hidden
    >
      <path d="M8 1.5c2 1.6 3.2 4 3.2 6.6L8 11.5 4.8 8.1C4.8 5.5 6 3.1 8 1.5Z" />
      <path d="M5.6 10.2 4 12l2 .4.4 2 1.8-1.6" />
      <circle cx="8" cy="6.5" r="1.1" />
    </svg>
  );
}
