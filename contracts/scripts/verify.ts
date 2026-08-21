import { network, run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/** Submits source verification for a recorded deployment on the current network. */
async function main() {
  const recordPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(recordPath)) {
    throw new Error(`No deployment record at ${recordPath}. Deploy first.`);
  }
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));

  const jobs: Array<{ label: string; address: string; constructorArguments: unknown[] }> = [
    {
      label: "PumperToken (implementation)",
      address: record.contracts.PumperTokenImplementation,
      constructorArguments: [],
    },
    {
      label: "UniswapV2Migrator",
      address: record.contracts.UniswapV2Migrator,
      constructorArguments: [
        record.contracts.PumperFactory,
        record.external.uniswapV2Router,
        record.external.uniswapV2Factory,
        record.external.weth,
      ],
    },
    {
      label: "PumperFactory",
      address: record.contracts.PumperFactory,
      constructorArguments: [
        record.contracts.PumperTokenImplementation,
        record.contracts.UniswapV2Migrator,
        record.config.feeRecipient,
        record.config.owner,
      ],
    },
  ];

  for (const job of jobs) {
    console.log(`\nVerifying ${job.label} at ${job.address}...`);
    try {
      await run("verify:verify", {
        address: job.address,
        constructorArguments: job.constructorArguments,
      });
      console.log("  verified");
    } catch (error: any) {
      if (String(error?.message ?? "").toLowerCase().includes("already verified")) {
        console.log("  already verified");
      } else {
        console.error(`  failed: ${error?.message ?? error}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
