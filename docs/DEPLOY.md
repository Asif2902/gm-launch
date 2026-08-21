# Deployment Runbook

End-to-end, in order. Every step is idempotent — safe to re-run.

---

## 0. Prerequisites

| | |
|---|---|
| **Deployer key** | 64 hex characters in `contracts/.env` as `PRIVATE_KEY`, with or without `0x`. |
| **Base Sepolia ETH** | ~0.02 ETH covers a full deploy. [Faucet](https://www.alchemy.com/faucets/base-sepolia). |
| **Graph deploy key** | From [Subgraph Studio](https://thegraph.com/studio). |
| **Turso + R2** *(optional)* | Only for images, descriptions and profiles. |

Check the key and balance before spending anything:

```bash
cd contracts && npx hardhat run scripts/whoami.ts --network baseSepolia
```

> A malformed `PRIVATE_KEY` used to break *every* Hardhat command with an opaque `HH8`. It now
> warns and continues, so `compile` and `test` still work — but network commands will report
> "No account configured" until a real key is set.

---

## 1. Contracts

```bash
cd contracts
npm run build
npm test                                   # 79 tests

DEPLOY_UNISWAP_V2=true npm run deploy:baseSepolia
```

`DEPLOY_UNISWAP_V2=true` deploys **your own** `UniswapV2Factory` — plus `TestUniswapV2Router02`,
the local router stand-in — rather than using the network's canonical deployment. On a testnet
that is sometimes what you want: you own it, nobody can pre-seed pairs against it, and it can't
disappear. The factory bytecode is the genuine `@uniswap/v2-core` factory (solc 0.5.16), not a
reduced re-implementation, so pair behaviour — `MINIMUM_LIQUIDITY`, the exact `mint` maths
migration depends on — matches mainnet.

**On mainnet, leave the flag unset.** The canonical router and factory in `scripts/config.ts` are
used instead.

> The migrator adds liquidity through the canonical `UniswapV2Router02` and resolves the pair
> through the factory registry, so both addresses matter. They must belong to the same Uniswap V2
> deployment: the migrator's constructor asserts `router.factory()` and `router.WETH()` against
> the addresses it is given, and `deploy.ts` checks the same thing beforehand so a mismatch costs
> a script run instead of a deployment.
>
> The flag cannot be used with the canonical Router02, which resolves pairs through a hard-coded
> init-code hash that only matches the canonical factory — that is why it deploys the stand-in
> router. Base Sepolia already hosts a full V2 deployment (router
> `0x1689E7B1F10000AE47eBfE339a4f69dECd19F602`, factory
> `0x7Ae58f10f7849cA6F5fB71b7f45CB416c9204b1e`), which `scripts/config.ts` points at; skip the
> flag to use it and exercise the real router before mainnet.

The script deploys in nonce order so the migrator and launchpad can hold each other as
immutables, then asserts the wiring and 10 protocol constants before writing
`deployments/baseSepolia.json`.

```bash
npm run verify:baseSepolia                 # optional; needs BASESCAN_API_KEY
```

---

## 2. Propagate the deployment

```bash
cd .. && npm run sync
```

Rewrites **only** the deployment-derived keys — secrets and local overrides survive — in:

* `indexer/.env` — `FACTORY_ADDRESS`, `START_BLOCK`, `CHAIN_ID`, `RPC_URL`
* `web/.env.local` — `VITE_*`, and flips `VITE_DEMO_MODE` to `false`
* `subgraph/subgraph.yaml` **and** `subgraph/networks.json`

Doing this by hand is the step that gets half-done, and the failure is quiet: an indexer on the
wrong start block reports "0 tokens", a subgraph on the wrong address returns an empty result set
rather than an error.

---

## 3. Subgraph

```bash
cd subgraph
npm install
npm run auth          # paste the Studio deploy key
npm run build
npm run deploy        # graph deploy dotfun
```

Prompts for a version label (`v0.0.1`, …). If your Studio slug isn't `dotfun`, change it in
`package.json` or run `graph deploy <slug>` directly.

When it finishes, Studio shows a query URL. Put it in `web/.env.local`:

```
VITE_SUBGRAPH_URL=https://api.studio.thegraph.com/query/<id>/dotfun/<version>
```

**This replaces the REST indexer entirely** — no Postgres needed. The header chip will read
"Subgraph".

---

## 4. Indexer *(optional — skip if using the subgraph)*

Only worth running if you want the REST API, a true trailing-24h volume window, or your own
database.

```bash
cd indexer
npm install
createdb pumper
npm run migrate
npm run dev
```

---

## 5. Frontend

```bash
cd web
npm install
npm run dev
```

Optional, for images/descriptions/profiles — set `TURSO_*` and `R2_*` in `web/.env`, then:

```bash
node scripts/check-storage.mjs     # round-trips both; prints no secrets
```

Without them the app still runs; that material falls back to demo fixtures and uploads are
compressed and returned inline rather than stored.

---

## Verify

```bash
npm run check      # contracts tests + indexer typecheck + web typecheck + subgraph build
```

| Check | Where |
|---|---|
| Contracts wired correctly | asserted by `deploy.ts` before it writes the record |
| Subgraph syncing | Studio dashboard → indexing status |
| Frontend on the right source | header chip: Subgraph / Indexer / Demo data |
| Storage live | `GET /api/storage/status` |

---

## Mainnet differences

1. Drop `DEPLOY_UNISWAP_V2` — use the canonical router and factory in `scripts/config.ts`.
2. Set `FEE_RECIPIENT` and `OWNER` to addresses you actually control. The owner's *only* power
   is changing the fee recipient; it cannot touch reserves, trading or migration.
3. `npm run sync -- base`, and `npm run sync -- base` in `subgraph/` for the `base` network.
4. Complete the audit before opening the launchpad to the public.
