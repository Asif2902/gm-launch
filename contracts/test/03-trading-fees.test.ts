import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import {
  deployFixture,
  createToken,
  assertEthAccounting,
  buyFee,
  sellFee,
  VIRTUAL_ETH,
  MAX_DEADLINE,
  MIGRATION_THRESHOLD,
} from "./helpers";

describe("Trading, fees and ETH accounting", () => {
  it("charges exactly 0.20 % of the ETH input on a buy", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address } = await createToken(factory, alice);

    const value = ethers.parseEther("2.5");
    const expectedFee = (value * 20n) / 10_000n; // 0.005 ETH
    expect(expectedFee).to.equal(ethers.parseEther("0.005"));

    await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value });

    expect(await factory.accruedFees()).to.equal(expectedFee);
    expect((await factory.getTokenData(address)).ethReserve).to.equal(value - expectedFee);
  });

  it("charges exactly 0.30 % of the gross ETH output on a sell, paying the seller the rest", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice);

    const value = ethers.parseEther("2");
    await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value });
    const feesAfterBuy = await factory.accruedFees();

    const tokensIn = (await token.balanceOf(bob.address)) / 2n;
    const quote = await factory.quoteSell(address, tokensIn);

    // The spec's requirement, stated directly: user receives X minus 0.30 % of X.
    expect(quote.fee).to.equal((quote.grossEthOut * 30n) / 10_000n);
    expect(quote.ethOut).to.equal(quote.grossEthOut - quote.fee);

    await token.connect(bob).approve(await factory.getAddress(), tokensIn);
    await expect(
      factory.connect(bob).sell(address, tokensIn, 0, MAX_DEADLINE),
    ).to.changeEtherBalance(bob, quote.ethOut);

    expect(await factory.accruedFees()).to.equal(feesAfterBuy + quote.fee);
  });

  it("emits PlatformFeeCollected with the right action discriminator", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice);

    const value = ethers.parseEther("1");
    await expect(factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value }))
      .to.emit(factory, "PlatformFeeCollected")
      .withArgs(address, bob.address, 0, buyFee(value), (ts: bigint) => ts > 0n);

    const tokensIn = await token.balanceOf(bob.address);
    const quote = await factory.quoteSell(address, tokensIn);
    await token.connect(bob).approve(await factory.getAddress(), tokensIn);

    await expect(factory.connect(bob).sell(address, tokensIn, 0, MAX_DEADLINE))
      .to.emit(factory, "PlatformFeeCollected")
      .withArgs(address, bob.address, 1, quote.fee, (ts: bigint) => ts > 0n);

    expect(quote.fee).to.equal(sellFee(quote.grossEthOut));
  });

  it("accumulates fees in ETH and pays them only to the fee recipient", async () => {
    const { factory, alice, bob, carol, feeRecipient } = await loadFixture(deployFixture);
    const { address } = await createToken(factory, alice);

    await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("1") });
    await factory.connect(carol).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("2") });

    const accrued = await factory.accruedFees();
    expect(accrued).to.equal(ethers.parseEther("0.006"));

    // Permissionless trigger, fixed destination.
    await expect(factory.connect(carol).withdrawFees()).to.changeEtherBalance(
      feeRecipient,
      accrued,
    );
    expect(await factory.accruedFees()).to.equal(0n);

    await expect(factory.withdrawFees()).to.be.revertedWithCustomError(factory, "ZeroAmount");
  });

  it("keeps fees out of the curve reserves", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address } = await createToken(factory, alice);

    const value = ethers.parseEther("3");
    await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value });

    const data = await factory.getTokenData(address);
    expect(data.ethReserve + (await factory.accruedFees())).to.equal(value);
    await assertEthAccounting(factory);
  });

  it("holds the global ETH invariant across a mixed trading session", async () => {
    const { factory, alice, bob, carol } = await loadFixture(deployFixture);
    const first = await createToken(factory, alice, "First", "ONE");
    const second = await createToken(factory, bob, "Second", "TWO");

    await factory.connect(bob).buy(first.address, 0, MAX_DEADLINE, { value: ethers.parseEther("1.2") });
    await factory.connect(carol).buy(second.address, 0, MAX_DEADLINE, { value: ethers.parseEther("0.9") });
    await factory.connect(carol).buy(first.address, 0, MAX_DEADLINE, { value: ethers.parseEther("0.4") });

    const bobBalance = await first.token.balanceOf(bob.address);
    await first.token.connect(bob).approve(await factory.getAddress(), bobBalance);
    await factory.connect(bob).sell(first.address, bobBalance / 2n, 0, MAX_DEADLINE);

    await assertEthAccounting(factory);
  });

  it("tracks cumulative volume counters on-chain", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice);

    const value = ethers.parseEther("1");
    await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value });
    const bought = await token.balanceOf(bob.address);

    let view = await factory.getToken(address);
    expect(view.cumulativeEthIn).to.equal(value - buyFee(value));
    expect(view.cumulativeTokensBought).to.equal(bought);
    expect(view.cumulativeEthOut).to.equal(0n);
    expect(view.cumulativeTokensSold).to.equal(0n);

    const quote = await factory.quoteSell(address, bought);
    await token.connect(bob).approve(await factory.getAddress(), bought);
    await factory.connect(bob).sell(address, bought, 0, MAX_DEADLINE);

    view = await factory.getToken(address);
    expect(view.cumulativeTokensSold).to.equal(bought);
    expect(view.cumulativeEthOut).to.equal(quote.grossEthOut);
  });

  it("enforces slippage bounds on both sides", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice);

    const value = ethers.parseEther("1");
    const quote = await factory.quoteBuy(address, value);

    await expect(
      factory.connect(bob).buy(address, quote.tokensOut + 1n, MAX_DEADLINE, { value }),
    ).to.be.revertedWithCustomError(factory, "SlippageExceeded");

    await factory.connect(bob).buy(address, quote.tokensOut, MAX_DEADLINE, { value });

    const tokensIn = await token.balanceOf(bob.address);
    const sellQuote = await factory.quoteSell(address, tokensIn);
    await token.connect(bob).approve(await factory.getAddress(), tokensIn);

    await expect(
      factory.connect(bob).sell(address, tokensIn, sellQuote.ethOut + 1n, MAX_DEADLINE),
    ).to.be.revertedWithCustomError(factory, "SlippageExceeded");
  });

  it("enforces deadlines", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address } = await createToken(factory, alice);

    const past = (await time.latest()) - 1;
    await expect(
      factory.connect(bob).buy(address, 0, past, { value: ethers.parseEther("1") }),
    ).to.be.revertedWithCustomError(factory, "DeadlinePassed");

    await expect(
      factory.connect(bob).sell(address, 1n, 0, past),
    ).to.be.revertedWithCustomError(factory, "DeadlinePassed");
  });

  it("rejects zero-value trades", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address } = await createToken(factory, alice);

    await expect(
      factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: 0 }),
    ).to.be.revertedWithCustomError(factory, "ZeroAmount");

    await expect(
      factory.connect(bob).sell(address, 0, 0, MAX_DEADLINE),
    ).to.be.revertedWithCustomError(factory, "ZeroAmount");
  });

  it("requires an allowance to sell and reverts when the seller is short", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice);

    await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("1") });
    const balance = await token.balanceOf(bob.address);

    // No approval yet.
    await expect(factory.connect(bob).sell(address, balance, 0, MAX_DEADLINE)).to.be.reverted;

    // Approved, but selling more than owned.
    await token.connect(bob).approve(await factory.getAddress(), ethers.MaxUint256);
    await expect(factory.connect(bob).sell(address, balance * 2n, 0, MAX_DEADLINE)).to.be.reverted;
  });

  it("pins the reserve to exactly 5 ETH and refunds the overshoot", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address } = await createToken(factory, alice);

    // Gross needed for a 5 ETH net reserve: 5 / 0.998 = 5.010020040080160320 ETH.
    const exactGross = (MIGRATION_THRESHOLD * 10_000n + 9_979n) / 9_980n;
    const sent = ethers.parseEther("6");
    const expectedRefund = sent - exactGross;

    await expect(factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: sent }))
      .to.emit(factory, "BuyRefunded")
      .withArgs(address, bob.address, expectedRefund, (ts: bigint) => ts > 0n);

    const data = await factory.getTokenData(address);
    expect(data.ethReserve).to.equal(MIGRATION_THRESHOLD);
    expect(data.status).to.equal(2n); // PendingMigration
    expect(await factory.accruedFees()).to.equal(exactGross - MIGRATION_THRESHOLD);
    await assertEthAccounting(factory);
  });

  it("stops all trading the moment the threshold is reached", async () => {
    const { factory, alice, bob, carol } = await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice);

    await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("6") });

    await expect(
      factory.connect(carol).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("0.1") }),
    ).to.be.revertedWithCustomError(factory, "NotTrading");

    const balance = await token.balanceOf(bob.address);
    await token.connect(bob).approve(await factory.getAddress(), balance);
    await expect(
      factory.connect(bob).sell(address, balance, 0, MAX_DEADLINE),
    ).to.be.revertedWithCustomError(factory, "NotTrading");

    await expect(factory.quoteBuy(address, 1n)).to.be.revertedWithCustomError(
      factory,
      "NotTrading",
    );
  });

  it("emits reserves and price on every trade so prices need no simulation", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address } = await createToken(factory, alice);

    const value = ethers.parseEther("1.5");
    const quote = await factory.quoteBuy(address, value);

    const receipt = await (
      await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value })
    ).wait();

    const parsed = receipt!.logs
      .map((log) => {
        try {
          return factory.interface.parseLog(log as any);
        } catch {
          return null;
        }
      })
      .find((p) => p?.name === "TokenBought")!;

    expect(parsed.args.ethIn).to.equal(value);
    expect(parsed.args.fee).to.equal(buyFee(value));
    expect(parsed.args.ethAfterFee).to.equal(value - buyFee(value));
    expect(parsed.args.tokensOut).to.equal(quote.tokensOut);
    expect(parsed.args.tokenPrice).to.equal(quote.priceAfter);
    expect(parsed.args.virtualEthReserve).to.equal(VIRTUAL_ETH + parsed.args.ethReserve);

    // Price is fully reconstructible from the event alone.
    const derived =
      (parsed.args.virtualEthReserve * 10n ** 18n) / parsed.args.tokenReserve;
    expect(derived).to.equal(parsed.args.tokenPrice);

    const onChain = await factory.getToken(address);
    expect(onChain.ethReserve).to.equal(parsed.args.ethReserve);
    expect(onChain.tokenReserve).to.equal(parsed.args.tokenReserve);
    expect(onChain.tokenPrice).to.equal(parsed.args.tokenPrice);
  });
});
