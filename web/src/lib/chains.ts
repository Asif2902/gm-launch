import { base, baseSepolia } from "wagmi/chains";

import { CHAIN_ID } from "./config";

/**
 * The one chain the launchpad itself trades on.
 *
 * Kept in its own module rather than in `App.tsx` so the bridge can import it without dragging
 * the app shell — and its LI.FI dependencies — back into the main bundle.
 */
export const homeChain = CHAIN_ID === base.id ? base : baseSepolia;
