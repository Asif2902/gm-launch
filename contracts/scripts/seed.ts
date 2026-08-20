import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Generates realistic activity against a deployed launchpad so the indexer and frontend have
 * something to display: a few tokens at different points on the curve, plus one that graduates
 * all the way to Uniswap.
 *
 * Budget on Base Sepolia is roughly 6.5 ETH if `--graduate` is used, ~1 ETH otherwise.
 */
const SEED_TOKENS: Array<{ name: string; symbol: string; buys: string[] }> = [
  { name: "Based Doge", symbol: "BDOGE", buys: ["0.05", "0.12", "0.03"] },
  { name: "Sepolia Pepe", symbol: "SPEPE", buys: ["0.2", "0.08"] },
  { name: "Curve Cat", symbol: "CCAT", buys: ["0.01"] },
  { name: "Migration Moon", symbol: "MOON", buys: ["0.3", "0.15"] },
];

async function main() {
  const graduate = process.argv.includes("--graduate");
  const [signer] = await ethers.getSigners();

  const recordPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(recordPath)) throw new Error(`No deployment record at ${recordPath}`);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));

  const factory = await ethers.getContractAt("PumperFactory", record.contracts.PumperFactory);
  const deadline = ethers.MaxUint256;

  console.log(`Seeding ${record.contracts.PumperFactory} on ${network.name} as ${signer.address}`);

  for (const spec of SEED_TOKENS) {
    const tx = await factory.createToken(spec.name, spec.symbol);
    const receipt = await tx.wait();
    const created = receipt!.logs
      .map((log) => {
        try {
          return factory.interface.parseLog(log as any);
        } catch {
          return null;
        }
      })
      .find((p) => p?.name === "TokenCreated")!;
    const address = created.args.token as string;

    console.log(`\n${spec.symbol} -> ${address}`);

    for (const amount of spec.buys) {
      await (
        await factory.buy(address, 0, deadline, { value: ethers.parseEther(amount) })
      ).wait();
      console.log(`  bought with ${amount} ETH`);
    }

    // One sell so the price series has a downward leg to chart.
    const token = await ethers.getContractAt("PumperToken", address);
    const balance = await token.balanceOf(signer.address);
    if (balance > 0n) {
      await (await token.approve(record.contracts.PumperFactory, balance)).wait();
      await (await factory.sell(address, balance / 4n, 0, deadline)).wait();
      console.log("  sold 25% back");
    }

    const view = await factory.getToken(address);
    console.log(
      `  price=${view.tokenPrice} wei/token  reserve=${ethers.formatEther(view.ethReserve)} ETH  progress=${Number(view.migrationProgressBps) / 100}%`,
    );

    if (graduate && spec.symbol === "MOON") {
      console.log("  graduating MOON to Uniswap V2...");
      await (await factory.buy(address, 0, deadline, { value: ethers.parseEther("6") })).wait();
      await (await factory.migrate(address)).wait();
      const migrated = await factory.getToken(address);
      console.log(`  migrated. pair=${migrated.pair}`);
    }
  }

  console.log(`\nDone. ${await factory.allTokensLength()} tokens on the launchpad.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
