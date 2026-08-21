import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

import { configFor } from "./config";
import { exportAbis } from "./export-abis";

/**
 * Deploys the Pumper stack.
 *
 * The launchpad and the migrator hold each other as immutables, which would normally be a
 * chicken-and-egg problem. Instead of adding a setter (and with it an admin power and a window
 * of misconfiguration), the script predicts the launchpad's CREATE address from the deployer's
 * nonce and hands it to the migrator first. The launchpad's constructor then asserts
 * `migrator.launchpad() == address(this)`, so a wrong prediction aborts the deployment rather
 * than producing a broken system.
 *
 *   nonce n     -> PumperToken implementation
 *   nonce n + 1 -> UniswapV2Migrator      (told the launchpad will be at nonce n + 2)
 *   nonce n + 2 -> PumperFactory          (verifies the link)
 */
/**
 * Blocks until the RPC actually reports code at `address`.
 *
 * Public endpoints are load balanced, so a read issued immediately after a deploy can land on a
 * node that hasn't seen the block yet and return `0x` — which ethers surfaces as a confusing
 * `BAD_DATA: could not decode result data` rather than "not there yet". Polling turns a spurious
 * failure into a short wait.
 */
async function waitForCode(address: string, label: string, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if ((await ethers.provider.getCode(address)) !== "0x") return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`No code at ${label} (${address}) after ${attempts * 2}s`);
}

/**
 * Finds the block a contract was created in, by binary searching for the first block that
 * reports code at the address.
 *
 * This matters more than it looks: the value becomes `START_BLOCK` for the indexer and
 * `startBlock` for the subgraph. Using "the current head" instead — which is what you get if the
 * script is re-run after the fact — silently skips every event emitted before the re-run, and the
 * symptom is an indexer that reports zero tokens rather than an error.
 */
async function findDeploymentBlock(address: string): Promise<number> {
  let low = 0;
  let high = await ethers.provider.getBlockNumber();

  if ((await ethers.provider.getCode(address, high)) === "0x") {
    throw new Error(`No code at ${address} at head block ${high}`);
  }

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const code = await ethers.provider.getCode(address, mid);
    if (code === "0x") low = mid + 1;
    else high = mid;
  }
  return low;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = network.name;

  console.log(`\n=== Pumper deployment — ${networkName} ===`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);

  // --- external dependencies ---------------------------------------------------------------
  let { uniswapV2Router, uniswapV2Factory, weth } =
    configFor(networkName) ?? { uniswapV2Router: "", uniswapV2Factory: "", weth: "" };

  /**
   * `DEPLOY_UNISWAP_V2=true` deploys our own V2 factory (plus the local router stand-in)
   * instead of using the network's canonical deployment.
   *
   * This is a *testnet-only* convenience: you own the deployment, nobody else can pre-seed
   * pairs against it, and it can't disappear. The factory bytecode is the genuine
   * @uniswap/v2-core factory (solc 0.5.16), so pair behaviour — including `MINIMUM_LIQUIDITY`
   * and the exact `mint` maths migration relies on — is identical to mainnet. The router,
   * however, is `TestUniswapV2Router02`, not the canonical Router02, because Router02 resolves
   * pairs through a hard-coded init-code hash that only matches the canonical factory.
   *
   * On mainnet, leave this unset: the canonical router and factory in scripts/config.ts are
   * used, and the migrator's constructor asserts they belong together.
   */
  // Tracks whether the V2 deployment is one we control. Recorded in the deployment file because
  // it decides what changes on the way to mainnet: a factory we own is a testnet convenience,
  // and mainnet must switch to the canonical one.
  let uniswapV2FactoryIsOurs = process.env.DEPLOY_UNISWAP_V2 === "true";

  // Explicit overrides win over both the network default and DEPLOY_UNISWAP_V2 — they let a
  // re-run reuse contracts a previous attempt already paid for. Keep DEPLOY_UNISWAP_V2 set
  // alongside them so the ownership flag stays accurate across the re-run.
  if (process.env.UNISWAP_V2_ROUTER_ADDRESS || process.env.UNISWAP_V2_FACTORY_ADDRESS) {
    uniswapV2Router = process.env.UNISWAP_V2_ROUTER_ADDRESS || uniswapV2Router;
    uniswapV2Factory = process.env.UNISWAP_V2_FACTORY_ADDRESS || uniswapV2Factory;
    console.log(`Using UniswapV2Router from env:  ${uniswapV2Router}`);
    console.log(`Using UniswapV2Factory from env: ${uniswapV2Factory}`);
  } else if (process.env.DEPLOY_UNISWAP_V2 === "true") {
    if (!weth) {
      throw new Error(
        `No WETH configured for ${networkName}. Add one to scripts/config.ts — the pair needs a ` +
          `wrapped-native token and deploying a second one would fragment liquidity.`,
      );
    }
    console.log("DEPLOY_UNISWAP_V2=true — deploying our own UniswapV2Factory + router...");
    const ownFactory = await (
      await ethers.getContractFactory("UniswapV2Factory")
    ).deploy(deployer.address); // feeToSetter; feeTo stays unset, so no protocol fee
    await ownFactory.waitForDeployment();
    uniswapV2Factory = await ownFactory.getAddress();

    const ownRouter = await (
      await ethers.getContractFactory("TestUniswapV2Router02")
    ).deploy(uniswapV2Factory, weth);
    await ownRouter.waitForDeployment();
    uniswapV2Router = await ownRouter.getAddress();

    uniswapV2FactoryIsOurs = true;
    console.log(`  UniswapV2Factory: ${uniswapV2Factory}`);
    console.log(`  UniswapV2Router:  ${uniswapV2Router}`);
    console.log(`  Using WETH:       ${weth}\n`);
  }

  if (!uniswapV2Router || !uniswapV2Factory || !weth) {
    console.log("No external config for this network — deploying a local Uniswap V2 + WETH...");
    const localWeth = await (await ethers.getContractFactory("MockWETH")).deploy();
    await localWeth.waitForDeployment();
    const localUniswap = await (
      await ethers.getContractFactory("UniswapV2Factory")
    ).deploy(deployer.address);
    await localUniswap.waitForDeployment();

    weth = await localWeth.getAddress();
    uniswapV2Factory = await localUniswap.getAddress();

    const localRouter = await (
      await ethers.getContractFactory("TestUniswapV2Router02")
    ).deploy(uniswapV2Factory, weth);
    await localRouter.waitForDeployment();
    uniswapV2Router = await localRouter.getAddress();

    uniswapV2FactoryIsOurs = true;
    console.log(`  WETH:            ${weth}`);
    console.log(`  UniswapV2Factory:${uniswapV2Factory}`);
    console.log(`  UniswapV2Router: ${uniswapV2Router}\n`);
  } else {
    // Fail fast rather than deploying against an address with no code.
    for (const [label, address] of [
      ["UniswapV2Router", uniswapV2Router],
      ["UniswapV2Factory", uniswapV2Factory],
      ["WETH", weth],
    ] as const) {
      const code = await ethers.provider.getCode(address);
      if (code === "0x") throw new Error(`${label} at ${address} has no code on ${networkName}`);
      console.log(`Using ${label}: ${address}`);
    }

    // The migrator's constructor enforces this too, but checking here costs one free RPC call
    // instead of one reverted deployment — and it catches a copy-paste of addresses from the
    // wrong chain, which is the realistic failure mode.
    const router = await ethers.getContractAt("IUniswapV2Router02", uniswapV2Router);
    const routerFactory = await router.factory();
    const routerWeth = await router.WETH();
    if (routerFactory.toLowerCase() !== uniswapV2Factory.toLowerCase()) {
      throw new Error(
        `Router ${uniswapV2Router} reports factory ${routerFactory}, but the config says ` +
          `${uniswapV2Factory}. These must be the same Uniswap V2 deployment.`,
      );
    }
    if (routerWeth.toLowerCase() !== weth.toLowerCase()) {
      throw new Error(
        `Router ${uniswapV2Router} reports WETH ${routerWeth}, but the config says ${weth}.`,
      );
    }
    console.log("  router.factory() and router.WETH() match the configured addresses");
    console.log();
  }

  const feeRecipient = process.env.FEE_RECIPIENT || deployer.address;
  const owner = process.env.OWNER || deployer.address;

  // --- 1. token implementation --------------------------------------------------------------
  // Reusable across re-runs: if a previous attempt failed later on, don't pay for this again.
  let tokenImplementationAddress = process.env.TOKEN_IMPLEMENTATION_ADDRESS ?? "";
  let lastNonce: number;

  if (tokenImplementationAddress) {
    console.log(`PumperToken (implementation): ${tokenImplementationAddress} (reused)`);
    lastNonce = (await ethers.provider.getTransactionCount(deployer.address)) - 1;
  } else {
    const tokenImplementation = await (await ethers.getContractFactory("PumperToken")).deploy();
    await tokenImplementation.waitForDeployment();
    tokenImplementationAddress = await tokenImplementation.getAddress();
    console.log(`PumperToken (implementation): ${tokenImplementationAddress}`);

    // Take the nonce from the transaction we just sent, NOT from `getTransactionCount`.
    //
    // Public RPCs are load balanced: a `getTransactionCount("latest")` issued right after a
    // deploy can land on a node that hasn't seen that block yet and return a stale value. That
    // makes the CREATE-address prediction off by one, the migrator lands on the launchpad's
    // predicted address, and the launchpad's constructor rightly refuses to adopt it. Reading
    // the nonce off our own transaction removes the race entirely.
    lastNonce = tokenImplementation.deploymentTransaction()!.nonce;
  }

  // --- 2. predict the launchpad address ------------------------------------------------------
  const migratorNonce = lastNonce + 1;
  let launchpadNonce = migratorNonce + 1;
  let predictedLaunchpad = ethers.getCreateAddress({
    from: deployer.address,
    nonce: launchpadNonce,
  });

  // Reusing a migrator inverts the problem. Its `launchpad` immutable is already fixed, so the
  // launchpad has to land on *that* address rather than on whatever the nonce arithmetic above
  // predicts — and that arithmetic assumed this run deployed the migrator itself, which it did
  // not. Take the migrator's own word for the target, and derive the nonce that reaches it.
  // Without this a resumed run aims one nonce too high and dies in the launchpad constructor
  // with `MigratorMismatch`, after paying for the deployment.
  if (process.env.MIGRATOR_ADDRESS) {
    const boundLaunchpad = await (
      await ethers.getContractAt("UniswapV2Migrator", process.env.MIGRATOR_ADDRESS)
    ).launchpad();
    const nextNonce = await ethers.provider.getTransactionCount(deployer.address);
    const nextAddress = ethers.getCreateAddress({ from: deployer.address, nonce: nextNonce });

    if (nextAddress.toLowerCase() !== boundLaunchpad.toLowerCase()) {
      throw new Error(
        `Cannot resume: migrator ${process.env.MIGRATOR_ADDRESS} is bound to launchpad ` +
          `${boundLaunchpad}, but the deployer's next transaction (nonce ${nextNonce}) would ` +
          `create ${nextAddress}. The migrator's binding is immutable, so the launchpad can only ` +
          `be deployed from this account at nonce ` +
          `${nextNonce} — send no other transactions from it, or deploy a fresh migrator.`,
      );
    }
    launchpadNonce = nextNonce;
    predictedLaunchpad = boundLaunchpad;
  }

  console.log(`Predicted PumperFactory:      ${predictedLaunchpad} (nonce ${launchpadNonce})`);

  // --- 3. migrator ---------------------------------------------------------------------------
  let migratorAddress = process.env.MIGRATOR_ADDRESS ?? "";

  if (migratorAddress) {
    console.log(`UniswapV2Migrator:            ${migratorAddress} (reused)`);
  } else {
    const migrator = await (
      await ethers.getContractFactory("UniswapV2Migrator")
    ).deploy(predictedLaunchpad, uniswapV2Router, uniswapV2Factory, weth, {
      // Pin the nonce instead of letting ethers query it. The whole address-prediction scheme
      // rests on these two landing on consecutive nonces, and a load-balanced public RPC can
      // answer `getTransactionCount` from a node that has not seen the previous deploy yet —
      // which resends the *previous* nonce and fails as "replacement transaction underpriced".
      nonce: migratorNonce,
    });
    await migrator.waitForDeployment();
    migratorAddress = await migrator.getAddress();
    console.log(`UniswapV2Migrator:            ${migratorAddress} (nonce ${migratorNonce})`);
  }

  // Catch any remaining drift here, where it costs one failed script run, rather than in the
  // launchpad constructor after another deploy has been paid for.
  const expectedMigrator = ethers.getCreateAddress({
    from: deployer.address,
    nonce: migratorNonce,
  });
  if (!process.env.MIGRATOR_ADDRESS && migratorAddress !== expectedMigrator) {
    throw new Error(
      `Nonce drift: migrator landed at ${migratorAddress}, expected ${expectedMigrator}. ` +
        `Re-run with TOKEN_IMPLEMENTATION_ADDRESS=${tokenImplementationAddress} to reuse what ` +
        `is already deployed.`,
    );
  }

  // The launchpad's constructor *calls* the migrator (`migrator.launchpad()`), so the migrator
  // must be visible to whichever node estimates gas for that deployment. On a load-balanced
  // public RPC it often is not yet, and the estimate reverts — with no revert reason, which
  // looks alarmingly like a genuine wiring failure. Wait for the code first.
  await waitForCode(migratorAddress, "UniswapV2Migrator");

  // --- 4. launchpad --------------------------------------------------------------------------
  let factoryAddress = process.env.FACTORY_ADDRESS ?? "";

  if (factoryAddress) {
    console.log(`PumperFactory:                ${factoryAddress} (reused)`);
  } else {
    const deployed = await (
      await ethers.getContractFactory("PumperFactory")
    ).deploy(tokenImplementationAddress, migratorAddress, feeRecipient, owner, {
      nonce: launchpadNonce,
    });
    await deployed.waitForDeployment();
    factoryAddress = await deployed.getAddress();
    console.log(`PumperFactory:                ${factoryAddress}`);
  }

  // Every subsequent read goes through the RPC, so make sure it can actually see the code first.
  await waitForCode(factoryAddress, "PumperFactory");
  await waitForCode(migratorAddress, "UniswapV2Migrator");

  const factory = await ethers.getContractAt("PumperFactory", factoryAddress);
  const migratorContract = await ethers.getContractAt("UniswapV2Migrator", migratorAddress);

  if (!process.env.FACTORY_ADDRESS && factoryAddress !== predictedLaunchpad) {
    throw new Error(`Address prediction failed: expected ${predictedLaunchpad}, got ${factoryAddress}`);
  }

  // --- 5. post-deploy verification ----------------------------------------------------------
  console.log("\nVerifying wiring and constants...");
  const checks: Array<[string, unknown, unknown]> = [
    ["migrator.launchpad", await migratorContract.launchpad(), factoryAddress],
    ["factory.migrator", await factory.migrator(), migratorAddress],
    ["factory.tokenImplementation", await factory.tokenImplementation(), tokenImplementationAddress],
    ["factory.feeRecipient", await factory.feeRecipient(), feeRecipient],
    ["factory.owner", await factory.owner(), owner],
    ["factory.TOTAL_SUPPLY", await factory.TOTAL_SUPPLY(), 1_000_000_000n * 10n ** 18n],
    ["factory.VIRTUAL_ETH_RESERVE", await factory.VIRTUAL_ETH_RESERVE(), ethers.parseEther("0.5")],
    ["factory.MIGRATION_THRESHOLD", await factory.MIGRATION_THRESHOLD(), ethers.parseEther("5")],
    ["factory.BUY_FEE_BPS", await factory.BUY_FEE_BPS(), 20n],
    ["factory.SELL_FEE_BPS", await factory.SELL_FEE_BPS(), 30n],
    ["migrator.uniswapV2Router", await migratorContract.uniswapV2Router(), uniswapV2Router],
    ["migrator.uniswapV2Factory", await migratorContract.uniswapV2Factory(), uniswapV2Factory],
    ["migrator.weth", await migratorContract.weth(), weth],
  ];

  for (const [label, actual, expected] of checks) {
    const ok = String(actual).toLowerCase() === String(expected).toLowerCase();
    console.log(`  ${ok ? "OK " : "FAIL"} ${label} = ${actual}`);
    if (!ok) throw new Error(`Post-deploy check failed: ${label} (expected ${expected})`);
  }

  // --- 6. persist ----------------------------------------------------------------------------
  console.log("\nLocating the factory's creation block...");
  const deploymentBlock = await findDeploymentBlock(factoryAddress);
  console.log(`  block ${deploymentBlock}`);
  const record = {
    network: networkName,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    deploymentBlock,
    deployer: deployer.address,
    contracts: {
      PumperFactory: factoryAddress,
      UniswapV2Migrator: migratorAddress,
      PumperTokenImplementation: tokenImplementationAddress,
    },
    external: {
      uniswapV2Router,
      uniswapV2Factory,
      weth,
      uniswapV2FactoryIsOurs,
    },
    config: { feeRecipient, owner },
    constants: {
      totalSupply: (1_000_000_000n * 10n ** 18n).toString(),
      virtualEthReserve: ethers.parseEther("0.5").toString(),
      migrationThreshold: ethers.parseEther("5").toString(),
      buyFeeBps: 20,
      sellFeeBps: 30,
    },
  };

  const outputDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${networkName}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nDeployment written to ${outputPath}`);

  exportAbis();

  console.log("\nNext steps:");
  console.log(`  1. Index from block ${deploymentBlock} (set START_BLOCK in indexer/.env)`);
  console.log(`  2. npm run verify:${networkName}`);
  console.log(`  3. Point the frontend at VITE_FACTORY_ADDRESS=${factoryAddress}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
