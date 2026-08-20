# Pumper Indexer

Continuously running backend that reconstructs the entire launchpad from on-chain events alone.

## What it guarantees

* **Every token is discoverable** by indexing `TokenCreated` from one contract address. No
  deployment scanning, no internal-transaction tracing, no address guessing, no off-chain
  metadata.
* **Historical prices are never simulated.** Each `TokenBought` / `TokenSold` carries the
  post-trade `tokenPrice`, `ethReserve`, `virtualEthReserve` and `tokenReserve`, so a price
  point is a direct read of the log.
* **Replaying a block range is idempotent.** Every event row is keyed on
  `(tx_hash, log_index)`; re-processing inserts nothing and adjusts no aggregate.
* **Reorgs are handled by rebuild, not by compensation.** All cached values derive from event
  rows, so rollback deletes rows above the fork and recomputes (`src/recompute.ts`).

## Setup

```bash
npm install
cp .env.example .env       # set FACTORY_ADDRESS, START_BLOCK, RPC_URL, DATABASE_URL
createdb pumper            # or point DATABASE_URL at an existing database
npm run migrate            # apply db/schema.sql   (npm run reset to drop and recreate)
npm run dev                # indexer + API
```

`FACTORY_ADDRESS` and `START_BLOCK` are printed by `contracts/scripts/deploy.ts` and stored in
`contracts/deployments/<network>.json`.

On boot the indexer reads `TOTAL_SUPPLY`, `VIRTUAL_ETH_RESERVE`, `MIGRATION_THRESHOLD` and both
fee rates from the deployed factory and **refuses to start** if they disagree with its own
constants — a wrong address or a stale ABI fails immediately instead of quietly writing bad
prices.

## Pipeline

```
poll head → safeHead = head - CONFIRMATIONS
  → verify the stored tip hash still matches the chain   (else rollback REORG_DEPTH and rebuild)
  → eth_getLogs on the factory address                   (protocol events, token discovery)
  → eth_getLogs Transfer on all known token addresses     (holder balances, incl. post-migration)
  → sort by (blockNumber, logIndex), apply in ONE transaction
  → advance cursor, store the tip header
```

Transfers are fetched for tokens created *inside the current range* as well, so a token's mint
and its first trades are never missed.

## Entities

`creators` · `tokens` · `trades` · `price_points` · `candles` · `holders` · `transfers` ·
`migrations` · `platform_fees`

Everything below the "derived" line in `tokens`, plus `candles` and `holders`, is a cache
rebuildable from `trades` / `price_points` / `transfers` / `migrations`. See `db/schema.sql`.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness and current cursor |
| GET | `/constants` | Protocol constants + supported candle intervals |
| GET | `/stats` | Global totals, 24 h volume |
| GET | `/tokens` | Discover feed. `?sort=newest\|marketCap\|volume\|progress\|lastTrade&status=&q=&limit=&offset=` |
| GET | `/tokens/:address` | Full token record + migration record |
| GET | `/tokens/:address/trades` | Trade history, keyset paginated via `beforeBlock`/`beforeLogIndex` |
| GET | `/tokens/:address/candles` | OHLCV. `?interval=60\|300\|900\|3600\|14400\|86400` |
| GET | `/tokens/:address/prices` | Raw per-trade tick series |
| GET | `/tokens/:address/holders` | Holder leaderboard with `share_bps` |
| GET | `/tokens/:address/fees` | Platform fees split by buy/sell |
| GET | `/creators/:address` | Creator profile and their launches |
| GET | `/accounts/:address/portfolio` | Holdings valued at the live price, launches, trade activity |
| GET | `/leaderboard` | Trader and creator rankings. `?board=traders\|creators&sort=&window=24h\|7d\|30d\|all&limit=` |

All numeric fields are decimal **strings** — these are uint256 values and JSON numbers would
lose precision. Parse them with `BigInt`.

On `/leaderboard`, flows are windowed but positions are not: volume, trade count and cash in/out
are summed over the window, while `holdings_value` is necessarily current. So `pnl` is a true
profit figure only over `window=all` — the frontend labels that board all-time for exactly this
reason. Only launchpad trades contribute to the flow leg; tokens acquired by transfer or bought
on Uniswap after migration appear in the holdings leg but have no cost basis to offset them.

## Operational notes

* **Provider limits.** Lower `BLOCK_BATCH_SIZE` if `eth_getLogs` responses get rejected. The
  Transfer query chunks token addresses in groups of 200.
* **Backfill.** Set `START_BLOCK` to the factory's deployment block; the indexer catches up at
  `BLOCK_BATCH_SIZE` blocks per request, then switches to `POLL_INTERVAL_MS` polling.
* **Read replicas.** Run extra instances with `API_ONLY=true` to serve the API without a second
  indexing loop.
