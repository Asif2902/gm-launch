import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const BASE_SEPOLIA_RPC_URL =
  process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";

/**
 * Base mainnet. The public endpoint works for a deploy, but it is rate limited — point this at a
 * provider of your own before broadcasting anything that matters.
 */
const BASE_RPC_URL = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY ?? "";

/**
 * Accepts a private key only if it is actually one.
 *
 * Hardhat throws `HH8: Invalid account` at *config load* for a malformed key, which breaks every
 * command — `compile`, `test`, `node` — not just the ones that need to sign. Since the wrong
 * value in this slot is a common paste error (an API token, a mnemonic, a deploy key), validate
 * it here and warn instead: local work keeps running, and only network commands are affected,
 * with an explanation instead of an opaque error code.
 */
function loadAccounts(): string[] {
  const raw = (process.env.PRIVATE_KEY ?? "").trim().replace(/^["']|["']$/g, "");
  if (raw === "") return [];

  const normalised = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (/^0x[0-9a-fA-F]{64}$/.test(normalised)) return [normalised];

  console.warn(
    `\n[hardhat] PRIVATE_KEY is set but is not a valid key: expected 64 hex characters, ` +
      `got ${raw.replace(/^0x/, "").length}. Network commands will have no signer.\n` +
      `          It looks like a different credential was pasted into contracts/.env.\n`,
  );
  return [];
}

const ACCOUNTS = loadAccounts();

/**
 * Two compilers are configured on purpose:
 *
 *  - 0.8.24  -> all Pumper protocol contracts.
 *  - 0.5.16  -> the *real* @uniswap/v2-core sources (UniswapV2Factory / UniswapV2Pair),
 *               pulled in only for integration tests so migration is exercised against
 *               the genuine pair implementation rather than a hand-written mock.
 *
 * `evmVersion: paris` keeps the deployed bytecode free of PUSH0, which some Base
 * tooling / forks still choke on. Base Sepolia itself supports Cancun, but Paris
 * costs nothing here and maximises portability.
 */
const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: {
          optimizer: { enabled: true, runs: 800 },
          evmVersion: "paris",
          viaIR: false,
        },
      },
      {
        version: "0.5.16",
        settings: {
          optimizer: { enabled: true, runs: 999999 },
        },
      },
    ],
  },
  networks: {
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: false,
    },
    baseSepolia: {
      url: BASE_SEPOLIA_RPC_URL,
      chainId: 84532,
      accounts: ACCOUNTS,
    },
    base: {
      url: BASE_RPC_URL,
      chainId: 8453,
      accounts: ACCOUNTS,
    },
  },
  etherscan: {
    apiKey: { baseSepolia: BASESCAN_API_KEY, base: BASESCAN_API_KEY },
    customChains: [
      {
        network: "baseSepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
    ],
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
  mocha: {
    timeout: 120_000,
  },
};

export default config;
