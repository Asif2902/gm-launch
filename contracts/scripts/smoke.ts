import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Creates one token and buys a little of it, so the deployment has real events to index.
 * Also a genuine end-to-end proof that the live contracts behave like the tested ones.
 */
async function main() {
  const record = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "baseSepolia.json"), "utf8"),
  );
  const factory = await ethers.getContractAt("PumperFactory", record.contracts.PumperFactory);

  const before = await factory.allTokensLength();
  console.log(`tokens before: ${before}`);

  const tx = await factory.createToken("Pumper Genesis", "GEN", {
    value: ethers.parseEther("0.002"),
  });
  const receipt = await tx.wait();

  const created = receipt!.logs
    .map((log) => { try { return factory.interface.parseLog(log as any); } catch { return null; } })
    .find((p) => p?.name === "TokenCreated")!;
  const token = created.args.token as string;

  console.log(`created: ${token}`);
  console.log(`tx:      ${receipt!.hash}`);
  console.log(`block:   ${receipt!.blockNumber}`);

  const view = await factory.getToken(token);
  console.log(`\nname/symbol : ${view.name} / ${view.symbol}`);
  console.log(`price       : ${view.tokenPrice} wei/token`);
  console.log(`ethReserve  : ${ethers.formatEther(view.ethReserve)} ETH`);
  console.log(`tokenReserve: ${ethers.formatUnits(view.tokenReserve, 18)}`);
  console.log(`progress    : ${Number(view.migrationProgressBps) / 100}%`);
  console.log(`tokens now  : ${await factory.allTokensLength()}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
