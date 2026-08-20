# Pumper.fun — Bonding Curve Economics

> **This document is normative.** Every constant and formula in the Solidity sources is derived
> here. Spec §15 requires the curve, virtual liquidity and migration mechanism to be
> mathematically coherent *before* implementation — this is that derivation.

Network: **Base Sepolia** (chainId `84532`). Quote asset: **ETH only**.

---

## 1. Constants

| Symbol | Name | Value |
|---|---|---|
| `S` | `TOTAL_SUPPLY` | `1_000_000_000e18` = `1e27` base units |
| `Ev0` | `VIRTUAL_ETH_RESERVE` | `0.5 ether` = `5e17` wei |
| `Tv0` | `VIRTUAL_TOKEN_RESERVE` | `1e27` base units (= `S`) |
| `k` | curve invariant | `Ev0 · Tv0` = `5e17 · 1e27` = **`5e44`** |
| `M` | `MIGRATION_THRESHOLD` | `5 ether` = `5e18` wei of **real, post-fee** ETH |
| — | `BUY_FEE_BPS` | `20` (0.20 %) |
| — | `SELL_FEE_BPS` | `30` (0.30 %) |
| — | `BPS_DENOMINATOR` | `10_000` |

`k = 5e44` sits far below `uint256` overflow (`~1.16e77`), and the largest intermediate
product in the trade math is `T · net ≈ 1e27 · 5e18 = 5e45`. No overflow is reachable;
Solidity 0.8 checked arithmetic is the backstop.

### Why the token reserve has no "virtual" component

The curve is seeded with the **entire** 1 B supply as real, sellable inventory, so at every
point in time:

```
virtualTokenReserve == tokenReserve == the launchpad's actual ERC-20 balance for that token
```

The **only** virtual component is `0.5 ETH` on the ETH side. This is deliberate: it means the
token reserve is never a number that has to be reconciled against a real balance, which removes
an entire class of accounting bugs and makes the indexer's job trivial. Both fields are still
exposed separately (spec §3) — they are simply equal by construction.

---

## 2. State and the invariant

Per token the launchpad stores exactly two mutable numbers (plus flags):

| Variable | Meaning |
|---|---|
| `e` = `ethReserve` | **Real** ETH held by the curve, net of platform fees. Starts at `0`. |
| `T` = `tokenReserve` | Tokens remaining in the curve. Starts at `Tv0 = 1e27`. |

The **effective** ETH reserve used for pricing is derived, never stored:

```
E = Ev0 + e            (virtualEthReserve)
```

**Invariant:**

```
E · T = k = 5e44
```

Held exactly in real arithmetic; under integer arithmetic every rounding step is floored in the
curve's favour, so `E·T` weakly *increases*. It never decreases, therefore the curve can never
be drained below its obligations.

### Spot price

Price is quoted in **wei per whole token** (no extra scaling factor — the `1e18` below only
converts base units to whole tokens):

```
P = E · 1e18 / T
```

Two closed forms fall out of the invariant, and both are useful to the indexer as cheap
consistency checks:

```
P    = E² · 1e18 / k          (price from the ETH reserve alone)
FDV  = E² / Ev0               (fully diluted valuation, in wei)
sold = S · e / E              (tokens sold so far)
```

At genesis: `P₀ = 5e17 · 1e18 / 1e27 = 5e8` wei = `5e-10` ETH per token, and
`FDV₀ = (5e17)²/5e17 = 5e17` wei = **0.5 ETH** — the market cap of a fresh token equals its
virtual ETH reserve, exactly as it should.

---

## 3. Buy

Input `gross = msg.value`. Fee basis is stated explicitly (spec §4: *"do not obscure the fee
inside an unexplained calculation"*):

> **The buy fee is 0.20 % of the ETH *input*.** It is skimmed off `msg.value` before the ETH
> touches the curve. The buyer's tokens are priced off the post-fee amount.

```
fee = gross · 20 / 10_000
net = gross − fee
```

Then the constant-product swap:

```
tokensOut = T · net / (E + net)          [floored]

E += net        (i.e. e += net)
T -= tokensOut
```

**Invariant check.** `(E+net)·(T − T·net/(E+net)) = (E+net)·T·(E+net−net)/(E+net) = E·T = k` ✔

### Threshold pinning (partial fill + refund)

A buy that would push `e` past `M` is **partially filled** so that `e` lands on exactly
`5.000000000000000000 ETH`, and the unused ETH is refunded to the buyer:

```
netAllowed = M − e
if (net > netAllowed):
    net    = netAllowed
    gross' = ceil(net · 10_000 / 9_980)      // re-derive the gross that yields exactly `net`
    fee    = gross' − net
    refund = gross − gross'
```

This is what makes migration state **deterministic**: `e` is *always* exactly `5e18` at
migration, never an overshoot that varies with whoever happened to trade last. Every token in
the system migrates from an identical, reproducible reserve state.

---

## 4. Sell

> **The sell fee is 0.30 % of the ETH *output*.** If the curve owes the seller `X` ETH, the
> seller receives `X − 0.30 %·X`. (Spec §4, verbatim requirement.)

```
grossEthOut = E · tokensIn / (T + tokensIn)      [floored]
fee         = grossEthOut · 30 / 10_000
ethOut      = grossEthOut − fee                  // what the seller actually receives

E -= grossEthOut     (i.e. e -= grossEthOut)
T += tokensIn
```

**Invariant check.** `(E − E·tokensIn/(T+tokensIn))·(T+tokensIn) = E·(T+tokensIn−tokensIn) = E·T = k` ✔

Note the curve's ETH drops by the **gross** amount: the fee leaves the curve too, it is just
routed to the fee accumulator instead of to the seller. The alternative (charging the fee
against the seller's proceeds while leaving it inside the curve) would break the invariant.

### Solvency theorem — `e` can never go negative

The curve must never promise ETH it does not hold. Proof:

1. Tokens outside the curve are exactly `S − T` (the launchpad mints the full supply to itself
   at creation, and no tokens are burned before trading stops).
2. Therefore any sell satisfies `tokensIn ≤ S − T`, so `T + tokensIn ≤ S = Tv0`.
3. After the sell, `E' = k / (T + tokensIn) ≥ k / Tv0 = Ev0`.
4. Hence `e' = E' − Ev0 ≥ 0`. ∎

The 0.5 ETH of virtual liquidity is *never* payable — it is a price anchor, not a liability.
This is the property that lets the launchpad hold real ETH for many tokens in one contract
without cross-token insolvency.

---

## 5. Fees

* Accumulated **in ETH only**. The protocol has no code path that accepts an ERC-20 as a fee.
* Fee rates are `immutable`/`constant` — there is no admin function to change them.
* Every fee is emitted explicitly in `PlatformFeeCollected(token, user, action, amount, ts)`
  with `action = 0` for buy and `action = 1` for sell, *and* duplicated as the `fee` field of
  `TokenBought` / `TokenSold` so an indexer can reconcile from either stream.
* Fees are held in the launchpad's balance under a separate `accruedFees` counter and are never
  commingled with curve reserves. `withdrawFees()` is permissionless and can only push to the
  configured `feeRecipient`.

**Gross ETH required to migrate.** With no intervening sells, buyers must spend

```
grossTotal = M / (1 − 0.002) = 5 / 0.998 = 5.010020040080160320… ETH
```

of which **0.010020040080160320 ETH** is platform buy fees. Sells increase this figure (a sell
returns `e` downward while charging a further 0.30 %).

---

## 6. Migration — exact numbers

Trigger: `e` reaches `M = 5e18`. Because of threshold pinning this is an equality, always.

### 6.1 Curve state at the moment trading stops

```
e_final = 5.000000000000000000 ETH
E_final = Ev0 + e_final = 5.5e18 wei                       = 5.5 ETH
T_final = k / E_final   = 5e44 / 5.5e18
        = 90_909_090_909_090_909_090_909_090 base units
        = 90,909,090.909090909090909090 tokens             (9.0909 % of supply)

tokensSold = S − T_final = 909,090,909.090909… tokens      (90.9091 % of supply)
P_final    = E_final · 1e18 / T_final = 6.05e10 wei/token  = 6.05e-8 ETH
FDV_final  = E_final² / Ev0 = 6.05e19 wei                  = 60.5 ETH
```

> **Implementation note.** The contract uses the **actual stored `tokenReserve`**, not a
> recomputed `k / E_final`. Accumulated flooring may leave `T_final` a few base units *above*
> the ideal value; using the real balance keeps token accounting exact and prevents the
> migration from trying to move tokens it does not hold.

### 6.2 Why a surplus burn is required

Only the **real** 5 ETH can be deposited into Uniswap — the 0.5 ETH of virtual liquidity does
not exist. If the full `T_final` were paired against 5 ETH, the pool would open at

```
5e18 · 1e18 / T_final = 5.5e10 wei/token
```

which is `10/11` of `P_final` — a **9.09 % instantaneous gap down**, borne entirely by the last
buyers on the curve. That is an incoherent design, and spec §15 asks precisely for the
comparison between "price users receive immediately before migration" and "price the Uniswap V2
pool starts at".

The fix is to deposit only the tokens that make the pool open at exactly `P_final`, and burn the
surplus:

```
T_pool = e_final · T_final / E_final = T_final · 10/11
       = 82_644_628_099_173_553_719_008_264 base units
       = 82,644,628.099173553719008264 tokens

T_burn = T_final − T_pool = T_final / 11
       = 8_264_462_809_917_355_371_900_826 base units
       = 8,264,462.809917355371900826 tokens               (0.826 % of supply)
```

**Verification:** `5e18 · 1e18 / 82_644_628_099_173_553_719_008_264 = 6.05e10` wei/token — identical
to `P_final`. ✔ **There is no price gap at migration.**

The burn fraction is exactly `Ev0 / E_final = 0.5/5.5 = 1/11`, i.e. the surplus is precisely the
share of the curve's inventory that was backed by *virtual* rather than real ETH. Nothing is
confiscated; the phantom liquidity is retired along with the tokens it was pricing.

### 6.3 Post-migration state

```
Uniswap V2 pool:      5 ETH  ·  82,644,628.099… tokens   @ 6.05e-8 ETH/token
LP tokens:            100 % burned to 0x…dEaD (minus the pair's 1000-wei MINIMUM_LIQUIDITY,
                      which UniswapV2Pair locks at address(0) on first mint — also unrecoverable)
Circulating supply:   1e27 − T_burn = 991,735,537.190082644628099174 tokens
Market cap at open:   991,735,537.19… · 6.05e-8 ETH = 60.00 ETH
Curve:                e = 0, T = 0, state = Migrated, trading permanently disabled
```

### 6.4 Price / valuation trajectory

`T = k/E`, `P = E²·1e18/k`, `FDV = E²/Ev0`:

| Real ETH `e` | `E` | Tokens left `T` | Price (wei/token) | Price (ETH) | FDV (ETH) | Progress |
|---:|---:|---:|---:|---:|---:|---:|
| 0.0 | 0.5 | 1,000,000,000 | 5.00e8 | 5.00e-10 | 0.5 | 0 % |
| 0.5 | 1.0 | 500,000,000 | 2.00e9 | 2.00e-9 | 2.0 | 10 % |
| 1.0 | 1.5 | 333,333,333 | 4.50e9 | 4.50e-9 | 4.5 | 20 % |
| 2.0 | 2.5 | 200,000,000 | 1.25e10 | 1.25e-8 | 12.5 | 40 % |
| 3.0 | 3.5 | 142,857,143 | 2.45e10 | 2.45e-8 | 24.5 | 60 % |
| 4.0 | 4.5 | 111,111,111 | 4.05e10 | 4.05e-8 | 40.5 | 80 % |
| 5.0 | 5.5 | 90,909,091 | 6.05e10 | 6.05e-8 | 60.5 | 100 % |

A token appreciates **121×** from genesis to migration (`0.5 → 60.5 ETH` FDV).

### 6.5 Migration progress

```
progress = e / M          (basis points: e · 10_000 / 5e18)
```

Derivable from any `TokenBought` / `TokenSold` event without contract calls, since both emit
`ethReserve` (= `e`) directly.

---

## 7. Answers to spec §15, itemised

| Question | Answer |
|---|---|
| How much ETH is actually held by the curve at migration? | Exactly **5.000000000000000000 ETH**, guaranteed by threshold pinning. |
| How does virtual liquidity affect the price? | Adds `Ev0` to the price numerator: `P = (Ev0+e)²·1e18/k`. It sets the genesis price at `0.5 ETH / 1 B` and fixes the migration burn fraction at `Ev0/E_final = 1/11`. |
| How many tokens remain? | `90,909,090.909090909090909090` (9.0909 % of supply). |
| Exact token/ETH ratio deposited into Uniswap V2? | `82,644,628.099173553719008264 tokens : 5 ETH` → `6.05e-8 ETH/token`. |
| Price users receive immediately before migration? | `6.05e10` wei/token (`6.05e-8` ETH). |
| Price the Uniswap V2 pool starts at? | `6.05e10` wei/token — **identical, by construction** (§6.2). |
| How do platform fees affect the curve? | They live entirely outside the invariant `k`. Buy fees reduce the ETH entering the curve (so `5.01002…` ETH gross is needed to reach a `5` ETH reserve); sell fees are carved out of the curve's gross payout. Fees are never part of `E`, `T` or `k`. |
| Does "5 ETH" mean gross collected or ETH remaining after fees? | **Net.** The threshold is measured on `e`, the real ETH *held by the curve* after buy fees. Gross buyer spend to reach it is `5.010020040080160320` ETH. |

---

## 8. Rounding policy

| Operation | Direction | Rationale |
|---|---|---|
| `tokensOut` on buy | floor | Curve keeps the dust; `k` weakly increases. |
| `grossEthOut` on sell | floor | Curve keeps the dust; `k` weakly increases. |
| `gross'` on a pinned buy | **ceil** | Guarantees `net` after fee is at least the amount credited; never under-charges. |
| `fee` | floor | Favours the user by at most 1 wei. |
| `T_pool` at migration | floor | Surplus rolls into the burn; the pool never receives more than the ratio allows. |

Every rounding decision either favours the protocol's solvency or the user by ≤ 1 wei. None can
compound: `k` is re-derived from stored reserves on every trade, never accumulated from deltas.

---

## 9. Determinism guarantees for the indexer

1. Every trade emits `ethReserve`, `virtualEthReserve`, `tokenReserve` and `tokenPrice`
   **after** the trade is applied. Historical price never requires curve simulation.
2. All constants above are `public constant` on the factory, so an indexer can bootstrap
   without hardcoding anything.
3. Migration state is identical for every token, so `T_pool`, `T_burn` and the opening pool
   price are known ahead of time and can be asserted by the indexer against
   `LiquidityMigrated`.
4. `P = E²·1e18/k` lets an indexer cross-check any emitted `tokenPrice` from the reserves in
   the same event, catching corrupted RPC data.
