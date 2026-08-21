/**
 * Per-network external dependencies — the canonical Uniswap V2 deployment and WETH.
 *
 * The Base mainnet entries were verified live against the chain:
 *   - UniswapV2Router02 0x4752…aD24 reports `factory()` == 0x8909…8eC6 and
 *     `WETH()` == 0x4200…0006.
 *   - UniswapV2Factory  0x8909…8eC6 responds to `allPairsLength()` (millions of pairs).
 *   - WETH 0x4200…0006 is the standard Base predeploy.
 * {UniswapV2Migrator} re-checks the router/factory/WETH relationship in its constructor, so a
 * wrong entry here aborts the deployment instead of producing a mis-wired migrator.
 *
 * Base Sepolia hosts a different V2 deployment; the mainnet addresses do not exist there
 * (0x8909…8eC6 has no code on Sepolia), which is why the two networks list different values.
 *
 * Networks without an entry (hardhat / localhost) get a freshly deployed Uniswap V2 factory,
 * router stand-in and WETH9, so the full migration path is exercised locally too.
 */
export interface NetworkConfig {
  uniswapV2Router: string;
  uniswapV2Factory: string;
  weth: string;
  explorer?: string;
}

export const NETWORKS: Record<string, NetworkConfig> = {
  base: {
    uniswapV2Router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    uniswapV2Factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    weth: "0x4200000000000000000000000000000000000006",
    explorer: "https://basescan.org",
  },
  baseSepolia: {
    uniswapV2Router: "0x1689E7B1F10000AE47eBfE339a4f69dECd19F602",
    uniswapV2Factory: "0x7Ae58f10f7849cA6F5fB71b7f45CB416c9204b1e",
    weth: "0x4200000000000000000000000000000000000006",
    explorer: "https://sepolia.basescan.org",
  },
};

export function configFor(networkName: string): NetworkConfig | undefined {
  return NETWORKS[networkName];
}
