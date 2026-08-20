# gm Launch

A token launchpad on **Base**: launch a token with nothing but a name and a ticker, trade it on a
constant-product bonding curve, and watch it graduate to Uniswap V2 at 5 ETH with the LP tokens
permanently burned.

Every package defaults to Base mainnet (chain id 8453). Base Sepolia remains available for
testing — set `CHAIN_ID` / `VITE_CHAIN_ID` to 84532 and deploy with `npm run deploy:baseSepolia`.

The whole system is built around one requirement:

> A continuously running backend can discover every token and reconstruct every token's price,
> trades, volume, reserves, market cap and migration status from standardized on-chain events —
> no scraping, no deployment scanning, no transaction tracing.

That requirement is not a claim in a README; it is enforced by
[`contracts/test/06-indexing.test.ts`](contracts/test/06-indexing.test.ts), which hands a
miniature indexer nothing but `eth_getLogs` output and asserts the state it derives matches the
chain exactly.

---

## Layout

| Package | What it is |
|---|---|
| [`contracts/`](contracts) | Solidity, Hardhat tests, deploy scripts, generated ABIs |
| [`indexer/`](indexer) | Node/TypeScript event indexer + Postgres schema + REST API |
| [`subgraph/`](subgraph) | The Graph subgraph covering the same entity model |
| [`server/`](server) | Express API for the off-chain layer — profiles, token details, image upload, ETH price |
| [`web/`](web) | React + Vite frontend — terminal, token page, create, leaderboard, bridge, profiles |
| [`docs/`](docs) | [Economics](docs/ECONOMICS.md) · [Architecture](docs/ARCHITECTURE.md) · [Events](docs/EVENTS.md) · [Deploy runbook](docs/DEPLOY.md) |

**Read [`docs/ECONOMICS.md`](docs/ECONOMICS.md) first.** Every constant in the contracts is
derived there, including the exact reserve state at migration and why a portion of the supply is
burned when liquidity moves to Uniswap.

---

## The protocol in one screen

```
createToken(name, symbol)
   └─ EIP-1167 clone of PumperToken, 1,000,000,000 fixed supply minted to the launchpad
   └─ curve seeded with 0.5 ETH virtual + 1B real tokens      k = E · T = 5e44

buy(token, minTokensOut, deadline)     0.20% fee on ETH in
sell(token, amount, minEthOut, deadline)   0.30% fee on gross ETH out

   price = E · 1e18 / T          (wei per whole token)
   E     = 0.5 ETH + realEthReserve

when realEthReserve reaches exactly 5 ETH
   └─ trading halts atomically, MigrationTriggered
   └─ migrate() — permissionless
        ├─ 82,644,628.099… tokens + 5 ETH → new Uniswap V2 pair
        ├─ 8,264,462.809… tokens burned so the pool opens at the final curve price
        └─ 100% of LP minted → 0x…dEaD, asserted in the same call
```

| | |
|---|---|
| Supply | 1,000,000,000 · fixed · no minting after deploy |
| Virtual liquidity | 0.5 ETH (the token side is entirely real) |
| Quote asset | ETH only — no ERC-20 pairs, no token-to-token swaps |
| Buy fee | 0.20% of ETH **input** |
| Sell fee | 0.30% of gross ETH **output** — receive X, get X − 0.30%·X |
| Migration | 5 ETH of **real, post-fee** ETH held by the curve |
| Genesis valuation | 0.5 ETH FDV → 60.5 ETH at migration (**121×**) |
| Admin powers | changing the fee recipient. That is the entire list. |

---

## Quick start

```bash
npm run install:all                 # all four packages
npm run test:contracts              # 67 tests

# deploy + wire every package from the one deployment record
cd contracts && cp .env.example .env    # PRIVATE_KEY, BASE_RPC_URL
cd .. && npm run deploy:base            # deploys to Base mainnet, then runs `npm run sync`

npm run dev:indexer                 # needs Postgres; npm --prefix indexer run migrate first
npm run dev:server                  # off-chain API on :4100 (Turso + R2 creds in server/.env)
npm run dev:web                     # http://localhost:5174, proxies /api to :4100
```

### One source of truth for wiring

A deployment produces three facts — factory address, deployment block, chain id — that four
packages need in four different formats. Copying them by hand is the step that gets half-done,
and the failure is *quiet*: an indexer on the wrong start block reports "0 tokens", a frontend on
a stale address renders an empty feed, a subgraph on the wrong address returns an empty result
set rather than an error.

```bash
npm run sync            # or: npm run sync:local
```

reads `contracts/deployments/<network>.json` and rewrites **only** the deployment-derived keys in
`indexer/.env`, `web/.env.local`, `subgraph/subgraph.yaml` and `subgraph/networks.json`. Secrets
and local overrides in those files are preserved.

| Command | Does |
|---|---|
| `npm run check` | contracts tests + indexer typecheck + web typecheck + subgraph build |
| `npm run build:all` | builds all four packages |
| `npm run abis` | regenerates ABIs consumed by indexer, subgraph and web |
| `npm run storage:check` | round-trips Turso + R2 (prints no secrets) |

**Want to see the UI right now?** Skip steps 1 and 2 — set `VITE_DEMO_MODE=true` in
`web/.env.local` and run `npm run dev`. The app runs against a simulated launchpad of 28 tokens
that executes the *real* bonding-curve arithmetic, so charts, graduations and every derived
figure match `docs/ECONOMICS.md` exactly. See [`web/README.md`](web/README.md).

Everything also runs fully locally — `npm run deploy:local` deploys a WETH9 stand-in and a real
`UniswapV2Factory` alongside the protocol, so the migration path works without a testnet.

### External dependencies (verified live on-chain)

**Base mainnet** — checked against the chain: the factory answers `allPairsLength()` (3,044,175
pairs at time of writing) and WETH answers `symbol() == "WETH"`.

| | Address |
|---|---|
| UniswapV2Factory | [`0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6`](https://basescan.org/address/0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6) |
| WETH9 | [`0x4200000000000000000000000000000000000006`](https://basescan.org/address/0x4200000000000000000000000000000000000006) |

**Base Sepolia**

| | Address |
|---|---|
| UniswapV2Factory | [`0x7Ae58f10f7849cA6F5fB71b7f45CB416c9204b1e`](https://sepolia.basescan.org/address/0x7Ae58f10f7849cA6F5fB71b7f45CB416c9204b1e) |
| WETH9 | [`0x4200000000000000000000000000000000000006`](https://sepolia.basescan.org/address/0x4200000000000000000000000000000000000006) |

Both were checked on-chain before wiring: the factory answers `allPairsLength()` and is the
`factory()` of the canonical Router02; WETH answers `symbol() == "WETH"`. The deploy script
re-checks that code exists at each address and aborts otherwise.

---

## Design decisions worth knowing

**One contract emits everything.** `PumperFactory` is the factory, registry, AMM, fee ledger and
migration controller. An indexer subscribes to a single address and a single ABI. The pieces that
genuinely benefit from isolation are separate: curve math is a pure library, the token is its own
standardized implementation, and all Uniswap interaction sits behind `IPumperMigrator`.

**The token side of the curve has no virtual component.** The full 1 B supply is real, sellable
inventory, so `tokenReserve` is always exactly the launchpad's ERC-20 balance. Only ETH carries a
virtual 0.5. This removes a whole class of reconciliation bugs.

**Migration lands on exactly 5 ETH, always.** A buy that would overshoot is partially filled and
the remainder refunded, so every token in the system graduates from a byte-identical reserve
state. No indexer ever has to handle a variable overshoot.

**The Uniswap pool opens at the final curve price.** Only the real 5 ETH can be deposited, so
pairing it against the full remaining inventory would open the pool 9.09% *below* the last curve
price — an instant loss for the final buyers. Instead exactly `Ev0/E = 1/11` of the remaining
tokens are burned, and the pool opens at precisely `6.05e-8 ETH`. Derived in
[ECONOMICS §6.2](docs/ECONOMICS.md).

**No router.** Liquidity is added by transferring both assets to the pair and calling `mint`
directly. `UniswapV2Router02` derives pair addresses from a hardcoded init-code hash that only
matches the canonical deployment; using `factory.getPair` instead works against any V2-compatible
factory and removes a contract from the trust set.

**Pre-seeded pairs cannot be used to steal the deposit.** Anyone can create the pair and seed it
with dust at an absurd ratio before migration. Depositing blindly would mint LP against the worse
side and donate the excess to the squatter. The migrator instead deposits strictly at the
existing ratio, burns the surplus tokens and returns surplus ETH. Reverting was rejected: it would
let anyone permanently block a migration for the price of one dust transfer.
([test](contracts/test/04-migration.test.ts))

**Failed ETH transfers never brick a trade.** Push transfers are gas-capped and fall back to a
`pendingEth` credit; the pull path forwards full gas so contract wallets can always recover.

**Off-chain material stays off-chain, and can't lie about on-chain facts.** Token pictures,
descriptions, social links and user profiles live in Turso + Cloudflare R2, because the contracts
deliberately have no metadata fields, no owner and no admin. Uploads are re-encoded through sharp
(5 MB cap enforced before decode, EXIF stripped, WebP out) and every write is gated on a wallet
session — one signature when the wallet connects mints an HMAC bearer token that slides forward
while you use the site (12h idle, 7d hard cap) and never prompts again in between, and each write
is still checked against ownership on top of it: profile edits by the profile's
owner, token edits by the address the *launchpad* reports as creator. A profile's portfolio is
derived from `Transfer` logs and is not editable by anyone: you can style your page, you cannot
misrepresent your holdings. Whatever identity a wallet sets follows it across the ticker, the
leaderboard and every card, batched into one lookup per view. See
[`web/README.md`](web/README.md).

**Colour is not the only signal.** The conventional green/red trade palette fails colourblind
separation once both hues sit in a readable lightness band (deutan ΔE ≈ 4, against a floor of 8).
The UI uses a validated green/orange pair (deutan ΔE 11.3) and always pairs it with a text label,
on a Base Blue `#0052FF` accent.

---

## Verification status

| | |
|---|---|
| Contracts compile (solc 0.8.24 + 0.5.16) | ✅ |
| **67 Hardhat tests passing** | ✅ |
| Migration tested against genuine `@uniswap/v2-core` bytecode | ✅ |
| Deploy script executed end-to-end (local) with post-deploy assertions | ✅ |
| Event-only state reconstruction | ✅ |
| Indexer typechecks | ✅ |
| Subgraph compiles to WASM (`graph build`) | ✅ |
| Frontend production build | ✅ |
| Frontend rendered and inspected in a browser (demo mode) | ✅ |
| Turso + R2 connectivity round-tripped (`web/scripts/check-storage.mjs`) | ✅ |
| Indexer run against a live database | ⚠️ not executed — no Postgres in this environment |
| Base Sepolia deployment | ⚠️ not executed — needs a funded `PRIVATE_KEY` |

---

## Security posture

Reentrancy guards plus strict checks-effects-interactions on every state-changing path;
`SafeERC20` everywhere; solc 0.8 checked arithmetic; two-step ownership; immutable fee rates,
curve constants and migration threshold; no pause, no upgrade, no rescue, no blacklist, no
force-migrate. Migration flips status to `Migrated` before any external call, making double
migration impossible. The launchpad rejects stray ETH so
`balance == Σ ethReserve + accruedFees + Σ pendingEth` holds at all times — asserted after every
scenario in the test suite.

The tokens themselves have no owner, no mint after initialization, no transfer hooks or taxes, no
blacklist, and no trading restriction that could act as a honeypot. `contracts/test/01-creation.test.ts`
asserts those functions are absent from the ABI rather than merely unused.

An audit is planned before launch. Until it lands, treat the deployed addresses as unreviewed
code holding real funds and size positions accordingly.
