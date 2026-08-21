import { ethers } from "hardhat";
import { expect } from "chai";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import type {
  PumperFactory,
  PumperToken,
  UniswapV2Migrator,
  MockWETH,
  TestUniswapV2Router02,
} from "../typechain-types";

// --- protocol constants, mirrored from docs/ECONOMICS.md -----------------------------------

export const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n; // 1e27
export const VIRTUAL_ETH = 5n * 10n ** 17n; // 0.5 ETH
export const VIRTUAL_TOKENS = TOTAL_SUPPLY;
export const K = VIRTUAL_ETH * VIRTUAL_TOKENS; // 5e44
export const MIGRATION_THRESHOLD = 5n * 10n ** 18n; // 5 ETH
export const BUY_FEE_BPS = 20n;
export const SELL_FEE_BPS = 30n;
export const BPS = 10_000n;
export const PRICE_UNIT = 10n ** 18n;
export const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
export const MAX_DEADLINE = ethers.MaxUint256;

/** Ideal token reserve when the curve holds exactly 5 ETH: k / 5.5e18. */
export const IDEAL_TOKEN_RESERVE_AT_MIGRATION = K / (VIRTUAL_ETH + MIGRATION_THRESHOLD);

// --- reference implementations of the curve, independent of the Solidity ------------------

export const tokensOut = (ethIn: bigint, ethReserve: bigint, tokenReserve: bigint): bigint =>
  ethIn === 0n ? 0n : (tokenReserve * ethIn) / (ethReserve + ethIn);

export const ethOut = (tokensIn: bigint, ethReserve: bigint, tokenReserve: bigint): bigint =>
  tokensIn === 0n ? 0n : (ethReserve * tokensIn) / (tokenReserve + tokensIn);

export const spotPrice = (ethReserve: bigint, tokenReserve: bigint): bigint =>
  tokenReserve === 0n ? 0n : (ethReserve * PRICE_UNIT) / tokenReserve;

export const buyFee = (grossEthIn: bigint): bigint => (grossEthIn * BUY_FEE_BPS) / BPS;
export const sellFee = (grossEthOut: bigint): bigint => (grossEthOut * SELL_FEE_BPS) / BPS;

// --- fixture -------------------------------------------------------------------------------

export interface Deployment {
  factory: PumperFactory;
  migrator: UniswapV2Migrator;
  tokenImplementation: PumperToken;
  weth: MockWETH;
  uniswapFactory: any;
  uniswapRouter: TestUniswapV2Router02;
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  carol: HardhatEthersSigner;
  feeRecipient: HardhatEthersSigner;
}

/**
 * Deploys the full stack exactly the way scripts/deploy.ts does on Base Sepolia, including the
 * CREATE-nonce prediction that lets the migrator and the launchpad reference each other as
 * immutables. Uniswap V2 here is the genuine v2-core factory/pair, not a mock.
 */
export async function deployFixture(): Promise<Deployment> {
  const [deployer, alice, bob, carol, feeRecipient] = await ethers.getSigners();

  const weth = await (await ethers.getContractFactory("MockWETH")).deploy();
  const uniswapFactory = await (
    await ethers.getContractFactory("UniswapV2Factory")
  ).deploy(ethers.ZeroAddress);

  // Stands in for the canonical UniswapV2Router02 locally; see the contract's own notes on
  // why the real Router02 cannot resolve a locally compiled pair.
  const uniswapRouter = (await (
    await ethers.getContractFactory("TestUniswapV2Router02")
  ).deploy(await uniswapFactory.getAddress(), await weth.getAddress())) as unknown as TestUniswapV2Router02;
  await uniswapRouter.waitForDeployment();

  const tokenImplementation = await (await ethers.getContractFactory("PumperToken")).deploy();
  await tokenImplementation.waitForDeployment();

  // migrator lands on the next nonce, launchpad on the one after that
  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  const predictedLaunchpad = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });

  const migrator = await (
    await ethers.getContractFactory("UniswapV2Migrator")
  ).deploy(
    predictedLaunchpad,
    await uniswapRouter.getAddress(),
    await uniswapFactory.getAddress(),
    await weth.getAddress(),
  );

  const factory = await (
    await ethers.getContractFactory("PumperFactory")
  ).deploy(
    await tokenImplementation.getAddress(),
    await migrator.getAddress(),
    feeRecipient.address,
    deployer.address,
  );

  expect(await factory.getAddress()).to.equal(predictedLaunchpad);

  return {
    factory,
    migrator,
    tokenImplementation,
    weth,
    uniswapFactory,
    uniswapRouter,
    deployer,
    alice,
    bob,
    carol,
    feeRecipient,
  };
}

/** Creates a token and returns both its address and a typed handle. */
export async function createToken(
  factory: PumperFactory,
  creator: HardhatEthersSigner,
  name = "Pumper Test",
  symbol = "PUMP",
  value: bigint = 0n,
): Promise<{ address: string; token: PumperToken }> {
  const tx = await factory.connect(creator).createToken(name, symbol, { value });
  const receipt = await tx.wait();

  const created = receipt!.logs
    .map((log) => {
      try {
        return factory.interface.parseLog(log as any);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "TokenCreated");

  const address = created!.args.token as string;
  const token = (await ethers.getContractAt("PumperToken", address)) as unknown as PumperToken;
  return { address, token };
}

/**
 * Asserts the launchpad's global ETH accounting invariant:
 *   balance == Σ ethReserve + accruedFees + Σ pendingEth
 */
export async function assertEthAccounting(
  factory: PumperFactory,
  pendingAccounts: string[] = [],
): Promise<void> {
  const total = await ethers.provider.getBalance(await factory.getAddress());

  let reserves = 0n;
  const count = await factory.allTokensLength();
  for (let i = 0n; i < count; i++) {
    const token = await factory.allTokens(i);
    reserves += (await factory.getTokenData(token)).ethReserve;
  }

  let pending = 0n;
  for (const account of pendingAccounts) {
    pending += await factory.pendingEth(account);
  }

  expect(total).to.equal(reserves + (await factory.accruedFees()) + pending);
}

/**
 * Drives a token all the way to `PendingMigration` using a single oversized buy.
 * Returns the transaction response so callers can assert on emitted events.
 */
export function buyToThreshold(
  factory: PumperFactory,
  buyer: HardhatEthersSigner,
  token: string,
) {
  // 5 / 0.998 = 5.01002... ETH is the exact gross needed; overshoot so the cap engages.
  return factory.connect(buyer).buy(token, 0, MAX_DEADLINE, { value: ethers.parseEther("6") });
}
