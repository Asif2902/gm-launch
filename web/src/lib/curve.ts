import { PROTOCOL } from "./config";

/**
 * Client-side mirror of `BondingCurve.sol`.
 *
 * **Display only.** Nothing that decides a transaction may be computed here — real quotes and
 * slippage floors come from `quoteBuy` / `quoteSell` on the contract, because the chain is the
 * only authority on what a trade returns (spec §14). This exists for two narrow purposes:
 *
 *   1. demo mode, where there is no deployed factory to quote against;
 *   2. instant feedback while the on-chain quote is still in flight.
 *
 * The arithmetic is identical to the Solidity, including the flooring direction, so the preview
 * matches execution to the wei whenever a real quote is available.
 */

const { virtualEthReserve, migrationThreshold, buyFeeBps, sellFeeBps, bps, priceUnit } = PROTOCOL;

export interface BuyPreview {
  fee: bigint;
  ethAfterFee: bigint;
  tokensOut: bigint;
  refund: bigint;
  priceAfter: bigint;
  triggersMigration: boolean;
}

export interface SellPreview {
  grossEthOut: bigint;
  fee: bigint;
  ethOut: bigint;
  priceAfter: bigint;
}

const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);

export function previewBuy(
  ethIn: bigint,
  ethReserve: bigint,
  tokenReserve: bigint,
): BuyPreview {
  if (ethIn <= 0n || tokenReserve === 0n) {
    return {
      fee: 0n,
      ethAfterFee: 0n,
      tokensOut: 0n,
      refund: 0n,
      priceAfter: spotPrice(virtualEthReserve + ethReserve, tokenReserve),
      triggersMigration: false,
    };
  }

  let fee = (ethIn * buyFeeBps) / bps;
  let netEth = ethIn - fee;
  let refund = 0n;

  // Threshold pinning: a buy is partially filled so the curve lands on exactly 5 ETH.
  const headroom = migrationThreshold - ethReserve;
  if (netEth > headroom) {
    netEth = headroom;
    let grossUsed = ceilDiv(netEth * bps, bps - buyFeeBps);
    if (grossUsed > ethIn) grossUsed = ethIn;
    fee = grossUsed - netEth;
    refund = ethIn - grossUsed;
  }

  const effectiveEth = virtualEthReserve + ethReserve;
  const tokensOut = netEth === 0n ? 0n : (tokenReserve * netEth) / (effectiveEth + netEth);

  const nextEthReserve = ethReserve + netEth;
  const nextTokenReserve = tokenReserve - tokensOut;

  return {
    fee,
    ethAfterFee: netEth,
    tokensOut,
    refund,
    priceAfter: spotPrice(virtualEthReserve + nextEthReserve, nextTokenReserve),
    triggersMigration: nextEthReserve >= migrationThreshold,
  };
}

export function previewSell(
  tokensIn: bigint,
  ethReserve: bigint,
  tokenReserve: bigint,
): SellPreview {
  if (tokensIn <= 0n) {
    return {
      grossEthOut: 0n,
      fee: 0n,
      ethOut: 0n,
      priceAfter: spotPrice(virtualEthReserve + ethReserve, tokenReserve),
    };
  }

  const effectiveEth = virtualEthReserve + ethReserve;
  const grossEthOut = (effectiveEth * tokensIn) / (tokenReserve + tokensIn);
  const fee = (grossEthOut * sellFeeBps) / bps;

  return {
    grossEthOut,
    fee,
    ethOut: grossEthOut - fee,
    priceAfter: spotPrice(effectiveEth - grossEthOut, tokenReserve + tokensIn),
  };
}

export function spotPrice(effectiveEthReserve: bigint, tokenReserve: bigint): bigint {
  return tokenReserve === 0n ? 0n : (effectiveEthReserve * priceUnit) / tokenReserve;
}
