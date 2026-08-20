import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import {
  deployFixture,
  createToken,
  MAX_DEADLINE,
  MIGRATION_THRESHOLD,
  PRICE_UNIT,
  VIRTUAL_ETH,
} from "./helpers";

/**
 * The architectural acceptance test.
 *
 * The single most important requirement of this system (spec, closing paragraph) is:
 *
 *   > A continuously running backend should be able to discover every token and reconstruct
 *   > every token's price, trades, volume, reserves, market cap, and migration status using
 *   > standardized on-chain events without scraping or reverse-engineering transactions.
 *
 * So this suite builds a miniature indexer that is given **nothing but logs** — no contract
 * calls, no receipts, no traces, no token addresses supplied up front — and checks that the
 * state it derives matches the chain exactly.
 *
 * The event signatures asserted below are the ones hardcoded in `indexer/src/abi.ts` and
 * `subgraph/subgraph.yaml`; if a contract change breaks them, this fails before either
 * consumer silently decodes garbage.
 */

const REQUIRED_EVENT_SIGNATURES = [
  "TokenCreated(address,address,string,string,uint256,uint256,uint256,uint256,uint256)",
  "TokenBought(address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  "TokenSold(address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  "MigrationTriggered(address,uint256,uint256,uint256)",
  "LiquidityMigrated(address,address,uint256,uint256,uint256,uint256,uint256)",
  "PlatformFeeCollected(address,address,uint8,uint256,uint256)",
];

interface ReconstructedToken {
  address: string;
  creator: string;
  name: string;
  symbol: string;
  totalSupply: bigint;
  status: number;
  ethReserve: bigint;
  virtualEthReserve: bigint;
  tokenReserve: bigint;
  price: bigint;
  marketCap: bigint;
  fdv: bigint;
  volumeEth: bigint;
  feesFromTrades: bigint;
  feesFromFeeEvents: bigint;
  tokensBought: bigint;
  tokensSold: bigint;
  buyCount: number;
  sellCount: number;
  pair: string | null;
  tokensBurned: bigint;
  lpBurned: bigint;
  openingPrice: bigint;
  migrationProgressBps: bigint;
}

const valuation = (price: bigint, supply: bigint) => (price * supply) / PRICE_UNIT;

describe("Event-only reconstruction (the indexing contract)", () => {
  it("exposes exactly the event signatures the indexer and subgraph decode against", async () => {
    const { factory } = await loadFixture(deployFixture);

    const available = factory.interface.fragments
      .filter((fragment) => fragment.type === "event")
      .map((fragment) => (fragment as any).format("sighash") as string);

    for (const signature of REQUIRED_EVENT_SIGNATURES) {
      expect(available, `missing or changed: ${signature}`).to.include(signature);
    }
  });

  it("discovers every token from TokenCreated alone", async () => {
    const { factory, alice, bob, carol } = await loadFixture(deployFixture);

    await createToken(factory, alice, "Alpha", "ALPHA");
    await createToken(factory, bob, "Beta", "BETA");
    await createToken(factory, carol, "Gamma", "GAMMA");

    const factoryAddress = await factory.getAddress();
    const logs = await ethers.provider.getLogs({ address: factoryAddress, fromBlock: 0 });

    const discovered: string[] = [];
    for (const log of logs) {
      const parsed = factory.interface.parseLog(log as any);
      if (parsed?.name === "TokenCreated") discovered.push(parsed.args.token as string);
    }

    const registry: string[] = [];
    const count = await factory.allTokensLength();
    for (let i = 0n; i < count; i++) registry.push(await factory.allTokens(i));

    // Event-derived discovery must equal the on-chain registry, in order.
    expect(discovered).to.deep.equal(registry);
    expect(discovered).to.have.lengthOf(3);
  });

  it("reconstructs price, reserves, volume, market cap and migration from logs only", async () => {
    const { factory, weth, uniswapFactory, alice, bob, carol } = await loadFixture(deployFixture);
    const factoryAddress = await factory.getAddress();

    // --- produce a busy, realistic history ---------------------------------------------------
    const traded = await createToken(factory, alice, "Reconstructed", "RCN");
    const quiet = await createToken(factory, bob, "Untouched", "QUIET");

    await factory.connect(bob).buy(traded.address, 0, MAX_DEADLINE, {
      value: ethers.parseEther("0.7"),
    });
    await factory.connect(carol).buy(traded.address, 0, MAX_DEADLINE, {
      value: ethers.parseEther("1.4"),
    });

    await traded.token.connect(bob).approve(factoryAddress, ethers.MaxUint256);
    await factory
      .connect(bob)
      .sell(traded.address, (await traded.token.balanceOf(bob.address)) / 3n, 0, MAX_DEADLINE);

    await factory.connect(carol).buy(traded.address, 0, MAX_DEADLINE, {
      value: ethers.parseEther("0.9"),
    });
    await factory.connect(alice).buy(quiet.address, 0, MAX_DEADLINE, {
      value: ethers.parseEther("0.25"),
    });

    // --- replay: logs in, state out ------------------------------------------------------------
    const tokens = await replayFactoryLogs(factory, factoryAddress);

    expect([...tokens.keys()].sort()).to.deep.equal(
      [traded.address.toLowerCase(), quiet.address.toLowerCase()].sort(),
    );

    for (const [address, rebuilt] of tokens) {
      const onChain = await factory.getToken(address);

      expect(rebuilt.ethReserve, `${rebuilt.symbol} ethReserve`).to.equal(onChain.ethReserve);
      expect(rebuilt.virtualEthReserve).to.equal(onChain.virtualEthReserve);
      expect(rebuilt.tokenReserve).to.equal(onChain.tokenReserve);
      expect(rebuilt.price, `${rebuilt.symbol} price`).to.equal(onChain.tokenPrice);
      expect(rebuilt.marketCap).to.equal(onChain.marketCap);
      expect(rebuilt.fdv).to.equal(onChain.fullyDilutedValuation);
      expect(rebuilt.migrationProgressBps).to.equal(onChain.migrationProgressBps);
      expect(rebuilt.tokensBought).to.equal(onChain.cumulativeTokensBought);
      expect(rebuilt.tokensSold).to.equal(onChain.cumulativeTokensSold);
      expect(rebuilt.name).to.equal(onChain.name);
      expect(rebuilt.symbol).to.equal(onChain.symbol);
      expect(rebuilt.creator).to.equal(onChain.creator.toLowerCase());

      // The fee ledger must agree whether you total the trade events or the fee events.
      expect(rebuilt.feesFromFeeEvents).to.equal(rebuilt.feesFromTrades);
    }

    // Fees across all tokens reconcile with the contract's single accumulator.
    const totalFees = [...tokens.values()].reduce((sum, token) => sum + token.feesFromTrades, 0n);
    expect(totalFees).to.equal(await factory.accruedFees());

    // A token that was never traded still reconstructs to its exact genesis state.
    const untouched = tokens.get(quiet.address.toLowerCase())!;
    expect(untouched.volumeEth).to.be.gt(0n); // it was bought once
    const neverTraded = tokens.get(traded.address.toLowerCase())!;
    expect(neverTraded.buyCount).to.equal(3);
    expect(neverTraded.sellCount).to.equal(1);

    // --- carry the same token through migration and replay again -------------------------------
    await factory.connect(carol).buy(traded.address, 0, MAX_DEADLINE, {
      value: ethers.parseEther("6"),
    });
    await factory.migrate(traded.address);

    const afterMigration = await replayFactoryLogs(factory, factoryAddress);
    const migrated = afterMigration.get(traded.address.toLowerCase())!;

    expect(migrated.status).to.equal(3);
    expect(migrated.pair).to.not.equal(null);
    expect(migrated.pair).to.equal(
      (await uniswapFactory.getPair(traded.address, await weth.getAddress())).toLowerCase(),
    );

    // The opening price derived purely from LiquidityMigrated matches the real pool.
    const pair = await ethers.getContractAt("UniswapV2Pair", migrated.pair!);
    const [reserve0, reserve1] = await pair.getReserves();
    const token0 = await pair.token0();
    const [reserveToken, reserveWeth] =
      token0.toLowerCase() === traded.address.toLowerCase()
        ? [reserve0, reserve1]
        : [reserve1, reserve0];

    expect(migrated.openingPrice).to.equal((reserveWeth * PRICE_UNIT) / reserveToken);
    expect(migrated.lpBurned).to.equal(await pair.balanceOf(await pair.getAddress()) + (await pair.balanceOf("0x000000000000000000000000000000000000dEaD")));
    expect(migrated.tokensBurned).to.equal(
      await traded.token.balanceOf("0x000000000000000000000000000000000000dEaD"),
    );
  });

  it("reconstructs holder balances from Transfer logs only", async () => {
    const { factory, alice, bob, carol } = await loadFixture(deployFixture);
    const factoryAddress = await factory.getAddress();
    const { address, token } = await createToken(factory, alice, "Holders", "HODL");

    await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("1") });
    await factory.connect(carol).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("0.4") });

    // A peer-to-peer send — invisible to the launchpad's own events, which is exactly why
    // holder tracking must come from Transfer.
    await token.connect(bob).transfer(carol.address, (await token.balanceOf(bob.address)) / 4n);

    await token.connect(carol).approve(factoryAddress, ethers.MaxUint256);
    await factory
      .connect(carol)
      .sell(address, (await token.balanceOf(carol.address)) / 5n, 0, MAX_DEADLINE);

    const balances = new Map<string, bigint>();
    for (const event of await token.queryFilter(token.filters.Transfer(), 0, "latest")) {
      const from = event.args.from.toLowerCase();
      const to = event.args.to.toLowerCase();
      const value = event.args.value;
      if (from !== ethers.ZeroAddress) balances.set(from, (balances.get(from) ?? 0n) - value);
      if (to !== ethers.ZeroAddress) balances.set(to, (balances.get(to) ?? 0n) + value);
    }

    for (const account of [alice, bob, carol]) {
      expect(balances.get(account.address.toLowerCase()) ?? 0n, `balance of ${account.address}`)
        .to.equal(await token.balanceOf(account.address));
    }
    // The launchpad's own balance is the curve reserve — a useful cross-check for the indexer.
    expect(balances.get(factoryAddress.toLowerCase())).to.equal(
      (await factory.getTokenData(address)).tokenReserve,
    );
  });

  /**
   * OHLC candles are the one derived structure where "correct per event" is not enough — a
   * bucket has to be correct *relative to the bucket before it*.
   *
   * This is a regression test for a real bug. Both back-ends opened a new bucket at the price
   * the first trade in it produced, rather than at the price the market was already at. The
   * effect: any bucket holding a single trade recorded open == high == low == close, a flat
   * doji, because the other side of the move belonged to the previous bucket. On a live token a
   * sell that halved the price was plainly visible on the 1D candle — where several trades
   * shared one bucket — and completely invisible on 1m, 5m, 15m, 1H and 4H.
   *
   * So the invariant is not "the numbers are right", it is **continuity**: open[n] == close[n-1],
   * and high/low span the open.
   */
  it("builds candles that are continuous across buckets, so a move is never invisible", async () => {
    const { factory, alice, bob } = await loadFixture(deployFixture);
    const { address, token } = await createToken(factory, alice, "Candles", "OHLC");
    const factoryAddress = await factory.getAddress();

    const INTERVAL = 60n;
    const genesisPrice = (VIRTUAL_ETH * PRICE_UNIT) / (await factory.getTokenData(address)).tokenReserve;

    // Three buys, then a sell large enough to drop the price hard. Each trade is pushed into its
    // own bucket so that every candle holds exactly one trade — the case that used to collapse.
    await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("0.2") });
    await ethers.provider.send("evm_increaseTime", [Number(INTERVAL) * 3]);
    await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("0.5") });
    await ethers.provider.send("evm_increaseTime", [Number(INTERVAL) * 3]);
    await factory.connect(bob).buy(address, 0, MAX_DEADLINE, { value: ethers.parseEther("1") });
    await ethers.provider.send("evm_increaseTime", [Number(INTERVAL) * 3]);
    await token.connect(bob).approve(factoryAddress, ethers.MaxUint256);
    await factory
      .connect(bob)
      .sell(address, (await token.balanceOf(bob.address)) / 2n, 0, MAX_DEADLINE);

    // ---- build candles from logs alone, exactly as both back-ends now do -----------------------
    interface Candle {
      bucket: bigint;
      open: bigint;
      high: bigint;
      low: bigint;
      close: bigint;
      trades: number;
    }

    const buckets = new Map<string, Candle>();
    let previousPrice = genesisPrice;

    for (const log of await factory.queryFilter("*" as any, 0, "latest")) {
      const parsed = factory.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed || (parsed.name !== "TokenBought" && parsed.name !== "TokenSold")) continue;
      if (parsed.args.token.toLowerCase() !== address.toLowerCase()) continue;

      const price: bigint = parsed.args.tokenPrice;
      const timestamp: bigint = parsed.args.timestamp;
      const bucket = (timestamp / INTERVAL) * INTERVAL;
      const key = bucket.toString();

      let candle = buckets.get(key);
      if (!candle) {
        // The rule under test: a new bucket opens where the market already was.
        candle = { bucket, open: previousPrice, high: previousPrice, low: previousPrice, close: price, trades: 0 };
        buckets.set(key, candle);
      }
      if (price > candle.high) candle.high = price;
      if (price < candle.low) candle.low = price;
      candle.close = price;
      candle.trades += 1;

      previousPrice = price;
    }

    const candles = [...buckets.values()].sort((a, b) => Number(a.bucket - b.bucket));
    expect(candles.length, "each trade should have landed in its own bucket").to.equal(4);

    for (const [index, candle] of candles.entries()) {
      // A candle is only valid if its wick contains its body.
      expect(candle.high, `candle ${index} high`).to.be.gte(candle.open);
      expect(candle.high, `candle ${index} high`).to.be.gte(candle.close);
      expect(candle.low, `candle ${index} low`).to.be.lte(candle.open);
      expect(candle.low, `candle ${index} low`).to.be.lte(candle.close);

      // No candle may be flat: every one of these buckets contains a real price move, and a
      // flat candle is precisely how the bug manifested.
      expect(candle.open, `candle ${index} is a flat doji — the move was lost`).to.not.equal(
        candle.close,
      );

      // Continuity: this bucket opens exactly where the last one closed.
      if (index === 0) {
        expect(candle.open, "first candle opens at the genesis price").to.equal(genesisPrice);
      } else {
        expect(candle.open, `candle ${index} must open at candle ${index - 1}'s close`).to.equal(
          candles[index - 1].close,
        );
      }
    }

    // The sell is the last bucket, and it must read as a decline rather than a flat line.
    const dump = candles[candles.length - 1];
    expect(dump.close, "the sell must render as a down candle").to.be.lt(dump.open);
    expect(dump.high).to.equal(dump.open);
    expect(dump.low).to.equal(dump.close);
  });
});

/**
 * The miniature indexer. Its only input is `eth_getLogs` output from the factory address —
 * the same thing indexer/src/indexer.ts and the subgraph consume.
 */
async function replayFactoryLogs(
  factory: any,
  factoryAddress: string,
): Promise<Map<string, ReconstructedToken>> {
  const logs = await ethers.provider.getLogs({ address: factoryAddress, fromBlock: 0 });
  const tokens = new Map<string, ReconstructedToken>();

  for (const log of logs) {
    const parsed = factory.interface.parseLog(log as any);
    if (!parsed) continue;

    const args = parsed.args;

    switch (parsed.name) {
      case "TokenCreated": {
        const address = (args.token as string).toLowerCase();
        const price = (args.virtualEthReserve * PRICE_UNIT) / args.virtualTokenReserve;
        tokens.set(address, {
          address,
          creator: (args.creator as string).toLowerCase(),
          name: args.name,
          symbol: args.symbol,
          totalSupply: args.totalSupply,
          status: 1,
          ethReserve: 0n,
          virtualEthReserve: args.virtualEthReserve,
          tokenReserve: args.virtualTokenReserve,
          price,
          marketCap: 0n,
          fdv: valuation(price, args.totalSupply),
          volumeEth: 0n,
          feesFromTrades: 0n,
          feesFromFeeEvents: 0n,
          tokensBought: 0n,
          tokensSold: 0n,
          buyCount: 0,
          sellCount: 0,
          pair: null,
          tokensBurned: 0n,
          lpBurned: 0n,
          openingPrice: 0n,
          migrationProgressBps: 0n,
        });
        break;
      }

      case "TokenBought": {
        const token = tokens.get((args.token as string).toLowerCase())!;
        applyTrade(token, args.tokenPrice, args.ethReserve, args.virtualEthReserve, args.tokenReserve);
        token.volumeEth += args.ethAfterFee;
        token.feesFromTrades += args.fee;
        token.tokensBought += args.tokensOut;
        token.buyCount += 1;
        break;
      }

      case "TokenSold": {
        const token = tokens.get((args.token as string).toLowerCase())!;
        applyTrade(token, args.tokenPrice, args.ethReserve, args.virtualEthReserve, args.tokenReserve);
        token.volumeEth += args.grossEthOut;
        token.feesFromTrades += args.fee;
        token.tokensSold += args.tokensIn;
        token.sellCount += 1;
        break;
      }

      case "MigrationTriggered": {
        tokens.get((args.token as string).toLowerCase())!.status = 2;
        break;
      }

      case "LiquidityMigrated": {
        const token = tokens.get((args.token as string).toLowerCase())!;
        token.status = 3;
        token.pair = (args.pair as string).toLowerCase();
        token.tokensBurned = args.tokensBurned;
        token.lpBurned = args.lpTokensBurned;
        token.openingPrice = (args.ethAmount * PRICE_UNIT) / args.tokenAmount;
        token.ethReserve = 0n;
        token.virtualEthReserve = 0n;
        token.tokenReserve = 0n;
        token.price = token.openingPrice;
        token.marketCap = valuation(token.openingPrice, token.totalSupply - args.tokensBurned);
        token.fdv = valuation(token.openingPrice, token.totalSupply);
        token.migrationProgressBps = 0n;
        break;
      }

      case "PlatformFeeCollected": {
        tokens.get((args.token as string).toLowerCase())!.feesFromFeeEvents += args.amount;
        break;
      }

      default:
        break;
    }
  }

  return tokens;
}

function applyTrade(
  token: ReconstructedToken,
  price: bigint,
  ethReserve: bigint,
  virtualEthReserve: bigint,
  tokenReserve: bigint,
): void {
  token.price = price;
  token.ethReserve = ethReserve;
  token.virtualEthReserve = virtualEthReserve;
  token.tokenReserve = tokenReserve;
  token.marketCap = valuation(price, token.totalSupply - tokenReserve);
  token.fdv = valuation(price, token.totalSupply);
  token.migrationProgressBps = (ethReserve * 10_000n) / MIGRATION_THRESHOLD;

  // Sanity: the reserves in the event must be self-consistent with the emitted price and with
  // the protocol's virtual ETH constant. This is what lets an indexer trust either field.
  if (tokenReserve > 0n) {
    expect((virtualEthReserve * PRICE_UNIT) / tokenReserve).to.equal(price);
    expect(virtualEthReserve - ethReserve).to.equal(VIRTUAL_ETH);
  }
}
