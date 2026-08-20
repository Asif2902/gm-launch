/**
 * Chain configuration for the API server.
 *
 * Only what signature verification and the creator check need: an RPC endpoint and the
 * launchpad address. Deliberately separate from the frontend's config — this process holds
 * credentials and must not import anything that assumes a browser.
 */
import * as dotenv from "dotenv";

dotenv.config();

export const PORT = Number(process.env.PORT ?? 4100);

export const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";

/**
 * The name shown in the wallet's sign-in prompt, and part of the signed message.
 *
 * Server-side policy rather than something the caller sends: a signature is only meaningful if
 * the user can see which site they are signing into, and a client-supplied domain could name any
 * site at all.
 */
export const AUTH_DOMAIN = process.env.AUTH_DOMAIN ?? "gm Launch";

export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 8453);

export const RPC_URL = process.env.RPC_URL ?? "https://mainnet.base.org";

export const FACTORY_ADDRESS = (process.env.FACTORY_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as `0x${string}`;
