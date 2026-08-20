# Architecture

```
                          ┌──────────────────────────────┐
                          │        PumperFactory         │  ← the only address anyone indexes
                          │                              │
   createToken ─────────► │  registry   isLaunchpadToken │
   buy / sell ──────────► │  curve      ethReserve, T    │
   migrate ─────────────► │  fees       accruedFees      │
                          │  migration  status machine   │
                          └───┬──────────────┬───────────┘
                              │              │
              Clones (EIP-1167)              │ IPumperMigrator
                              │              │
                    ┌─────────▼──────┐   ┌───▼──────────────────┐
                    │  PumperToken   │   │  UniswapV2Migrator   │
                    │  1B fixed      │   │  pair + mint + burn  │
                    │  no owner      │   └───┬──────────────────┘
                    └────────────────┘       │
                                             ▼
                                    UniswapV2Factory / Pair
                                    LP ──► 0x…dEaD (permanent)

   events ──► indexer (Postgres + REST)  ──┐
          └─► subgraph (The Graph)      ──┴─► web (React + Vite + wagmi)
                                              └─► also reads the chain directly
```

---

## Contracts

| Contract | Responsibility | Notable properties |
|---|---|---|
| `PumperFactory` | Token creation, registry, bonding curve, trading, fee ledger, migration control, **all events** | `Ownable2Step` + `ReentrancyGuard`. Fee rates, curve constants and the threshold are `constant`; token implementation and migrator are `immutable`. |
| `PumperToken` | The standardized ERC-20 | `ERC20Upgradeable` clone target. No owner, no mint after `initialize`, no hooks, no blacklist. |
| `BondingCurve` | Pure constant-product math | Stateless library. Holds no `k` — it is re-derived from reserves every call, so rounding cannot accumulate. |
| `UniswapV2Migrator` | All Uniswap interaction and the LP burn | Three immutables, no owner, no rescue. Every asset that enters in a call leaves in the same call. |

### Why the factory is one contract

Splitting the registry from the AMM would put `TokenCreated` and `TokenBought` on different
addresses, forcing every indexer to correlate two log streams. Keeping them together means one
`eth_getLogs` filter reconstructs the system. The parts that genuinely reduce risk by being
separate — pure math, the token, the external-protocol boundary — are separate.

### Why the migrator is separate

It is the only component that touches an external protocol. Isolating it means the launchpad
holds no Uniswap assumptions, the AMM surface can be swapped without touching curve or fee logic,
and the LP-burn invariant lives in a contract small enough to read in one sitting.

### The deployment cycle

The launchpad and migrator reference each other as immutables. Rather than adding a setter (an
admin power plus a misconfiguration window), the deploy script predicts the launchpad's CREATE
address from the deployer's nonce and passes it to the migrator first. The launchpad's constructor
then asserts `migrator.launchpad() == address(this)` — a wrong prediction aborts the deployment
instead of producing a broken system.

```
nonce n     PumperToken implementation
nonce n + 1 UniswapV2Migrator  (told the launchpad will land at n + 2)
nonce n + 2 PumperFactory      (verifies the link, reverts on mismatch)
```

---

## State machine

```
        createToken                 buy fills 5 ETH              migrate()
  ∅ ──────────────► Trading ─────────────────────► PendingMigration ──────────► Migrated
        (1)                     (2) trading halts             (3) terminal
                                    atomically
```

No transition is reversible and there is no path back to `Trading`. `migrate()` accepts only
`PendingMigration` and flips to `Migrated` *before* any external call, so a re-entrant or
duplicate call reverts on the status check.

---

## Invariants

| Invariant | Where it is enforced |
|---|---|
| `E · T ≥ k = 5e44`, monotonically non-decreasing | Every rounding step floors in the curve's favour; asserted in `02-curve.test.ts` |
| `ethReserve ≥ 0` for any legal sell | Proved in ECONOMICS §4; guarded explicitly in `sell()` |
| `balance == Σ ethReserve + accruedFees + Σ pendingEth` | `receive()` rejects all but migrator refunds; asserted after every scenario |
| `tokenReserve == launchpad's ERC-20 balance` | The token side has no virtual component |
| `ethReserve == 5e18` exactly at migration | Threshold pinning with refund |
| Pool opening price `==` final curve price | Surplus burn of `Ev0/E = 1/11` (ECONOMICS §6.2) |
| `pair.balanceOf(migrator) == 0` after migration | Asserted inside `migrate()` itself |

---

## Indexer

Two log streams per batch, merged and applied in `(blockNumber, logIndex)` order inside one
transaction:

1. **Factory logs** — protocol events. Token discovery happens here and nowhere else.
2. **`Transfer` logs** for all known tokens — holder balances. Fetched for tokens created inside
   the current range too, so a token's mint and first trades are never missed.

Everything below the "derived" line in the `tokens` table, plus `candles` and `holders`, is a
cache computable from `trades` / `price_points` / `transfers` / `migrations`. That is what makes
reorg recovery a delete-and-rebuild (`src/recompute.ts`) instead of a set of compensating deltas
that can drift.

On boot the indexer reads the protocol constants from the deployed factory and refuses to start if
they disagree with its own — a wrong address or stale ABI fails loudly rather than filling a
database with subtly wrong prices.

---

## Frontend data policy

| Data | Source |
|---|---|
| Trade quotes, slippage floors | **Chain** — `quoteBuy` / `quoteSell`, never local math |
| Reserves, price, status, supply | **Chain** — `getToken`, with the indexer as fallback while the RPC read is in flight |
| History, candles, volume, holders | **Indexer** — derived from events |
| Migration record, LP burn | **Indexer**, cross-checked against `previewMigration` |

Local curve math exists only for optimistic display. Nothing that decides a transaction is
computed in the browser (spec §14).

---

## What is deliberately absent

No pause. No upgrade path. No token rescue. No admin migration override. No fee-rate setter. No
allowlist, blocklist or trading delay. No off-chain metadata that any critical value depends on.
No oracle. No ERC-20 quote assets, and no code path that accepts an ERC-20 as a fee.

The owner can change the fee recipient. That is the complete set of privileged actions, and
`05-security.test.ts` asserts the others are absent from the ABI rather than merely unused.
