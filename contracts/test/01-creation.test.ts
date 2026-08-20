import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import {
  deployFixture,
  createToken,
  TOTAL_SUPPLY,
  VIRTUAL_ETH,
  VIRTUAL_TOKENS,
  MIGRATION_THRESHOLD,
  spotPrice,
  MAX_DEADLINE,
} from "./helpers";

describe("Token creation & registry", () => {
  it("deploys a token from name + symbol alone", async () => {
    const { factory, alice } = await loadFixture(deployFixture);
    const { token } = await createToken(factory, alice, "Doge Killer", "DOGEK");

    expect(await token.name()).to.equal("Doge Killer");
    expect(await token.symbol()).to.equal("DOGEK");
    expect(await token.decimals()).to.equal(18n);
    expect(await token.creator()).to.equal(alice.address);
    expect(await token.launchpad()).to.equal(await factory.getAddress());
  });

  it("mints exactly 1,000,000,000 tokens, all held by the curve", async () => {
    const { factory } = await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, (await ethers.getSigners())[1]);

    expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);
    expect(await token.MAX_SUPPLY()).to.equal(TOTAL_SUPPLY);
    expect(await token.balanceOf(await factory.getAddress())).to.equal(TOTAL_SUPPLY);
    expect((await factory.getTokenData(address)).tokenReserve).to.equal(TOTAL_SUPPLY);
  });

  it("emits TokenCreated with the full indexing payload", async () => {
    const { factory, alice } = await loadFixture(deployFixture);

    const predicted = await factory.predictTokenAddress(alice.address, 0);

    await expect(factory.connect(alice).createToken("Indexed", "IDX"))
      .to.emit(factory, "TokenCreated")
      .withArgs(
        predicted,
        alice.address,
        "Indexed",
        "IDX",
        TOTAL_SUPPLY,
        VIRTUAL_ETH,
        VIRTUAL_TOKENS,
        MIGRATION_THRESHOLD,
        (ts: bigint) => ts > 0n,
      );
  });

  it("deploys to the deterministically predicted address", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);

    const predicted0 = await factory.predictTokenAddress(alice.address, 0);
    const first = await createToken(factory, alice, "First", "ONE");
    expect(first.address).to.equal(predicted0);

    // The salt uses the global registry index, so bob's token uses index 1.
    const predicted1 = await factory.predictTokenAddress(bob.address, 1);
    const second = await createToken(factory, bob, "Second", "TWO");
    expect(second.address).to.equal(predicted1);
  });

  it("maintains the on-chain registry", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);

    expect(await factory.allTokensLength()).to.equal(0n);

    const a = await createToken(factory, alice, "Alpha", "ALPHA");
    const b = await createToken(factory, bob, "Beta", "BETA");

    expect(await factory.allTokensLength()).to.equal(2n);
    expect(await factory.allTokens(0)).to.equal(a.address);
    expect(await factory.allTokens(1)).to.equal(b.address);
    expect(await factory.isLaunchpadToken(a.address)).to.equal(true);
    expect(await factory.isLaunchpadToken(b.address)).to.equal(true);
    expect(await factory.isLaunchpadToken(alice.address)).to.equal(false);

    expect(await factory.getTokens(0, 10)).to.deep.equal([a.address, b.address]);
    expect(await factory.getTokens(1, 10)).to.deep.equal([b.address]);
    expect(await factory.getTokens(5, 10)).to.deep.equal([]);
  });

  it("starts every curve at 0.5 ETH virtual liquidity and a 0.5 ETH valuation", async () => {
    const { factory, alice } = await loadFixture(deployFixture);
    const { address } = await createToken(factory, alice);

    const view = await factory.getToken(address);

    expect(view.status).to.equal(1n); // Trading
    expect(view.ethReserve).to.equal(0n);
    expect(view.virtualEthReserve).to.equal(VIRTUAL_ETH);
    expect(view.tokenReserve).to.equal(TOTAL_SUPPLY);
    expect(view.virtualTokenReserve).to.equal(TOTAL_SUPPLY);
    expect(view.tokenPrice).to.equal(spotPrice(VIRTUAL_ETH, TOTAL_SUPPLY));
    expect(view.tokenPrice).to.equal(500_000_000n); // 5e8 wei per whole token
    expect(view.fullyDilutedValuation).to.equal(VIRTUAL_ETH); // 0.5 ETH
    expect(view.circulatingSupply).to.equal(0n);
    expect(view.marketCap).to.equal(0n);
    expect(view.migrationProgressBps).to.equal(0n);
  });

  it("optionally executes a creator buy in the same transaction", async () => {
    const { factory, alice } = await loadFixture(deployFixture);
    const value = ethers.parseEther("1");

    const { address, token } = await createToken(factory, alice, "Sniped", "SNIPE", value);

    expect(await token.balanceOf(alice.address)).to.be.gt(0n);
    const data = await factory.getTokenData(address);
    expect(data.ethReserve).to.equal(value - (value * 20n) / 10_000n);
  });

  it("rejects empty or oversized metadata", async () => {
    const { factory, alice } = await loadFixture(deployFixture);

    await expect(factory.connect(alice).createToken("", "SYM")).to.be.revertedWithCustomError(
      factory,
      "InvalidName",
    );
    await expect(factory.connect(alice).createToken("Name", "")).to.be.revertedWithCustomError(
      factory,
      "InvalidSymbol",
    );
    await expect(
      factory.connect(alice).createToken("x".repeat(65), "SYM"),
    ).to.be.revertedWithCustomError(factory, "InvalidName");
    await expect(
      factory.connect(alice).createToken("Name", "x".repeat(17)),
    ).to.be.revertedWithCustomError(factory, "InvalidSymbol");
  });

  it("locks the implementation and each clone against re-initialisation", async () => {
    const { factory, tokenImplementation, alice } = await loadFixture(deployFixture);
    const { token } = await createToken(factory, alice);

    await expect(
      tokenImplementation.initialize("Hijack", "HJK", alice.address, alice.address),
    ).to.be.revertedWithCustomError(tokenImplementation, "InvalidInitialization");

    await expect(
      token.connect(alice).initialize("Hijack", "HJK", alice.address, alice.address),
    ).to.be.revertedWithCustomError(token, "InvalidInitialization");
  });

  it("exposes no minting, ownership or blacklist surface on the token", async () => {
    const { factory, alice } = await loadFixture(deployFixture);
    const { token } = await createToken(factory, alice);

    const fragments = token.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => (f as any).name as string);

    for (const forbidden of ["mint", "burn", "owner", "transferOwnership", "pause", "blacklist"]) {
      expect(fragments).to.not.include(forbidden);
    }
  });

  it("transfers freely before migration (no honeypot, no transfer tax)", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice);

    await factory.connect(alice).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("1") });
    const balance = await token.balanceOf(alice.address);

    await token.connect(alice).transfer(bob.address, balance);

    // Exact amount arrives — no fee-on-transfer.
    expect(await token.balanceOf(bob.address)).to.equal(balance);
    expect(await token.balanceOf(alice.address)).to.equal(0n);
  });

  it("rejects trading against an address that is not a launchpad token", async () => {
    const { factory, alice, weth } = await loadFixture(deployFixture);

    await expect(
      factory.connect(alice).buy(await weth.getAddress(), 0, MAX_DEADLINE, { value: 1n }),
    ).to.be.revertedWithCustomError(factory, "UnknownToken");

    await expect(factory.getToken(await weth.getAddress())).to.be.revertedWithCustomError(
      factory,
      "UnknownToken",
    );
  });
});
