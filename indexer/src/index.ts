import { createApi } from "./api";
import { verifyChainConstants } from "./chain";
import { config } from "./config";
import { closePool } from "./db";
import { Indexer } from "./indexer";
import { logger } from "./logger";

async function main() {
  logger.info("Starting Pumper indexer", {
    chainId: config.chainId,
    factory: config.factoryAddress,
    apiOnly: config.apiOnly,
  });

  await verifyChainConstants();

  const api = createApi();
  const server = api.listen(config.apiPort, () => {
    logger.info("API listening", { port: config.apiPort });
  });

  let indexer: Indexer | undefined;
  if (!config.apiOnly) {
    indexer = new Indexer();
    await indexer.initialise();
    // Fire and forget: the loop owns its own error handling and never resolves.
    void indexer.start();
  }

  const shutdown = async (signal: string) => {
    logger.info("Shutting down", { signal });
    indexer?.stop();
    server.close();
    await closePool();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(async (error) => {
  logger.error("Fatal startup error", {
    error: error instanceof Error ? error.message : String(error),
  });
  await closePool();
  process.exit(1);
});
