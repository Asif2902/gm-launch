# Pumper Subgraph

Covers the same entity model as the custom Node indexer, so either can back the frontend.

| | |
|---|---|
| specVersion | `1.0.0` |
| apiVersion | `0.0.9` |
| network | `base-sepolia` (or `base`) |
| indexerHints | `prune: auto` |

## Deploy to Subgraph Studio

```bash
# 1. Generate the ABIs the mappings decode against
cd ../contracts && npm run build && npm run abis && cd ../subgraph

# 2. Point the manifest at your deployment.
#    Reads contracts/deployments/<network>.json and writes address + startBlock into
#    subgraph.yaml AND networks.json. Never edit those two by hand — they must agree.
npm install
npm run sync                 # or: npm run sync -- base

# 3. Create the subgraph at https://thegraph.com/studio, then authenticate
npm run auth                 # paste the deploy key from Studio

# 4. Build and ship
npm run build
npm run deploy               # graph deploy pumperdotfun
```

`npm run deploy` prompts for a version label (`v0.0.1`, …). If your Studio slug isn't
`pumperdotfun`, change it in `package.json` or run `graph deploy <your-slug>` directly.

Running `npm run sync` from the repo root instead (`npm run sync`) does the same thing *and*
updates the indexer and frontend env files in one step.

### Local graph-node

```bash
npm run create:local
npm run deploy:local
```

## Why `sync` exists

The manifest needs three facts that only a deployment produces — address, start block, network —
and they live in two files that must agree (`subgraph.yaml` and `networks.json`). Getting them
out of step fails *quietly*: a subgraph indexing the wrong address from block 0 doesn't error, it
just returns an empty result set, which is slow to diagnose. So the values are generated, never
typed.

## Structure

| File | Role |
|---|---|
| `subgraph.yaml` | One data source (the factory) plus a `PumperToken` template |
| `schema.graphql` | Protocol, Creator, Token, Trade, PricePoint, Candle, Holder, **Account**, Migration, PlatformFee |
| `src/factory.ts` | All six protocol event handlers |
| `src/token.ts` | ERC-20 `Transfer` → holder balances and `Account` positions |
| `src/constants.ts` | Shared constants and the valuation helper |
| `scripts/sync-deployment.js` | Fills the manifest from a deployment record |

The factory is the **only** static data source: `handleTokenCreated` spawns a `PumperToken`
template per launch, so token discovery needs no address list and no configuration.

`Trade`, `PricePoint` and `PlatformFee` are declared `@entity(immutable: true)` — they are
append-only by nature, and immutable entities skip the write-ahead versioning the store would
otherwise do per update.

## Example queries

Discover feed:

```graphql
{
  tokens(first: 50, orderBy: createdAt, orderDirection: desc) {
    id name symbol status
    price marketCap fullyDilutedValuation
    ethReserve tokenReserve migrationProgressBps
    volumeEth tradeCount holderCount
    creator { id }
    createdAt
  }
}
```

Price chart (5-minute candles):

```graphql
{
  candles(
    where: { token: "0x…", intervalSecs: 300 }
    orderBy: bucketStart
    orderDirection: asc
    first: 500
  ) { bucketStart open high low close volumeEth tradeCount }
}
```

**A user's portfolio** — one query, no client-side knowledge of which tokens to ask about:

```graphql
{
  account(id: "0x…") {
    positionCount
    holdings(where: { balance_gt: "0" }, orderBy: balance, orderDirection: desc) {
      balance
      token { id name symbol price status }
    }
  }
}
```

Migration record with the LP burn:

```graphql
{
  migration(id: "0x…") {
    pair completedAt
    ethDeposited tokensDeposited tokensBurned lpTokensBurned openingPrice
  }
}
```
