import { Address, BigInt } from "@graphprotocol/graph-ts";

export const ZERO_ADDRESS = Address.fromString("0x0000000000000000000000000000000000000000");
export const BURN_ADDRESS = Address.fromString("0x000000000000000000000000000000000000dEaD");

export const ZERO = BigInt.fromI32(0);
export const ONE = BigInt.fromI32(1);
export const BPS = BigInt.fromI32(10000);

/** Converts base units to whole tokens when pricing: price = E * PRICE_UNIT / T. */
export const PRICE_UNIT = BigInt.fromString("1000000000000000000");

export const PROTOCOL_ID = "pumper";

export const STATUS_TRADING = 1;
export const STATUS_PENDING_MIGRATION = 2;
export const STATUS_MIGRATED = 3;

/** Candle intervals in seconds: 1m, 5m, 15m, 1h, 4h, 1d. */
export const CANDLE_INTERVALS: i32[] = [60, 300, 900, 3600, 14400, 86400];

export function valuation(price: BigInt, supply: BigInt): BigInt {
  return price.times(supply).div(PRICE_UNIT);
}
