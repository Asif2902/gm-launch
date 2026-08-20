import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import {
  deployFixture,
  createToken,
  tokensOut as refTokensOut,
  ethOut as refEthOut,
  spotPrice,
  buyFee,
  TOTAL_SUPPLY,
  VIRTUAL_ETH,
  K,
  PRICE_UNIT,
  MAX_DEADLINE,
  MIGRATION_THRESHOLD,
} from "./helpers";

describe("Bonding curve mathematics", () => {
  it("matches an independent reference implementation on a buy", async () => {
    const { factory, alice } = await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice);

    const gross = ethers.parseEther("1");
    const net = gross - buyFee(gross);
    const expected = refTokensOut(net, VIRTUAL_ETH, TOTAL_SUPPLY);

    await factory.connect(alice).buy(address, 0, MAX_DEADLINE, { value: gross });

    expect(await token.balanceOf(alice.address)).to.equal(expected);
  });

  it("matches an independent reference implementation on a sell", async () => {
    const { factory, alice } = await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice);

    await factory.connect(alice).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("2") });

    const data = await factory.getTokenData(address);
    const tokensIn = (await token.balanceOf(alice.address)) / 2n;
    const expectedGross = refEthOut(tokensIn, VIRTUAL_ETH + data.ethReserve, data.tokenReserve);

    const quote = await factory.quoteSell(address, tokensIn);
    expect(quote.grossEthOut).to.equal(expectedGross);
  });

  it("never lets the invariant k = E*T decrease", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice);

    const check = async () => {
      const d = await factory.getTokenData(address);
      const product = (VIRTUAL_ETH + d.ethReserve) * d.tokenReserve;
      expect(product).to.be.gte(K);
      // Flooring only ever adds dust: stay within a vanishingly small relative band.
      expect(product - K).to.be.lt(K / 10n ** 12n);
    };

    await check();

    for (const amount of ["0.001", "0.05", "0.7", "1.3", "0.2"]) {
      await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther(amount) });
      await check();
    }

    await token.connect(bob).approve(await factory.getAddress(), ethers.MaxUint256);
    for (const divisor of [5n, 4n, 3n, 2n]) {
      const held = await token.balanceOf(bob.address);
      await factory.connect(bob).sell(address, held / divisor, 0, MAX_DEADLINE);
      await check();
    }
  });

  it("agrees with the closed forms P = E^2*1e18/k and FDV = E^2/Ev0", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address } = await createToken(factory, alice);

    for (const amount of ["0.3", "1.1", "2.4"]) {
      await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther(amount) });

      const view = await factory.getToken(address);
      const E = view.virtualEthReserve;

      // Closed forms are exact in real arithmetic; integer flooring leaves a sub-ppm gap.
      const closedFormPrice = (E * E * PRICE_UNIT) / K;
      const closedFormFdv = (E * E) / VIRTUAL_ETH;

      expect(view.tokenPrice).to.be.closeTo(closedFormPrice, closedFormPrice / 10n ** 9n + 1n);
      expect(view.fullyDilutedValuation).to.be.closeTo(
        closedFormFdv,
        closedFormFdv / 10n ** 9n + 1n,
      );
      expect(view.tokenPrice).to.equal(spotPrice(E, view.tokenReserve));
    }
  });

  it("agrees with the closed form tokensSold = S * e / E", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address } = await createToken(factory, alice);

    await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("2") });

    const view = await factory.getToken(address);
    const sold = TOTAL_SUPPLY - view.tokenReserve;
    const closedForm = (TOTAL_SUPPLY * view.ethReserve) / view.virtualEthReserve;

    expect(sold).to.be.closeTo(closedForm, 10n);
  });

  it("reproduces the documented price ladder from ECONOMICS §6.4", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address } = await createToken(factory, alice);

    // Reach e = 1 ETH exactly by sending gross = 1 / 0.998.
    const ladder: Array<[string, bigint, bigint]> = [
      // [target real ETH, expected tokens left, expected price wei/token]
      ["1", 333_333_333n, 4_500_000_000n],
      ["2", 200_000_000n, 12_500_000_000n],
      ["3", 142_857_142n, 24_500_000_000n],
    ];

    let reached = 0n;
    for (const [targetEth, expectedTokensWhole, expectedPrice] of ladder) {
      const target = ethers.parseEther(targetEth);
      const needNet = target - reached;
      // gross that yields exactly `needNet` after the 0.20 % fee
      const gross = (needNet * 10_000n + 9_979n) / 9_980n;

      await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: gross });

      const view = await factory.getToken(address);
      reached = view.ethReserve;

      expect(reached).to.be.closeTo(target, ethers.parseEther("0.000001"));
      expect(view.tokenReserve / 10n ** 18n).to.be.closeTo(expectedTokensWhole, 1n);
      expect(view.tokenPrice).to.be.closeTo(expectedPrice, expectedPrice / 100_000n);
    }
  });

  it("round-trips a buy then sell back to (almost) the starting reserves", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice);

    await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("1") });

    const balance = await token.balanceOf(bob.address);
    await token.connect(bob).approve(await factory.getAddress(), balance);
    await factory.connect(bob).sell(address, balance, 0, MAX_DEADLINE);

    const view = await factory.getToken(address);
    // All tokens are back in the curve; only rounding dust remains on the ETH side.
    expect(view.tokenReserve).to.equal(TOTAL_SUPPLY);
    expect(view.ethReserve).to.be.lt(10n);
  });

  it("prices monotonically upward on buys and downward on sells", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice);

    let previous = (await factory.getToken(address)).tokenPrice;
    for (let i = 0; i < 5; i++) {
      await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("0.4") });
      const price = (await factory.getToken(address)).tokenPrice;
      expect(price).to.be.gt(previous);
      previous = price;
    }

    const balance = await token.balanceOf(bob.address);
    await token.connect(bob).approve(await factory.getAddress(), balance);
    for (let i = 0; i < 4; i++) {
      await factory.connect(bob).sell(address, balance / 8n, 0, MAX_DEADLINE);
      const price = (await factory.getToken(address)).tokenPrice;
      expect(price).to.be.lt(previous);
      previous = price;
    }
  });

  it("keeps the curve solvent: e never goes negative even selling the entire float", async () => {
    const { factory, alice, bob, carol } = await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice);

    await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("3") });
    await factory.connect(carol).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("1.5") });

    // Consolidate the whole circulating float onto one account and dump it.
    const carolBalance = await token.balanceOf(carol.address);
    await token.connect(carol).transfer(bob.address, carolBalance);

    const float = await token.balanceOf(bob.address);
    await token.connect(bob).approve(await factory.getAddress(), float);
    await factory.connect(bob).sell(address, float, 0, MAX_DEADLINE);

    const view = await factory.getToken(address);
    expect(view.ethReserve).to.be.gte(0n);
    expect(view.ethReserve).to.be.lt(100n); // dust only
    expect(view.tokenReserve).to.equal(TOTAL_SUPPLY);
  });

  it("quotes match execution exactly", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice);

    const value = ethers.parseEther("1.75");
    const quote = await factory.quoteBuy(address, value);

    await factory.connect(bob).buy(address, quote.tokensOut, MAX_DEADLINE, { value });

    expect(await token.balanceOf(bob.address)).to.equal(quote.tokensOut);
    const view = await factory.getToken(address);
    expect(view.tokenPrice).to.equal(quote.priceAfter);

    const tokensIn = quote.tokensOut / 3n;
    const sellQuote = await factory.quoteSell(address, tokensIn);
    await token.connect(bob).approve(await factory.getAddress(), tokensIn);
    await expect(
      factory.connect(bob).sell(address, tokensIn, sellQuote.ethOut, MAX_DEADLINE),
    ).to.changeEtherBalance(bob, sellQuote.ethOut);
  });

  it("reports remaining purchasable supply and migration progress", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address } = await createToken(factory, alice);

    const before = await factory.getToken(address);
    expect(before.tokensAvailable).to.equal(
      TOTAL_SUPPLY - (await factory.TOKEN_RESERVE_AT_MIGRATION()),
    );

    await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("2.5") });

    const after = await factory.getToken(address);
    expect(after.tokensAvailable).to.be.lt(before.tokensAvailable);
    expect(after.migrationProgressBps).to.equal(
      (after.ethReserve * 10_000n) / MIGRATION_THRESHOLD,
    );
  });
});
