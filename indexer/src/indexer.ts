import type { Address, Log } from "viem";
import type { PoolClient } from "pg";

import { FACTORY_EVENTS, TRANSFER_EVENT } from "./abi";
import { BlockCache, publicClient } from "./chain";
import { config } from "./config";
import { num, query, withTransaction } from "./db";
import {
  handleLiquidityMigrated,
  handleMigrationTriggered,
  handlePlatformFeeCollected,
  handleTokenBought,
  handleTokenCreated,
  handleTokenSold,
  handleTransfer,
  type EventContext,
} from "./handlers";
import { logger } from "./logger";
import { rollbackToBlock } from "./recompute";

/** Providers cap `eth_getLogs` address lists; chunk to stay well inside every provider's limit. */
const ADDRESS_CHUNK_SIZE = 200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Indexer {
  private cursor = 0n;
  private knownTokens = new Set<string>();
  private running = false;
  private readonly blocks = new BlockCache();

  async initialise(): Promise<void> {
    const state = await query<{ last_indexed_block: string }>(
      `SELECT last_indexed_block FROM indexer_state WHERE id = 1`,
    );

    if (state.length === 0) {
      // `startBlock - 1` because the cursor means "last block fully indexed".
      this.cursor = config.startBlock > 0n ? config.startBlock - 1n : 0n;
      await query(
        `INSERT INTO indexer_state (id, last_indexed_block, chain_id, factory_address)
         VALUES (1, $1, $2, $3)`,
        [num(this.cursor), config.chainId, config.factoryAddress.toLowerCase()],
      );
      logger.info("Indexer state initialised", { fromBlock: config.startBlock });
    } else {
      this.cursor = BigInt(state[0].last_indexed_block);
      logger.info("Resuming indexer", { lastIndexedBlock: this.cursor });
    }

    const tokens = await query<{ address: string }>(`SELECT address FROM tokens`);
    this.knownTokens = new Set(tokens.map((row) => row.address.toLowerCase()));
    logger.info("Loaded token registry", { tokens: this.knownTokens.size });
  }

  async start(): Promise<void> {
    this.running = true;
    logger.info("Indexer started", { pollIntervalMs: config.pollIntervalMs });

    while (this.running) {
      try {
        const advanced = await this.tick();
        if (!advanced) await sleep(config.pollIntervalMs);
      } catch (error) {
        logger.error("Indexer tick failed; retrying", {
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(Math.max(config.pollIntervalMs, 3_000));
      }
    }
  }

  stop(): void {
    this.running = false;
    logger.info("Indexer stopping");
  }

  /** Processes one batch. Returns false when already caught up to the safe head. */
  private async tick(): Promise<boolean> {
    const head = await publicClient.getBlockNumber();
    const safeHead = head > config.confirmations ? head - config.confirmations : 0n;

    if (this.cursor >= safeHead) return false;

    await this.detectAndHandleReorg();

    const fromBlock = this.cursor + 1n;
    const toBlock =
      fromBlock + config.blockBatchSize - 1n > safeHead
        ? safeHead
        : fromBlock + config.blockBatchSize - 1n;

    if (fromBlock > toBlock) return false;

    this.blocks.clear();
    await this.processRange(fromBlock, toBlock);

    const tip = await this.blocks.get(toBlock);
    await query(
      `INSERT INTO blocks (number, hash, parent_hash, timestamp)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (number) DO UPDATE
         SET hash = EXCLUDED.hash, parent_hash = EXCLUDED.parent_hash, timestamp = EXCLUDED.timestamp`,
      [num(toBlock), tip.hash, tip.parentHash, num(tip.timestamp)],
    );
    // Keep a window comfortably deeper than any plausible reorg.
    await query(`DELETE FROM blocks WHERE number < $1`, [num(toBlock - config.reorgDepth * 4n)]);

    this.cursor = toBlock;
    await query(
      `UPDATE indexer_state SET last_indexed_block = $1, last_indexed_block_hash = $2,
              updated_at = now() WHERE id = 1`,
      [num(toBlock), tip.hash],
    );

    const lag = safeHead - toBlock;
    logger.info("Indexed range", {
      from: fromBlock,
      to: toBlock,
      lag,
      tokens: this.knownTokens.size,
    });

    return true;
  }

  /**
   * Compares the most recently indexed block header against the chain. A mismatch means the
   * chain reorganised past our cursor, so we rewind `REORG_DEPTH` blocks and re-index — cheaper
   * and far simpler to reason about than trying to find the exact fork point.
   */
  private async detectAndHandleReorg(): Promise<void> {
    const stored = await query<{ number: string; hash: string }>(
      `SELECT number, hash FROM blocks ORDER BY number DESC LIMIT 1`,
    );
    if (stored.length === 0) return;

    const storedNumber = BigInt(stored[0].number);
    let onChain;
    try {
      onChain = await publicClient.getBlock({ blockNumber: storedNumber });
    } catch {
      return; // block not available yet; the next tick will retry
    }

    if (onChain.hash?.toLowerCase() === stored[0].hash.toLowerCase()) return;

    const target = storedNumber > config.reorgDepth ? storedNumber - config.reorgDepth : 0n;
    logger.warn("Reorg detected", {
      atBlock: storedNumber,
      storedHash: stored[0].hash,
      chainHash: onChain.hash,
      rewindTo: target,
    });

    await withTransaction(async (client) => {
      await rollbackToBlock(client, target);
      await client.query(
        `UPDATE indexer_state SET last_indexed_block = $1, last_indexed_block_hash = NULL,
                updated_at = now() WHERE id = 1`,
        [num(target)],
      );
    });

    this.cursor = target;
    const tokens = await query<{ address: string }>(`SELECT address FROM tokens`);
    this.knownTokens = new Set(tokens.map((row) => row.address.toLowerCase()));
  }

  private async processRange(fromBlock: bigint, toBlock: bigint): Promise<void> {
    // Pass 1 — protocol events. This is the *only* source of token discovery: every token ever
    // launched appears here as a TokenCreated log, with no deployment scanning or tracing.
    const factoryLogs = await publicClient.getLogs({
      address: config.factoryAddress,
      events: FACTORY_EVENTS,
      fromBlock,
      toBlock,
    });

    // Pass 2 — ERC-20 transfers for holder balances. Includes tokens created inside *this*
    // range, otherwise their mint and first trades would be missed.
    const tokensInRange = new Set(this.knownTokens);
    for (const log of factoryLogs) {
      if ((log as any).eventName === "TokenCreated") {
        tokensInRange.add(((log as any).args.token as string).toLowerCase());
      }
    }

    const transferLogs = await this.fetchTransferLogs(tokensInRange, fromBlock, toBlock);

    const ordered = [...factoryLogs, ...transferLogs].sort((a, b) => {
      const blockDelta = Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n));
      if (blockDelta !== 0) return blockDelta;
      return (a.logIndex ?? 0) - (b.logIndex ?? 0);
    });

    if (ordered.length === 0) return;

    await withTransaction(async (client) => {
      for (const log of ordered) {
        await this.dispatch(client, log);
      }
    });
  }

  private async fetchTransferLogs(
    tokens: Set<string>,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<Log[]> {
    if (tokens.size === 0) return [];

    const addresses = [...tokens] as Address[];
    const results: Log[] = [];

    for (let i = 0; i < addresses.length; i += ADDRESS_CHUNK_SIZE) {
      const chunk = addresses.slice(i, i + ADDRESS_CHUNK_SIZE);
      const logs = await publicClient.getLogs({
        address: chunk,
        event: TRANSFER_EVENT,
        fromBlock,
        toBlock,
      });
      results.push(...(logs as Log[]));
    }

    return results;
  }

  private async dispatch(client: PoolClient, log: any): Promise<void> {
    const blockNumber = log.blockNumber as bigint;
    const block = await this.blocks.get(blockNumber);

    const ctx: EventContext = {
      blockNumber,
      blockHash: (log.blockHash as string) ?? block.hash,
      txHash: log.transactionHash as string,
      logIndex: Number(log.logIndex),
      timestamp: block.timestamp,
    };

    switch (log.eventName) {
      case "TokenCreated": {
        await handleTokenCreated(client, log.args, ctx);
        this.knownTokens.add((log.args.token as string).toLowerCase());
        break;
      }
      case "TokenBought":
        await handleTokenBought(client, log.args, ctx);
        break;
      case "TokenSold":
        await handleTokenSold(client, log.args, ctx);
        break;
      case "MigrationTriggered":
        await handleMigrationTriggered(client, log.args, ctx);
        break;
      case "LiquidityMigrated":
        await handleLiquidityMigrated(client, log.args, ctx);
        break;
      case "PlatformFeeCollected":
        await handlePlatformFeeCollected(client, log.args, ctx);
        break;
      case "Transfer": {
        const token = (log.address as string).toLowerCase();
        // Guard against a token whose TokenCreated has not been processed yet (only possible
        // if the address list drifted); the FK would fail loudly otherwise.
        if (!this.knownTokens.has(token)) return;
        await handleTransfer(client, token, log.args, ctx);
        break;
      }
      default:
        break;
    }
  }
}
