import { Address, BigInt } from "@graphprotocol/graph-ts";

import { Transfer } from "../generated/templates/PumperToken/PumperToken";
import { Account, Holder, Protocol, Token } from "../generated/schema";
import { BURN_ADDRESS, PROTOCOL_ID, ZERO, ZERO_ADDRESS } from "./constants";

/**
 * Maintains holder balances from ERC-20 Transfer logs, and the {@link Account} entity that
 * backs profile pages.
 *
 * Using transfers rather than trade events keeps balances correct through peer-to-peer sends and
 * through post-migration Uniswap activity, neither of which produce launchpad events.
 */
export function handleTransfer(event: Transfer): void {
  const tokenId = event.address.toHexString();
  const token = Token.load(tokenId);
  if (token == null) return;

  const value = event.params.value;
  if (value.equals(ZERO)) return;

  let holderDelta = 0;
  if (event.params.from.notEqual(ZERO_ADDRESS)) {
    holderDelta += adjust(tokenId, event.params.from, value.neg(), event.block.timestamp);
  }
  if (event.params.to.notEqual(ZERO_ADDRESS)) {
    holderDelta += adjust(tokenId, event.params.to, value, event.block.timestamp);
  }

  if (holderDelta != 0) {
    token.holderCount = token.holderCount + holderDelta;
    token.save();
  }
}

/**
 * Applies a balance delta and reports the change in "counts as a holder" status:
 * +1 when an excluded-or-empty account becomes a real holder, -1 when it stops being one.
 */
function adjust(tokenId: string, account: Address, delta: BigInt, timestamp: BigInt): i32 {
  const accountId = account.toHexString();
  const id = tokenId + "-" + accountId;

  // Defaults must match loadAccount() in src/factory.ts — either handler can create the entity
  // first, depending on whether the address received tokens before it ever traded.
  let entity = Account.load(accountId);
  if (entity == null) {
    entity = new Account(accountId);
    entity.address = account;
    entity.positionCount = 0;
    entity.tokensCreated = 0;
    entity.tradeCount = 0;
    entity.volumeEth = ZERO;
    entity.firstSeenAt = timestamp;
  }
  entity.lastSeenAt = timestamp;

  let holder = Holder.load(id);
  if (holder == null) {
    holder = new Holder(id);
    holder.token = tokenId;
    holder.account = accountId;
    holder.address = account;
    holder.balance = ZERO;
    holder.firstSeenAt = timestamp;
  }

  const hadPosition = holder.balance.gt(ZERO);
  const wasCounted = isCountable(tokenId, account, holder.balance);

  holder.balance = holder.balance.plus(delta);
  holder.lastSeenAt = timestamp;
  holder.save();

  const hasPosition = holder.balance.gt(ZERO);
  if (!hadPosition && hasPosition) entity.positionCount = entity.positionCount + 1;
  if (hadPosition && !hasPosition) entity.positionCount = entity.positionCount - 1;
  entity.save();

  const isCounted = isCountable(tokenId, account, holder.balance);
  if (!wasCounted && isCounted) return 1;
  if (wasCounted && !isCounted) return -1;
  return 0;
}

function isCountable(tokenId: string, account: Address, balance: BigInt): boolean {
  if (balance.le(ZERO)) return false;
  if (account.equals(BURN_ADDRESS)) return false;
  if (account.equals(ZERO_ADDRESS)) return false;

  // The launchpad's balance is unsold curve inventory, not a position.
  const protocol = Protocol.load(PROTOCOL_ID);
  if (protocol != null && account.equals(Address.fromBytes(protocol.factory))) return false;

  // The Uniswap pair's balance is liquidity, not a position either.
  const token = Token.load(tokenId);
  if (token != null) {
    const pair = token.pair;
    if (pair !== null && account.equals(Address.fromBytes(pair))) return false;
  }

  return true;
}
