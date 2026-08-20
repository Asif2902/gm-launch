import { createPublicClient, http, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";

import { FACTORY_VIEW_ABI } from "./abi";
import { PROTOCOL, config } from "./config";
import { logger } from "./logger";

const CHAINS = { 8453: base, 84532: baseSepolia } as const;

export const publicClient: PublicClient = createPublicClient({
  chain: CHAINS[config.chainId as keyof typeof CHAINS] ?? baseSepolia,
  transport: http(config.rpcUrl, { batch: true, retryCount: 5, retryDelay: 250 }),
}) as PublicClient;

/**
 * Refuses to start against a factory whose constants disagree with the indexer's assumptions.
 * A silent mismatch here (wrong address, stale ABI, redeployed contracts) would produce a
 * database full of subtly wrong prices, which is far worse than failing loudly on boot.
 */
export async function verifyChainConstants(): Promise<void> {
  const code = await publicClient.getBytecode({ address: config.factoryAddress });
  if (!code || code === "0x") {
    throw new Error(
      `No contract at FACTORY_ADDRESS ${config.factoryAddress} on chain ${config.chainId}`,
    );
  }

  const [totalSupply, virtualEth, threshold, buyFee, sellFee] = await Promise.all([
    publicClient.readContract({
      address: config.factoryAddress,
      abi: FACTORY_VIEW_ABI,
      functionName: "TOTAL_SUPPLY",
    }),
    publicClient.readContract({
      address: config.factoryAddress,
      abi: FACTORY_VIEW_ABI,
      functionName: "VIRTUAL_ETH_RESERVE",
    }),
    publicClient.readContract({
      address: config.factoryAddress,
      abi: FACTORY_VIEW_ABI,
      functionName: "MIGRATION_THRESHOLD",
    }),
    publicClient.readContract({
      address: config.factoryAddress,
      abi: FACTORY_VIEW_ABI,
      functionName: "BUY_FEE_BPS",
    }),
    publicClient.readContract({
      address: config.factoryAddress,
      abi: FACTORY_VIEW_ABI,
      functionName: "SELL_FEE_BPS",
    }),
  ]);

  const mismatches: string[] = [];
  if (totalSupply !== PROTOCOL.totalSupply) mismatches.push(`TOTAL_SUPPLY=${totalSupply}`);
  if (virtualEth !== PROTOCOL.virtualEthReserve) mismatches.push(`VIRTUAL_ETH_RESERVE=${virtualEth}`);
  if (threshold !== PROTOCOL.migrationThreshold) mismatches.push(`MIGRATION_THRESHOLD=${threshold}`);
  if (buyFee !== 20n) mismatches.push(`BUY_FEE_BPS=${buyFee}`);
  if (sellFee !== 30n) mismatches.push(`SELL_FEE_BPS=${sellFee}`);

  if (mismatches.length > 0) {
    throw new Error(`On-chain constants do not match the indexer's: ${mismatches.join(", ")}`);
  }

  logger.info("Chain constants verified", {
    factory: config.factoryAddress,
    chainId: config.chainId,
  });
}

/** Block timestamps, memoised for the lifetime of a batch. */
export class BlockCache {
  private readonly cache = new Map<bigint, { hash: string; parentHash: string; timestamp: bigint }>();

  async get(blockNumber: bigint) {
    const cached = this.cache.get(blockNumber);
    if (cached) return cached;

    const block = await publicClient.getBlock({ blockNumber });
    const entry = {
      hash: block.hash as string,
      parentHash: block.parentHash as string,
      timestamp: block.timestamp,
    };
    this.cache.set(blockNumber, entry);
    return entry;
  }

  clear(): void {
    this.cache.clear();
  }
}
