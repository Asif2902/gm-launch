/**
 * Per-network external dependencies.
 *
 * The Base Sepolia entries were verified live against the chain:
 *   - UniswapV2Factory 0x7Ae58…4b1e responds to `allPairsLength()` and is the `factory()` of
 *     the canonical Router02 at 0x1689E7B1F10000AE47eBfE339a4f69dECd19F602.
 *   - WETH 0x4200…0006 is the standard Base predeploy (`symbol()` == "WETH").
 *
 * Networks without an entry (hardhat / localhost) get a freshly deployed Uniswap V2 factory and
 * a WETH9 stand-in, so the full migration path is exercised locally too.
 */
export interface NetworkConfig {
  uniswapV2Factory: string;
  weth: string;
  explorer?: string;
}

export const NETWORKS: Record<string, NetworkConfig> = {
  baseSepolia: {
    uniswapV2Factory: "0x7Ae58f10f7849cA6F5fB71b7f45CB416c9204b1e",
    weth: "0x4200000000000000000000000000000000000006",
    explorer: "https://sepolia.basescan.org",
  },
  base: {
    uniswapV2Factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    weth: "0x4200000000000000000000000000000000000006",
    explorer: "https://basescan.org",
  },
};

export function configFor(networkName: string): NetworkConfig | undefined {
  return NETWORKS[networkName];
}
