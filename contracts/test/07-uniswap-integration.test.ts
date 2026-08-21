import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import {
  deployFixture,
  createToken,
  buyToThreshold,
  assertEthAccounting,
  BURN_ADDRESS,
  MAX_DEADLINE,
  PRICE_UNIT,
} from "./helpers";

/**
 * Uniswap V2 integration: the router/factory wiring, the allowance hygiene around
 * `addLiquidityETH`, and the pair states a third party can force the migrator into before it
 * ever runs.
 *
 * The final block is a Base *mainnet fork* test. It is the only place the genuine
 * UniswapV2Router02 is exercised — locally the router is a transcribed stand-in, because
 * Router02 resolves pairs through a hard-coded init-code hash that does not match a pair
 * compiled by this repo. It runs only when a Base mainnet RPC is configured.
 */

/** Canonical Uniswap V2 on Base mainnet, verified live against chain 8453. */
const BASE_MAINNET = {
  router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
  factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
  weth: "0x4200000000000000000000000000000000000006",
};

describe("Uniswap V2 integration", () => {
  describe("wiring", () => {
    it("records the router, factory and WETH it was constructed with", async () => {
      const { migrator, uniswapRouter, uniswapFactory, weth } = await loadFixture(deployFixture);

      expect(await migrator.uniswapV2Router()).to.equal(await uniswapRouter.getAddress());
      expect(await migrator.uniswapV2Factory()).to.equal(await uniswapFactory.getAddress());
      expect(await migrator.weth()).to.equal(await weth.getAddress());
    });

    it("refuses a router that reports a different factory", async () => {
      const { factory, uniswapRouter, weth } = await loadFixture(deployFixture);

      // A second, unrelated V2 factory: the router still points at the first one.
      const otherFactory = await (
        await ethers.getContractFactory("UniswapV2Factory")
      ).deploy(ethers.ZeroAddress);

      const Migrator = await ethers.getContractFactory("UniswapV2Migrator");
      await expect(
        Migrator.deploy(
          await factory.getAddress(),
          await uniswapRouter.getAddress(),
          await otherFactory.getAddress(),
          await weth.getAddress(),
        ),
      ).to.be.revertedWithCustomError(Migrator, "RouterFactoryMismatch");
    });

    it("refuses a router that reports a different WETH", async () => {
      const { factory, uniswapRouter, uniswapFactory } = await loadFixture(deployFixture);

      const otherWeth = await (await ethers.getContractFactory("MockWETH")).deploy();

      const Migrator = await ethers.getContractFactory("UniswapV2Migrator");
      await expect(
        Migrator.deploy(
          await factory.getAddress(),
          await uniswapRouter.getAddress(),
          await uniswapFactory.getAddress(),
          await otherWeth.getAddress(),
        ),
      ).to.be.revertedWithCustomError(Migrator, "RouterWethMismatch");
    });

    it("rejects a zero address in any constructor slot", async () => {
      const { factory, uniswapRouter, uniswapFactory, weth } = await loadFixture(deployFixture);
      const Migrator = await ethers.getContractFactory("UniswapV2Migrator");

      const args = [
        await factory.getAddress(),
        await uniswapRouter.getAddress(),
        await uniswapFactory.getAddress(),
        await weth.getAddress(),
      ];

      for (let i = 0; i < args.length; i++) {
        const mutated = [...args];
        mutated[i] = ethers.ZeroAddress;
        await expect(Migrator.deploy(...(mutated as [string, string, string, string])))
          .to.be.revertedWithCustomError(Migrator, "ZeroAddress");
      }
    });
  });

  describe("liquidity add through the router", () => {
    it("approves the router for the add and clears the allowance afterwards", async () => {
      const { factory, migrator, uniswapRouter, alice, bob } = await loadFixture(deployFixture);
      const { address, token } = await createToken(factory, alice);
      await buyToThreshold(factory, bob, address);

      const receipt = await (await factory.migrate(address)).wait();

      // The approval is the fingerprint of the router path: a direct pair mint needs none.
      const approvals = receipt!.logs
        .map((log) => {
          try {
            return token.interface.parseLog(log as any);
          } catch {
            return null;
          }
        })
        .filter((p) => p?.name === "Approval");

      expect(approvals.length).to.be.gte(1);
      expect(approvals[0]!.args.owner).to.equal(await migrator.getAddress());
      expect(approvals[0]!.args.spender).to.equal(await uniswapRouter.getAddress());

      // Nothing is left standing once the call returns.
      expect(
        await token.allowance(await migrator.getAddress(), await uniswapRouter.getAddress()),
      ).to.equal(0n);
    });

    it("leaves no token, LP or ETH residue in the migrator", async () => {
      const { factory, migrator, uniswapFactory, weth, alice, bob } =
        await loadFixture(deployFixture);
      const { address, token } = await createToken(factory, alice);
      await buyToThreshold(factory, bob, address);
      await factory.migrate(address);

      const pair = await uniswapFactory.getPair(address, await weth.getAddress());
      const pairContract = await ethers.getContractAt("UniswapV2Pair", pair);
      const migratorAddress = await migrator.getAddress();

      expect(await token.balanceOf(migratorAddress)).to.equal(0n);
      expect(await pairContract.balanceOf(migratorAddress)).to.equal(0n);
      expect(await weth.balanceOf(migratorAddress)).to.equal(0n);
      expect(await ethers.provider.getBalance(migratorAddress)).to.equal(0n);
      await assertEthAccounting(factory);
    });
  });

  describe("hostile pair states", () => {
    /**
     * The cheap denial of service the router alone would be vulnerable to: transferring dust to
     * a fresh pair and calling `sync()` leaves one reserve non-zero and the other at zero, a
     * state `UniswapV2Library.quote` rejects outright. Routing through the router unconditionally
     * would strand the curve's 5 ETH permanently for the price of one wei.
     */
    it("still migrates when the pair is griefed into a one-sided token reserve", async () => {
      const { factory, migrator, uniswapFactory, weth, alice, bob, carol } =
        await loadFixture(deployFixture);
      const { address, token } = await createToken(factory, alice);

      await factory.connect(carol).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("0.1") });
      await buyToThreshold(factory, bob, address);

      const pairAddress = await uniswapFactory.createPair.staticCall(address, await weth.getAddress());
      await uniswapFactory.createPair(address, await weth.getAddress());
      const pairContract = await ethers.getContractAt("UniswapV2Pair", pairAddress);

      // One wei of token, then sync: reserves become (dust, 0).
      await token.connect(carol).transfer(pairAddress, 1n);
      await pairContract.sync();
      const [r0, r1] = await pairContract.getReserves();
      expect(r0 === 0n || r1 === 0n).to.equal(true);
      expect(r0 + r1).to.be.gt(0n);

      const preview = await factory.previewMigration(address);
      const priceBefore = (await factory.getToken(address)).tokenPrice;

      await expect(factory.migrate(address)).to.emit(factory, "LiquidityMigrated");

      const view = await factory.getToken(address);
      expect(view.status).to.equal(3n);
      expect(view.pair).to.equal(pairAddress);

      // The full intended liquidity landed, and the dust was simply absorbed.
      const [a0, a1] = await pairContract.getReserves();
      const token0 = await pairContract.token0();
      const [reserveToken, reserveWeth] =
        token0.toLowerCase() === address.toLowerCase() ? [a0, a1] : [a1, a0];
      expect(reserveWeth).to.equal(preview.ethToPool);
      expect(reserveToken).to.equal(preview.tokensToPool + 1n);

      // The opening price is still the curve's final price.
      const openingPrice = (reserveWeth * PRICE_UNIT) / reserveToken;
      expect(openingPrice).to.be.closeTo(priceBefore, 10n);

      // The griefer gets nothing: they never minted, and every LP token is burned or locked.
      expect(await pairContract.balanceOf(carol.address)).to.equal(0n);
      expect(await pairContract.balanceOf(await migrator.getAddress())).to.equal(0n);
      expect(await pairContract.balanceOf(BURN_ADDRESS)).to.be.gt(0n);
      await assertEthAccounting(factory);
    });

    it("still migrates when the pair is griefed into a one-sided WETH reserve", async () => {
      const { factory, uniswapFactory, weth, alice, bob, carol } = await loadFixture(deployFixture);
      const { address } = await createToken(factory, alice);
      await buyToThreshold(factory, bob, address);

      const pairAddress = await uniswapFactory.createPair.staticCall(address, await weth.getAddress());
      await uniswapFactory.createPair(address, await weth.getAddress());
      const pairContract = await ethers.getContractAt("UniswapV2Pair", pairAddress);

      await weth.connect(carol).deposit({ value: 1n });
      await weth.connect(carol).transfer(pairAddress, 1n);
      await pairContract.sync();

      const preview = await factory.previewMigration(address);
      await expect(factory.migrate(address)).to.emit(factory, "LiquidityMigrated");

      const [a0, a1] = await pairContract.getReserves();
      const token0 = await pairContract.token0();
      const [reserveToken, reserveWeth] =
        token0.toLowerCase() === address.toLowerCase() ? [a0, a1] : [a1, a0];
      expect(reserveToken).to.equal(preview.tokensToPool);
      expect(reserveWeth).to.equal(preview.ethToPool + 1n);
      expect(await pairContract.balanceOf(carol.address)).to.equal(0n);
      await assertEthAccounting(factory);
    });

    /**
     * The migrator checks the LP it received as a *delta*. Checking the absolute balance would
     * mean one wei of LP, transferred to the migrator by anyone, blocks the migration forever.
     */
    it("still migrates when LP tokens are donated to the migrator beforehand", async () => {
      const { factory, migrator, uniswapFactory, weth, alice, bob, carol } =
        await loadFixture(deployFixture);
      const { address, token } = await createToken(factory, alice);

      await factory.connect(carol).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("0.2") });
      await buyToThreshold(factory, bob, address);

      // Carol seeds a pair at a sane ratio, then hands a slice of her LP to the migrator.
      const pairAddress = await uniswapFactory.createPair.staticCall(address, await weth.getAddress());
      await uniswapFactory.createPair(address, await weth.getAddress());
      const pairContract = await ethers.getContractAt("UniswapV2Pair", pairAddress);

      const preview = await factory.previewMigration(address);
      await token.connect(carol).transfer(pairAddress, preview.tokensToPool / 1000n);
      await weth.connect(carol).deposit({ value: preview.ethToPool / 1000n });
      await weth.connect(carol).transfer(pairAddress, preview.ethToPool / 1000n);
      await pairContract.connect(carol).mint(carol.address);

      const donated = (await pairContract.balanceOf(carol.address)) / 2n;
      expect(donated).to.be.gt(0n);
      await pairContract.connect(carol).transfer(await migrator.getAddress(), donated);

      await expect(factory.migrate(address)).to.emit(factory, "LiquidityMigrated");

      expect((await factory.getToken(address)).status).to.equal(3n);
      // The donation is burned along with the minted LP, so nothing is left behind.
      expect(await pairContract.balanceOf(await migrator.getAddress())).to.equal(0n);
      expect(await pairContract.balanceOf(BURN_ADDRESS)).to.be.gt(donated);
      await assertEthAccounting(factory);
    });

    it("burns tokens donated to the migrator instead of stranding them", async () => {
      const { factory, migrator, alice, bob, carol } = await loadFixture(deployFixture);
      const { address, token } = await createToken(factory, alice);

      await factory.connect(carol).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("0.1") });
      await buyToThreshold(factory, bob, address);

      const donated = ethers.parseUnits("1234", 18);
      await token.connect(carol).transfer(await migrator.getAddress(), donated);

      const burnedBefore = await token.balanceOf(BURN_ADDRESS);
      await factory.migrate(address);

      expect(await token.balanceOf(await migrator.getAddress())).to.equal(0n);
      expect((await token.balanceOf(BURN_ADDRESS)) - burnedBefore).to.be.gte(donated);
      await assertEthAccounting(factory);
    });

    /**
     * Documents the one residual case, so a behaviour change here is loud rather than silent.
     *
     * A squatter who is willing to buy and then abandon more tokens than the pool deposit itself
     * can seed a ratio so lopsided that the matching ETH side rounds to zero. Matching that ratio
     * is impossible and ignoring it would donate the pool to the squatter, so migration reverts —
     * the curve's ETH stays put and the migration can be retried if the pool ratio ever moves.
     */
    it("reverts with PairRatioUnusable — not an arithmetic panic — on an unmatched ratio", async () => {
      const { factory, uniswapFactory, weth, alice, bob, carol } = await loadFixture(deployFixture);
      const { address, token } = await createToken(factory, alice);

      // Carol buys a large float so she can out-seed the pool deposit.
      await factory.connect(carol).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("1") });
      await buyToThreshold(factory, bob, address);

      const preview = await factory.previewMigration(address);
      const seedTokens = preview.tokensToPool * 2n;
      expect(await token.balanceOf(carol.address)).to.be.gte(seedTokens);

      const pairAddress = await uniswapFactory.createPair.staticCall(address, await weth.getAddress());
      await uniswapFactory.createPair(address, await weth.getAddress());
      const pairContract = await ethers.getContractAt("UniswapV2Pair", pairAddress);

      await token.connect(carol).transfer(pairAddress, seedTokens);
      await weth.connect(carol).deposit({ value: 1n });
      await weth.connect(carol).transfer(pairAddress, 1n);
      await pairContract.connect(carol).mint(carol.address);

      const migratorAddress = await factory.migrator();
      const migrator = await ethers.getContractAt("UniswapV2Migrator", migratorAddress);
      await expect(factory.migrate(address)).to.be.revertedWithCustomError(
        migrator,
        "PairRatioUnusable",
      );

      // Nothing moved: the token is still finalisable later.
      expect((await factory.getToken(address)).status).to.equal(2n);
      await assertEthAccounting(factory);
    });
  });

  /**
   * The genuine article: the canonical UniswapV2Router02 and UniswapV2Factory on Base mainnet,
   * driven against a fork of live chain state. This is what proves the router's hard-coded
   * init-code hash agrees with the factory registry — the assumption `PairMismatch` guards.
   */
  describe("Base mainnet fork", function () {
    const rpc = process.env.BASE_RPC_URL ?? process.env.BASE_MAINNET_RPC_URL;
    const forkable = Boolean(rpc);

    before(async function () {
      if (!forkable) {
        console.log("      (skipped: set BASE_RPC_URL to run the mainnet fork test)");
        this.skip();
      }
      this.timeout(180_000);
      await network.provider.request({
        method: "hardhat_reset",
        params: [{ forking: { jsonRpcUrl: rpc } }],
      });
      // Mine one local block so calls land above the fork point. Executing *at* the fork block
      // is a historical execution, and hardhat refuses those without a hardfork activation
      // history for the forked chain.
      await network.provider.send("evm_mine");
    });

    after(async () => {
      // Drop the fork so later files run against a clean in-memory chain.
      await network.provider.request({ method: "hardhat_reset", params: [] });
    });

    it("migrates into the real Uniswap V2 pool and burns the LP", async function () {
      this.timeout(180_000);
      const [deployer, alice, bob] = await ethers.getSigners();

      // Sanity-check the fork really carries Base mainnet state. (chainId is not the tell:
      // hardhat.config pins the in-process network to 31337 even while forking.)
      for (const [label, address] of Object.entries(BASE_MAINNET)) {
        expect(await ethers.provider.getCode(address), `${label} has no code on the fork`).to.not.equal(
          "0x",
        );
      }
      const router = await ethers.getContractAt("IUniswapV2Router02", BASE_MAINNET.router);
      expect((await router.factory()).toLowerCase()).to.equal(BASE_MAINNET.factory.toLowerCase());
      expect((await router.WETH()).toLowerCase()).to.equal(BASE_MAINNET.weth.toLowerCase());

      // --- deploy the stack exactly as scripts/deploy.ts does ---
      const tokenImplementation = await (await ethers.getContractFactory("PumperToken")).deploy();
      await tokenImplementation.waitForDeployment();

      const nonce = await ethers.provider.getTransactionCount(deployer.address);
      const predictedLaunchpad = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });

      const migrator = await (
        await ethers.getContractFactory("UniswapV2Migrator")
      ).deploy(predictedLaunchpad, BASE_MAINNET.router, BASE_MAINNET.factory, BASE_MAINNET.weth);
      await migrator.waitForDeployment();

      const factory = await (
        await ethers.getContractFactory("PumperFactory")
      ).deploy(
        await tokenImplementation.getAddress(),
        await migrator.getAddress(),
        deployer.address,
        deployer.address,
      );
      await factory.waitForDeployment();
      expect(await factory.getAddress()).to.equal(predictedLaunchpad);

      // --- launch, graduate, migrate ---
      const { address, token } = await createToken(factory, alice, "Fork Token", "FORK");
      await buyToThreshold(factory, bob, address);

      const preview = await factory.previewMigration(address);
      const priceBefore = (await factory.getToken(address)).tokenPrice;

      await factory.migrate(address);

      const uniFactory = await ethers.getContractAt("contracts/interfaces/IUniswapV2.sol:IUniswapV2Factory", BASE_MAINNET.factory);
      const pair = await uniFactory.getPair(address, BASE_MAINNET.weth);
      expect(pair).to.not.equal(ethers.ZeroAddress);
      expect((await factory.getToken(address)).pair).to.equal(pair);

      const pairContract = await ethers.getContractAt("contracts/interfaces/IUniswapV2.sol:IUniswapV2Pair", pair);
      const [r0, r1] = await pairContract.getReserves();
      const token0 = await pairContract.token0();
      const [reserveToken, reserveWeth] =
        token0.toLowerCase() === address.toLowerCase() ? [r0, r1] : [r1, r0];

      // The real pool opened with the exact amounts the launchpad computed, at the curve price.
      expect(reserveWeth).to.equal(preview.ethToPool);
      expect(reserveToken).to.equal(preview.tokensToPool);
      expect((BigInt(reserveWeth) * PRICE_UNIT) / BigInt(reserveToken)).to.be.closeTo(
        priceBefore,
        1n,
      );

      // LP is burned, and none is left with the migrator — the PairMismatch guard passing is
      // itself the proof that the router's init-code hash agrees with the factory registry.
      expect(await pairContract.balanceOf(await migrator.getAddress())).to.equal(0n);
      expect(await pairContract.balanceOf(BURN_ADDRESS)).to.be.gt(0n);
      expect(await token.balanceOf(await migrator.getAddress())).to.equal(0n);
      expect(await ethers.provider.getBalance(await migrator.getAddress())).to.equal(0n);
      expect(await token.balanceOf(BURN_ADDRESS)).to.equal(preview.tokensToBurn);
      await assertEthAccounting(factory);
    });
  });
});
