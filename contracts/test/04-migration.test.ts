import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import {
  deployFixture,
  createToken,
  buyToThreshold,
  assertEthAccounting,
  TOTAL_SUPPLY,
  MIGRATION_THRESHOLD,
  BURN_ADDRESS,
  MAX_DEADLINE,
  PRICE_UNIT,
} from "./helpers";

/**
 * Canonical migration state after a single buy that crosses the threshold.
 * Derived in docs/ECONOMICS.md §6; hardcoded here so any change to the curve constants or the
 * rounding policy fails loudly instead of silently shifting the graduation economics.
 */
const EXPECTED_TOKEN_RESERVE = 90_909_090_909_090_909_090_909_091n;
const EXPECTED_TOKENS_TO_POOL = 82_644_628_099_173_553_719_008_264n;
const EXPECTED_TOKENS_TO_BURN = 8_264_462_809_917_355_371_900_827n;
const MINIMUM_LIQUIDITY = 1_000n;

describe("Migration to Uniswap V2", () => {
  it("reaches the threshold with exactly 5 ETH and the documented reserves", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address } = await createToken(factory, alice);

    await expect(buyToThreshold(factory, bob, address))
      .to.emit(factory, "MigrationTriggered")
      .withArgs(address, MIGRATION_THRESHOLD, EXPECTED_TOKEN_RESERVE, (ts: bigint) => ts > 0n);

    const view = await factory.getToken(address);
    expect(view.status).to.equal(2n); // PendingMigration
    expect(view.ethReserve).to.equal(MIGRATION_THRESHOLD);
    expect(view.virtualEthReserve).to.equal(ethers.parseEther("5.5"));
    expect(view.tokenReserve).to.equal(EXPECTED_TOKEN_RESERVE);
    expect(view.migrationProgressBps).to.equal(10_000n);
    expect(view.tokenPrice).to.be.closeTo(60_500_000_000n, 10n); // 6.05e10 wei/token
    expect(view.fullyDilutedValuation).to.be.closeTo(ethers.parseEther("60.5"), 10n ** 10n);
  });

  it("previews the exact split before migrating", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address } = await createToken(factory, alice);
    await buyToThreshold(factory, bob, address);

    const preview = await factory.previewMigration(address);
    expect(preview.ethToPool).to.equal(MIGRATION_THRESHOLD);
    expect(preview.tokensToPool).to.equal(EXPECTED_TOKENS_TO_POOL);
    expect(preview.tokensToBurn).to.equal(EXPECTED_TOKENS_TO_BURN);
    expect(preview.tokensToPool + preview.tokensToBurn).to.equal(EXPECTED_TOKEN_RESERVE);

    // The burn is exactly the share backed by virtual rather than real ETH: Ev0/E = 1/11.
    expect(preview.tokensToBurn).to.be.closeTo(EXPECTED_TOKEN_RESERVE / 11n, 1n);
  });

  it("migrates: seeds the pair, burns the LP, and marks the token migrated", async () => {
    const { factory, migrator, weth, uniswapFactory, alice, bob, carol } =
      await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice);
    await buyToThreshold(factory, bob, address);

    const preview = await factory.previewMigration(address);
    const priceBefore = (await factory.getToken(address)).tokenPrice;

    // Permissionless: carol, an unrelated account, finalises it.
    const receipt = await (await factory.connect(carol).migrate(address)).wait();

    const pair = await uniswapFactory.getPair(address, await weth.getAddress());
    expect(pair).to.not.equal(ethers.ZeroAddress);

    const migrated = receipt!.logs
      .map((log) => {
        try {
          return factory.interface.parseLog(log as any);
        } catch {
          return null;
        }
      })
      .find((p) => p?.name === "LiquidityMigrated")!;

    expect(migrated.args.token).to.equal(address);
    expect(migrated.args.pair).to.equal(pair);
    expect(migrated.args.ethAmount).to.equal(MIGRATION_THRESHOLD);
    expect(migrated.args.tokenAmount).to.equal(EXPECTED_TOKENS_TO_POOL);
    expect(migrated.args.tokensBurned).to.equal(EXPECTED_TOKENS_TO_BURN);
    expect(migrated.args.lpTokensBurned).to.be.gt(0n);

    // --- pool state ---
    const pairContract = await ethers.getContractAt("UniswapV2Pair", pair);
    const [reserve0, reserve1] = await pairContract.getReserves();
    const token0 = await pairContract.token0();
    const [reserveToken, reserveWeth] =
      token0.toLowerCase() === address.toLowerCase()
        ? [reserve0, reserve1]
        : [reserve1, reserve0];

    expect(reserveWeth).to.equal(MIGRATION_THRESHOLD);
    expect(reserveToken).to.equal(EXPECTED_TOKENS_TO_POOL);

    // --- the pool opens at exactly the final curve price (ECONOMICS §6.2) ---
    const openingPrice = (reserveWeth * PRICE_UNIT) / reserveToken;
    expect(openingPrice).to.be.closeTo(priceBefore, 1n);
    expect(openingPrice).to.equal(preview.openingPrice);

    // --- the LP burn is permanent and verifiable ---
    const lpBurned = migrated.args.lpTokensBurned;
    expect(await pairContract.balanceOf(BURN_ADDRESS)).to.equal(lpBurned);
    expect(await pairContract.balanceOf(await migrator.getAddress())).to.equal(0n);
    expect(await pairContract.balanceOf(await factory.getAddress())).to.equal(0n);
    // Every LP token that exists is either burned to dEaD or locked as MINIMUM_LIQUIDITY.
    expect(await pairContract.totalSupply()).to.equal(lpBurned + MINIMUM_LIQUIDITY);

    // --- token accounting closes exactly ---
    expect(await token.balanceOf(BURN_ADDRESS)).to.equal(EXPECTED_TOKENS_TO_BURN);
    expect(await token.balanceOf(await factory.getAddress())).to.equal(0n);
    expect(await token.balanceOf(await migrator.getAddress())).to.equal(0n);
    expect(
      (await token.balanceOf(pair)) +
        (await token.balanceOf(BURN_ADDRESS)) +
        (await token.balanceOf(bob.address)),
    ).to.equal(TOTAL_SUPPLY);

    // --- launchpad state ---
    const view = await factory.getToken(address);
    expect(view.status).to.equal(3n); // Migrated
    expect(view.pair).to.equal(pair);
    expect(view.ethReserve).to.equal(0n);
    expect(view.tokenReserve).to.equal(0n);
    expect(view.migratedAt).to.be.gt(0n);
    expect(view.circulatingSupply).to.equal(TOTAL_SUPPLY - EXPECTED_TOKENS_TO_BURN);

    // Only fees remain in the launchpad.
    expect(await ethers.provider.getBalance(await factory.getAddress())).to.equal(
      await factory.accruedFees(),
    );
    expect(await ethers.provider.getBalance(await migrator.getAddress())).to.equal(0n);
    await assertEthAccounting(factory);
  });

  it("makes the token tradable on Uniswap immediately after migration", async () => {
    const { factory, weth, uniswapFactory, alice, bob, carol } = await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice);
    await buyToThreshold(factory, bob, address);
    await factory.migrate(address);

    const pair = await uniswapFactory.getPair(address, await weth.getAddress());
    const pairContract = await ethers.getContractAt("UniswapV2Pair", pair);

    // Swap 0.1 ETH worth of WETH into the pair by hand (no router needed).
    const amountIn = ethers.parseEther("0.1");
    await weth.connect(carol).deposit({ value: amountIn });
    await weth.connect(carol).transfer(pair, amountIn);

    const [reserve0, reserve1] = await pairContract.getReserves();
    const token0 = await pairContract.token0();
    const [reserveToken, reserveWeth] =
      token0.toLowerCase() === address.toLowerCase()
        ? [reserve0, reserve1]
        : [reserve1, reserve0];

    const amountInWithFee = amountIn * 997n;
    const amountOut =
      (amountInWithFee * reserveToken) / (reserveWeth * 1000n + amountInWithFee);

    const [out0, out1] =
      token0.toLowerCase() === address.toLowerCase() ? [amountOut, 0n] : [0n, amountOut];
    await pairContract.connect(carol).swap(out0, out1, carol.address, "0x");

    expect(await token.balanceOf(carol.address)).to.equal(amountOut);
    expect(amountOut).to.be.gt(0n);
  });

  it("refuses to migrate twice", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address } = await createToken(factory, alice);
    await buyToThreshold(factory, bob, address);

    await factory.migrate(address);

    await expect(factory.migrate(address)).to.be.revertedWithCustomError(
      factory,
      "MigrationNotReady",
    );
  });

  it("refuses to migrate before the threshold", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address } = await createToken(factory, alice);

    await expect(factory.migrate(address)).to.be.revertedWithCustomError(
      factory,
      "MigrationNotReady",
    );

    await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("4.9") });
    await expect(factory.migrate(address)).to.be.revertedWithCustomError(
      factory,
      "MigrationNotReady",
    );
  });

  it("permanently disables curve trading after migration", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice);
    await buyToThreshold(factory, bob, address);
    await factory.migrate(address);

    await expect(
      factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("1") }),
    ).to.be.revertedWithCustomError(factory, "NotTrading");

    const balance = await token.balanceOf(bob.address);
    await token.connect(bob).approve(await factory.getAddress(), balance);
    await expect(
      factory.connect(bob).sell(address, balance, 0, MAX_DEADLINE),
    ).to.be.revertedWithCustomError(factory, "NotTrading");
  });

  it("reaches the same end state when the threshold is crossed by many small buys", async () => {
    const { factory, alice, bob, carol } = await loadFixture(deployFixture);
    const { address } = await createToken(factory, alice);

    // Keep buying until the pinning logic halts trading; the final buy is partially filled.
    for (let i = 0; i < 20; i++) {
      if ((await factory.getTokenData(address)).status !== 1n) break;
      const buyer = i % 2 === 0 ? bob : carol;
      await factory.connect(buyer).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("0.6") });
    }

    const view = await factory.getToken(address);
    expect(view.status).to.equal(2n);
    expect(view.ethReserve).to.equal(MIGRATION_THRESHOLD);
    // Per-trade flooring leaves the curve marginally richer than the ideal reserve.
    expect(view.tokenReserve).to.be.gte(await factory.TOKEN_RESERVE_AT_MIGRATION());
    expect(view.tokenReserve - (await factory.TOKEN_RESERVE_AT_MIGRATION())).to.be.lt(10n ** 12n);

    await factory.migrate(address);
    expect((await factory.getToken(address)).status).to.equal(3n);
    await assertEthAccounting(factory);
  });

  it("still migrates safely when the threshold is crossed after heavy sell pressure", async () => {
    const { factory, alice, bob, carol } = await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice);

    await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("3") });
    const balance = await token.balanceOf(bob.address);
    await token.connect(bob).approve(await factory.getAddress(), balance);
    await factory.connect(bob).sell(address, balance / 2n, 0, MAX_DEADLINE);

    await factory.connect(carol).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("8") });

    const view = await factory.getToken(address);
    expect(view.ethReserve).to.equal(MIGRATION_THRESHOLD);

    await factory.migrate(address);
    await assertEthAccounting(factory);
    expect((await factory.getToken(address)).status).to.equal(3n);
  });

  it("cannot be robbed by pre-seeding the Uniswap pair", async () => {
    const { factory, migrator, weth, uniswapFactory, alice, bob, carol } =
      await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice);

    // The attacker buys early so they hold tokens to seed a pair with.
    await factory.connect(carol).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("0.5") });
    await buyToThreshold(factory, bob, address);

    // Front-run migration: create the pair and seed it at an absurd ratio.
    await uniswapFactory.createPair(address, await weth.getAddress());
    const pair = await uniswapFactory.getPair(address, await weth.getAddress());
    const pairContract = await ethers.getContractAt("UniswapV2Pair", pair);

    await token.connect(carol).transfer(pair, ethers.parseUnits("1000", 18));
    await weth.connect(carol).deposit({ value: ethers.parseEther("0.001") });
    await weth.connect(carol).transfer(pair, ethers.parseEther("0.001"));
    await pairContract.connect(carol).mint(carol.address);

    const attackerLp = await pairContract.balanceOf(carol.address);
    expect(attackerLp).to.be.gt(0n);

    // Migration still succeeds.
    await factory.migrate(address);

    const view = await factory.getToken(address);
    expect(view.status).to.equal(3n);
    expect(view.pair).to.equal(pair);

    // The attacker is diluted to a negligible share rather than capturing protocol assets.
    const totalLp = await pairContract.totalSupply();
    expect((attackerLp * 10_000n) / totalLp).to.be.lt(100n); // < 1 %

    // Nothing is stranded: the migrator holds no residue, and every asset was deposited,
    // burned, or returned to the launchpad's fee ledger.
    expect(await token.balanceOf(await migrator.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(await migrator.getAddress())).to.equal(0n);
    expect(await token.balanceOf(await factory.getAddress())).to.equal(0n);
    await assertEthAccounting(factory);
  });

  it("rejects migrator calls from anyone but the launchpad", async () => {
    const { factory, migrator, alice, bob } = await loadFixture(deployFixture);
    const { address } = await createToken(factory, alice);
    await buyToThreshold(factory, bob, address);

    await expect(
      migrator.connect(bob).migrate(address, 1n, { value: ethers.parseEther("1") }),
    ).to.be.revertedWithCustomError(migrator, "OnlyLaunchpad");
  });

  it("binds the migrator and launchpad to each other at deploy time", async () => {
    const { tokenImplementation, weth, uniswapFactory, deployer, feeRecipient } =
      await loadFixture(deployFixture);

    // A migrator pointed at the wrong launchpad cannot be adopted.
    const strayMigrator = await (
      await ethers.getContractFactory("UniswapV2Migrator")
    ).deploy(feeRecipient.address, await uniswapFactory.getAddress(), await weth.getAddress());

    const PumperFactory = await ethers.getContractFactory("PumperFactory");
    await expect(
      PumperFactory.deploy(
        await tokenImplementation.getAddress(),
        await strayMigrator.getAddress(),
        feeRecipient.address,
        deployer.address,
      ),
    ).to.be.revertedWithCustomError(PumperFactory, "MigratorMismatch");
  });
});
