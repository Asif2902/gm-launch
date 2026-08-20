import { ChainType, getChains } from "@lifi/sdk";
import { useQuery } from "@tanstack/react-query";

/**
 * Every ecosystem the widget can render.
 *
 * This has to match what the widget asks for, because the two lists have to describe the same
 * world: `/v1/chains` with no `chainTypes` answers with EVM chains only, so omitting it here
 * would silently leave Solana, Bitcoin and Sui out of the allow-list below and make them
 * disappear from a picker that is perfectly capable of using them.
 */
const CHAIN_TYPES = [ChainType.EVM, ChainType.SVM, ChainType.UTXO, ChainType.MVM];

/**
 * The chains LI.FI can actually move real money between.
 *
 * `/v1/chains` includes testnets — four of them at the time of writing (Base Sepolia, OP Sepolia,
 * Arbitrum Sepolia, Arc Testnet) — and the widget renders whatever that endpoint returns. There
 * is no "hide testnets" option in the widget config; LI.FI's documented lever is `chains.allow` /
 * `chains.deny`, which means the caller has to know which is which. Every chain in the response
 * carries a `mainnet` boolean, so we filter on that rather than hard-coding today's four testnet
 * ids and watching the list rot the next time LI.FI adds one.
 *
 * This matters more than tidiness. LI.FI has no testnet routing, so a testnet in the picker is a
 * dead end at best; picked as a *destination* it is a way to send real funds somewhere they
 * cannot come back from.
 */
export function useLifiMainnetChains() {
  return useQuery({
    queryKey: ["lifi", "chains", "mainnet"],
    queryFn: async () => {
      const chains = await getChains({ chainTypes: CHAIN_TYPES });
      const mainnets = chains.filter((chain) => chain.mainnet);

      /**
       * A response we cannot classify is treated as a failed one.
       *
       * If `mainnet` ever stops being populated, every chain filters out and the honest reading
       * is "we no longer know which of these are real" — not "show them all and hope". Throwing
       * puts the bridge into its error state, which is recoverable; the alternative silently
       * reopens the exact hole this function exists to close.
       */
      if (!mainnets.length) {
        throw new Error(
          `LI.FI returned ${chains.length} chains but none flagged as mainnet — cannot tell real networks from testnets.`,
        );
      }

      return mainnets;
    },
    // The widget refreshes its own copy on the same cadence; there is no reason to be keener.
    staleTime: 300_000,
    gcTime: 3_600_000,
    retry: 1,
  });
}
