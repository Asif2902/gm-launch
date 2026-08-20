import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import {
  deployFixture,
  createToken,
  buyToThreshold,
  assertEthAccounting,
  MAX_DEADLINE,
} from "./helpers";

describe("Security", () => {
  describe("ETH handling", () => {
    it("rejects ETH sent directly to the launchpad", async () => {
      const { factory, alice } = await loadFixture(deployFixture);

      await expect(
        alice.sendTransaction({ to: await factory.getAddress(), value: ethers.parseEther("1") }),
      ).to.be.revertedWithCustomError(factory, "DirectEthNotAccepted");
    });

    it("rejects ETH sent directly to the migrator", async () => {
      const { migrator, alice } = await loadFixture(deployFixture);

      await expect(
        migrator.connect(alice).fallback!({ value: ethers.parseEther("1") }),
      ).to.be.reverted;

      await expect(
        alice.sendTransaction({ to: await migrator.getAddress(), value: ethers.parseEther("1") }),
      ).to.be.revertedWithCustomError(migrator, "DirectEthNotAccepted");
    });

    it("credits pending ETH when a push transfer reverts, and lets the payee pull it later", async () => {
      const { factory, alice } = await loadFixture(deployFixture);
      const { address, token } = await createToken(factory, alice);

      const receiver = await (
        await ethers.getContractFactory("RevertingReceiver")
      ).deploy(await factory.getAddress());
      const receiverAddress = await receiver.getAddress();

      await receiver.buy(address, 0, { value: ethers.parseEther("1") });
      const balance = await token.balanceOf(receiverAddress);

      const quote = await factory.quoteSell(address, balance);

      // The sell succeeds; the ETH is parked instead of being pushed.
      await expect(receiver.sell(address, balance))
        .to.emit(factory, "EthCredited")
        .withArgs(receiverAddress, quote.ethOut, (ts: bigint) => ts > 0n);

      expect(await factory.pendingEth(receiverAddress)).to.equal(quote.ethOut);
      await assertEthAccounting(factory, [receiverAddress]);

      // Once the receiver accepts ETH it can pull the balance out.
      await receiver.setAcceptEth(true);
      await expect(receiver.claim()).to.changeEtherBalance(receiver, quote.ethOut);
      expect(await factory.pendingEth(receiverAddress)).to.equal(0n);

      await expect(receiver.claim()).to.be.revertedWithCustomError(factory, "NothingToClaim");
    });

    it("survives a receiver that burns more gas than the push budget", async () => {
      const { factory, alice } = await loadFixture(deployFixture);
      const { address, token } = await createToken(factory, alice);

      const receiver = await (
        await ethers.getContractFactory("GasGuzzlingReceiver")
      ).deploy(await factory.getAddress());
      const receiverAddress = await receiver.getAddress();

      await receiver.buy(address, { value: ethers.parseEther("1") });
      const balance = await token.balanceOf(receiverAddress);

      // The trade must not revert; the ETH lands in pendingEth instead.
      await receiver.sell(address, balance);

      expect(await factory.pendingEth(receiverAddress)).to.be.gt(0n);
      await assertEthAccounting(factory, [receiverAddress]);
    });

    it("refunds the buy overshoot through the same safe path", async () => {
      const { factory, alice } = await loadFixture(deployFixture);
      const { address } = await createToken(factory, alice);

      const receiver = await (
        await ethers.getContractFactory("RevertingReceiver")
      ).deploy(await factory.getAddress());
      const receiverAddress = await receiver.getAddress();

      await receiver.buy(address, 0, { value: ethers.parseEther("6") });

      // The refund could not be pushed, so it is claimable.
      expect(await factory.pendingEth(receiverAddress)).to.be.gt(0n);
      expect((await factory.getTokenData(address)).ethReserve).to.equal(ethers.parseEther("5"));
      await assertEthAccounting(factory, [receiverAddress]);
    });
  });

  describe("Reentrancy", () => {
    it("blocks re-entering buy from a sell payout", async () => {
      const { factory, alice } = await loadFixture(deployFixture);
      const { address, token } = await createToken(factory, alice);

      const attacker = await (
        await ethers.getContractFactory("ReentrancyAttacker")
      ).deploy(await factory.getAddress());

      await attacker.buy(address, ethers.parseEther("1"), { value: ethers.parseEther("1") });
      const balance = await token.balanceOf(await attacker.getAddress());

      await attacker.arm(address, 1); // re-enter buy
      await attacker.sell(address, balance / 2n);

      expect(await attacker.reentered()).to.equal(true);
      expect(await attacker.reentryReverted()).to.equal(true);
      await assertEthAccounting(factory, [await attacker.getAddress()]);
    });

    it("blocks re-entering sell from a sell payout", async () => {
      const { factory, alice } = await loadFixture(deployFixture);
      const { address, token } = await createToken(factory, alice);

      const attacker = await (
        await ethers.getContractFactory("ReentrancyAttacker")
      ).deploy(await factory.getAddress());

      await attacker.buy(address, ethers.parseEther("1"), { value: ethers.parseEther("1") });
      const balance = await token.balanceOf(await attacker.getAddress());

      await attacker.arm(address, 2); // re-enter sell
      await attacker.sell(address, balance / 2n);

      expect(await attacker.reentered()).to.equal(true);
      expect(await attacker.reentryReverted()).to.equal(true);
    });

    it("blocks re-entering migrate from a buy refund", async () => {
      const { factory, alice } = await loadFixture(deployFixture);
      const { address } = await createToken(factory, alice);

      const attacker = await (
        await ethers.getContractFactory("ReentrancyAttacker")
      ).deploy(await factory.getAddress());

      await attacker.arm(address, 3); // re-enter migrate
      // Overshooting triggers both the migration and a refund into the attacker's receive().
      await attacker.buy(address, ethers.parseEther("6"), { value: ethers.parseEther("6") });

      expect(await attacker.reentered()).to.equal(true);
      expect(await attacker.reentryReverted()).to.equal(true);

      // The token is still in the pending state and migrates normally afterwards.
      expect((await factory.getToken(address)).status).to.equal(2n);
      await factory.migrate(address);
      expect((await factory.getToken(address)).status).to.equal(3n);
    });
  });

  describe("Access control", () => {
    it("restricts setFeeRecipient to the owner and uses two-step ownership transfer", async () => {
      const { factory, deployer, alice, bob } = await loadFixture(deployFixture);

      await expect(
        factory.connect(alice).setFeeRecipient(alice.address),
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");

      await expect(factory.connect(deployer).setFeeRecipient(bob.address))
        .to.emit(factory, "FeeRecipientUpdated")
        .withArgs(await factory.feeRecipient(), bob.address);
      expect(await factory.feeRecipient()).to.equal(bob.address);

      await expect(
        factory.connect(deployer).setFeeRecipient(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");

      // Ownership handover requires acceptance.
      await factory.connect(deployer).transferOwnership(alice.address);
      expect(await factory.owner()).to.equal(deployer.address);
      await factory.connect(alice).acceptOwnership();
      expect(await factory.owner()).to.equal(alice.address);
    });

    it("gives the owner no power over reserves, trading or migration", async () => {
      const { factory } = await loadFixture(deployFixture);

      const ownerCallable = factory.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => (f as any).name as string);

      for (const forbidden of [
        "pause",
        "unpause",
        "rescueTokens",
        "rescueEth",
        "setFeeBps",
        "setMigrationThreshold",
        "setVirtualReserves",
        "forceMigrate",
        "upgradeTo",
      ]) {
        expect(ownerCallable).to.not.include(forbidden);
      }
    });

    it("keeps fee parameters immutable", async () => {
      const { factory } = await loadFixture(deployFixture);

      expect(await factory.BUY_FEE_BPS()).to.equal(20n);
      expect(await factory.SELL_FEE_BPS()).to.equal(30n);
      expect(await factory.MIGRATION_THRESHOLD()).to.equal(ethers.parseEther("5"));
      expect(await factory.VIRTUAL_ETH_RESERVE()).to.equal(ethers.parseEther("0.5"));
      expect(await factory.TOTAL_SUPPLY()).to.equal(1_000_000_000n * 10n ** 18n);
      expect(await factory.CURVE_INVARIANT()).to.equal(5n * 10n ** 44n);
    });
  });

  describe("Isolation between tokens", () => {
    it("keeps one token's reserves untouchable from another", async () => {
      const { factory, alice, bob, carol } = await loadFixture(deployFixture);
      const first = await createToken(factory, alice, "First", "ONE");
      const second = await createToken(factory, bob, "Second", "TWO");

      await factory.connect(carol).buy(first.address, 0, MAX_DEADLINE, {
        value: ethers.parseEther("2"),
      });

      const secondBefore = await factory.getTokenData(second.address);
      expect(secondBefore.ethReserve).to.equal(0n);

      // Draining the first curve entirely must leave the second untouched.
      const balance = await first.token.balanceOf(carol.address);
      await first.token.connect(carol).approve(await factory.getAddress(), balance);
      await factory.connect(carol).sell(first.address, balance, 0, MAX_DEADLINE);

      const secondAfter = await factory.getTokenData(second.address);
      expect(secondAfter.ethReserve).to.equal(0n);
      expect(secondAfter.tokenReserve).to.equal(1_000_000_000n * 10n ** 18n);
      await assertEthAccounting(factory);
    });

    it("migrating one token does not disturb another", async () => {
      const { factory, alice, bob, carol } = await loadFixture(deployFixture);
      const first = await createToken(factory, alice, "First", "ONE");
      const second = await createToken(factory, bob, "Second", "TWO");

      await factory.connect(carol).buy(second.address, 0, MAX_DEADLINE, {
        value: ethers.parseEther("1"),
      });
      const secondBefore = await factory.getTokenData(second.address);

      await buyToThreshold(factory, carol, first.address);
      await factory.migrate(first.address);

      const secondAfter = await factory.getTokenData(second.address);
      expect(secondAfter.ethReserve).to.equal(secondBefore.ethReserve);
      expect(secondAfter.tokenReserve).to.equal(secondBefore.tokenReserve);
      expect(secondAfter.status).to.equal(1n); // still trading

      await assertEthAccounting(factory);
    });
  });
});
