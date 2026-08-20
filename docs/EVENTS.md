# Event Reference

Every protocol event is emitted by **`PumperFactory`** — one address, one ABI. This is the entire
indexing surface (spec §6, §7).

Signatures below are the exact strings hardcoded in `indexer/src/abi.ts` and
`subgraph/subgraph.yaml`. `contracts/test/06-indexing.test.ts` asserts the deployed ABI still
matches them, so a contract change can never silently leave a consumer decoding garbage.

---

## Core events

### `TokenCreated`

```solidity
event TokenCreated(
    address indexed token,
    address indexed creator,
    string  name,
    string  symbol,
    uint256 totalSupply,          // always 1e27
    uint256 virtualEthReserve,    // always 0.5e18
    uint256 virtualTokenReserve,  // always 1e27
    uint256 migrationThreshold,   // always 5e18
    uint256 timestamp
);
```

**The only token-discovery mechanism.** Indexing this one event yields every token that will ever
exist. The genesis parameters ride along so an indexer needs no protocol constants hardcoded and
no contract calls to bootstrap.

Genesis price is derivable immediately: `virtualEthReserve * 1e18 / virtualTokenReserve` = `5e8`
wei per whole token.

### `TokenBought`

```solidity
event TokenBought(
    address indexed token,
    address indexed buyer,
    uint256 ethIn,             // gross ETH consumed by the trade (excludes any refund)
    uint256 fee,               // 0.20% of ethIn
    uint256 ethAfterFee,       // ETH that reached the curve  ── this is the volume figure
    uint256 tokensOut,
    uint256 tokenPrice,        // POST-trade spot, wei per whole token
    uint256 ethReserve,        // POST-trade real ETH        ── migration progress
    uint256 virtualEthReserve, // POST-trade 0.5e18 + ethReserve  ── pricing reserve
    uint256 tokenReserve,      // POST-trade tokens left in the curve
    uint256 timestamp
);
```

### `TokenSold`

```solidity
event TokenSold(
    address indexed token,
    address indexed seller,
    uint256 tokensIn,
    uint256 grossEthOut,       // what the curve released ── this is the volume figure
    uint256 fee,               // 0.30% of grossEthOut
    uint256 ethOut,            // what the seller actually received = grossEthOut - fee
    uint256 tokenPrice,
    uint256 ethReserve,
    uint256 virtualEthReserve,
    uint256 tokenReserve,
    uint256 timestamp
);
```

> **Both reserve figures are emitted on purpose.** `ethReserve` is the curve's *real* ETH and is
> what migration progress is measured against; `virtualEthReserve` is the *pricing* reserve
> (`0.5 ETH + ethReserve`). The spec asks for both separately (§3), and emitting both means an
> indexer needs zero knowledge of `VIRTUAL_ETH_RESERVE`.

### `MigrationTriggered`

```solidity
event MigrationTriggered(
    address indexed token, uint256 ethReserve, uint256 tokenReserve, uint256 timestamp
);
```

Emitted inside the buy that fills the curve, in the same transaction as the final `TokenBought`.
Trading is already closed by the time it fires. `ethReserve` is always exactly `5e18`.

### `LiquidityMigrated`

```solidity
event LiquidityMigrated(
    address indexed token,
    address indexed pair,
    uint256 ethAmount,       // ETH deposited into the pool
    uint256 tokenAmount,     // tokens deposited into the pool
    uint256 tokensBurned,    // surplus tokens sent to 0x…dEaD
    uint256 lpTokensBurned,  // LP minted, then sent to 0x…dEaD
    uint256 timestamp
);
```

The pool's opening price is `ethAmount * 1e18 / tokenAmount`, and equals the final curve price by
construction. The LP burn is independently verifiable: `pair.balanceOf(0x…dEaD)` must equal
`lpTokensBurned`.

### `PlatformFeeCollected`

```solidity
event PlatformFeeCollected(
    address indexed token,
    address indexed user,
    uint8   indexed action,  // 0 = buy, 1 = sell
    uint256 amount,
    uint256 timestamp
);
```

`action` is indexed so buy-fee and sell-fee streams can be filtered without decoding data. Fees
also appear as the `fee` field of the trade events; the two must reconcile, which the test suite
checks against the contract's `accruedFees()` accumulator.

---

## Supporting events

| Event | Why an indexer may want it |
|---|---|
| `BuyRefunded(token, buyer, amount, timestamp)` | ETH returned when a buy is capped at the 5 ETH threshold. `TokenBought.ethIn` already excludes it, so it is informational. |
| `EthCredited(account, amount, timestamp)` | A push transfer failed; the amount is claimable via `claimPendingEth()`. |
| `EthClaimed(account, amount, timestamp)` | A pending balance was withdrawn. |
| `FeesWithdrawn(recipient, amount, timestamp)` | Accrued fees were pushed to the fee recipient. |
| `FeeRecipientUpdated(previous, current)` | The only privileged action in the protocol. |

`Transfer(address,address,uint256)` on each **token** is needed for holder balances — curve
events alone miss peer-to-peer sends and all post-migration Uniswap activity.

---

## Reconstruction recipes

**Price series.** Read `tokenPrice` off each trade event, in `(blockNumber, logIndex)` order.
Never simulate the curve. Cross-check with either closed form:

```
tokenPrice == virtualEthReserve * 1e18 / tokenReserve
tokenPrice == virtualEthReserve² * 1e18 / 5e44
```

**Volume.** Sum `ethAfterFee` on buys and `grossEthOut` on sells — both are the curve-side amount,
so buy and sell volume are measured on the same basis.

**Market cap vs FDV.**

```
circulating = totalSupply − tokenReserve − burned
marketCap   = tokenPrice * circulating / 1e18
FDV         = tokenPrice * totalSupply  / 1e18
```

Before migration `burned` is 0. After migration use `LiquidityMigrated.tokensBurned` and take the
price from the Uniswap pair.

**Migration progress.** `ethReserve * 10000 / 5e18`, in basis points, straight from any trade
event.

**Effective execution price.** `ethIn * 1e18 / tokensOut` on a buy (fee included, what the trader
actually paid) and `ethOut * 1e18 / tokensIn` on a sell (fee deducted, what they actually
received).

**Lifecycle.** `TokenCreated` → many `TokenBought`/`TokenSold` → `MigrationTriggered` →
`LiquidityMigrated`. Status is `1` after creation, `2` after the trigger, `3` after migration; no
other transitions exist and none are reversible.

---

## Ordering and idempotency

Events are totally ordered by `(blockNumber, logIndex)`. Within the migrating transaction the
order is: final `TokenBought` → `PlatformFeeCollected` → `MigrationTriggered`.
`LiquidityMigrated` comes later, in whichever transaction calls `migrate()`.

`(transactionHash, logIndex)` is a unique key for every event, so replaying a block range is
idempotent — which is what makes reorg recovery a delete-and-rebuild rather than a set of
compensating adjustments.
