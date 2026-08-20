# gm Launch — web

React + Vite + React Router frontend for the gm Launch launchpad, themed on Base.

```bash
npm install
cp .env.example .env.local     # VITE_FACTORY_ADDRESS, VITE_SUBGRAPH_URL
npm run dev                    # http://localhost:5174
```

This is a pure static SPA — the build is HTML, CSS and JS, deployable to any static host. Anything
needing a secret (Turso, R2, the ETH price cache) lives in the separate [`server/`](../server)
package, because **only `VITE_`-prefixed variables exist in this bundle and every one of them is
public**. In development `vite.config.ts` proxies `/api` to that server on `:4100`, so client code
is identical in dev and production; in production point `VITE_API_BASE` at the deployed origin.

Any unknown path must serve `index.html` for client-side routing to work — `vercel.json`,
`_redirects`, or `try_files $uri /index.html` depending on the host.

## Demo mode

The app is fully explorable with **no deployment and no indexer**. Set:

```bash
VITE_DEMO_MODE=true
```

**That flag is the only thing that turns it on.** An earlier version engaged demo mode
automatically on the first failed request, which sounds forgiving and is the worst of both
worlds: a real deployment with a momentarily unreachable subgraph would quietly replace its
market with invented tokens, invented prices and invented trades. A chip in the corner is not
enough of a disclaimer for that, and the failure it masked — a misconfigured endpoint — is
exactly the one you need to see immediately.

A failing source now fails: queries reject and the page says it could not load, naming the
endpoint that did not answer.

Demo data comes from `src/lib/mock.ts`, a simulated launchpad of 28 tokens. It is not decorative
noise: every token is walked through the **real** bonding-curve arithmetic from
`BondingCurve.sol` — same constant product, same 0.5 ETH virtual reserve, same 0.20%/0.30% fees,
same threshold pinning at 5 ETH, same 1/11 surplus burn at migration. Charts therefore show
genuine curve behaviour, and graduated tokens land on exactly the values derived in
`docs/ECONOMICS.md §6`:

| | Derived | Rendered |
|---|---|---|
| Opening price | `6.05e10` wei/token | 60.50 gwei |
| ETH into pool | 5 ETH | 5 ETH |
| Tokens into pool | 82,644,628.099… | 82.64M |
| Tokens burned | 8,264,462.809… | 8.26M |
| Market cap at open | 60.0 ETH | 60 ETH |

A background ticker executes a trade every ~2.6s so the feed, ticker and charts move.

## Pages

| Route | Contents |
|---|---|
| `/` | **Terminal** — a trending strip, then the grid: name, symbol, creator, 24h change, 24h volume, holders, market cap, curve progress, migration status. Sort by latest trade / market cap / 24h volume / newest / graduating; filter by status; search name, ticker or address. |
| `/leaderboard` | **Leaderboard** — traders ranked on volume, activity and PnL; creators on what they launched and what graduated. |
| `/bridge` | **Bridge** — the LI.FI widget, themed to this palette, opening on ETH → Base. |
| `/token/:address` | **Token page** — price chart, buy and sell panels, live trade feed, holder leaderboard, migration status, full curve state. |
| `/create` | **Create** — token name, ticker, one button, with a live preview. |
| `/u/:handle` | **Profile** — avatar, handle, bio and links, plus holdings and launches derived from chain events. |

There is no hero on the feed. A launchpad's landing page is a market, and a screen of marketing
copy above the market is a screen of tokens you cannot see; the protocol's terms live in the
footer and on the create page, where someone is actually deciding to use them.

### Leaderboard

What the two data sources can answer differs, and the page renders only what the answering source
supports rather than labelling one thing as another:

* **REST indexer** — has the raw trades, so it windows them (24h / 7d / 30d / all) and derives a
  PnL: realised cash flow plus the current value of open positions.
* **Subgraph** — `Account` carries lifetime volume and trade counts but no per-side cash flow and
  no time buckets. It gets no window pills and no PnL column; an inert "24h" tab showing all-time
  numbers would be worse than not offering one.

PnL is only a true profit figure over the all-time window — over 24h it would credit an account
for a position bought last month — so selecting it switches the window to all-time.

## Typography

Two self-hosted variable families, split by job. **Space Grotesk** (`font-display`) carries names,
tickers and every figure a trader reads at a glance — geometric, with tall open numerals that stay
distinct compressed into a card. **Inter** (`font-sans`) carries prose, where Space Grotesk gets
tiring at paragraph length. Both ship as `@fontsource-variable` packages rather than a Google
Fonts link: this is a static SPA that should deploy anywhere and make no third-party request on
load, and a variable font covers the whole weight range in one file.

`.tnum` pins figures to the display face with tabular numerals, so a price does not jitter
sideways as its digits change.

## Cards

The feed is image-first: a square cover is the largest element on every card, with everything else
below it in reading order — ticker, name, description, how it is moving, who made it, and finally
market cap and curve progress. An earlier version led with a 42px avatar beside a column of
figures, which made every token look like every other token; the picture is the thing that
distinguishes a launch, so it gets the space.

The frame is square rather than 4:3 because that is the shape people upload — a square frame shows
a logo whole instead of cropping or letterboxing it. Only the status badge sits on the artwork;
text lives underneath, where it is legible whatever was uploaded.

The strip along the bottom pairs **market cap now with market cap at its peak**. One number alone
says nothing about a memecoin: $28K is a fresh launch or a corpse depending entirely on whether it
was ever $3M. The progress bar runs flush to the card's edges beneath them, so a row of cards
compares as a set of fill lines rather than a column of percentages.

`ath_market_cap` is optional in the token type. It was added after the first release, so a
deployment on an older indexer or subgraph simply will not send it and the card shows `—` rather
than a wrong zero — see **All-time high** below.

## Guarding against the wrong chain

`subgraphApi` refuses to read from a subgraph that indexes a different factory than
`VITE_FACTORY_ADDRESS`. The check runs once per session against the `Protocol` entity and throws
`SubgraphMismatchError` on a mismatch.

This exists because of a failure that is trivial to cause and very hard to spot: migrating the app
to a new chain while `VITE_SUBGRAPH_URL` still points at the old deployment. Every query succeeds,
the data looks entirely plausible, and the app confidently renders a market that has nothing to do
with the chain named in its own header — testnet tokens on a mainnet site.

A subgraph that has not indexed anything yet has no `Protocol` entity; that is a fresh deployment
catching up, not a mismatch, and is allowed through.

Separately, a zero `VITE_FACTORY_ADDRESS` means nothing has been deployed at all. The data pages
short-circuit to a "no launchpad deployed yet" panel naming the deploy command, rather than firing
queries that cannot succeed and reporting them as an outage.

## All-time high

A high-water mark maintained in three places, all of which must agree:

* **Indexer** — `tokens.ath_market_cap`, advanced with `GREATEST(...)` on every trade. Run
  `npm --prefix indexer run migrate` to add the column to an existing database; the `ALTER TABLE
  ... IF NOT EXISTS` makes that a no-op afterwards.
* **Subgraph** — `Token.athMarketCap`. **This needs a redeploy** before all-time highs appear on
  a subgraph-backed deployment. Until then the client detects the missing field, drops it from the
  query and carries on — asking an older subgraph for an unknown field would otherwise fail *every*
  token query and drop the session into the simulation.
* **Simulation** — tracked on both sides of the curve, and demo tokens are deliberately walked
  past their target and sold back down to it, so ATH sits above MC the way it does on a real chart.

The one subtlety is reorgs: `GREATEST` never decreases, which is correct while the chain moves
forward and wrong the moment a rollback removes the trades that set the high. `recomputeToken`
therefore rebuilds it from the surviving `price_points`, keeping it a derived value like
everything else below the schema's "derived" line.

## Bridge

`/bridge` embeds the [LI.FI widget](https://docs.li.fi/widget/install-widget) rather than building
a bridge. Route discovery across dozens of chains and bridges, quote comparison, allowances,
execution, and recovery when a transfer stalls mid-flight are the actual product; the work here is
making it look like it belongs.

* It detects the app's existing `WagmiProvider`, so a wallet already connected in the header
  carries straight over. It **keeps its own wallet menu**, though: bridging starts on the source
  chain, and the header's connect button targets the launchpad's chain — the destination. Hiding
  LI.FI's menu left no way to connect to the chain you are bridging *from*, which is one of the
  two reasons the bridge appeared to do nothing.
* The form opens pre-filled on ETH (Ethereum) → ETH (Base). Routes are only computed once a
  source token, a destination token *and* an amount all exist, so a widget that opens blank looks
  broken until you have made three separate choices.
* **Two chain lists, kept identical.** The widget's picker comes from LI.FI's `/v1/chains`, not
  from `wagmi` — chains that were never in our `wagmi` config still showed up in it. What `wagmi`
  *does* decide is which chains the wallet can switch to, because in external-wallet mode the
  widget routes chain switching through `wagmi`'s own `switchChain`. Any chain in the picker but
  missing from `wagmi` is therefore offered and then fails on selection, which is what "no chain
  works as a source" looked like. LI.FI's docs are explicit: "It's important to keep the Wagmi
  chains configuration in sync with the Widget chain list so all functionality, like switching
  chains, works correctly." `pages/Bridge.tsx` does that with `useSyncWagmiConfig`, feeding both
  the sync and the widget's `chains.allow` from one fetch, so the lists cannot drift.
* The route is registered as `/bridge/*`. The widget runs its own nested router, and without the
  splat the parent route stops matching the moment you open the chain selector — React then
  unmounts the entire widget mid-interaction.
* **`viem` is pinned to `2.55.2`, and that pin is load-bearing.** `useRoutes` in @lifi/widget 3.x
  calls `parseUnits(toAmount, decimals)` unconditionally while building every route request —
  including when only the "send" side of the form is filled in, where `toAmount` is `""`. viem
  returned `0n` for that up to and including 2.55.2, and throws `InvalidDecimalNumberError` from
  2.55.4 onward. The widget asks for `^2.47.2` and npm dedupes our copy into it, so on paper the
  versions are compatible and nothing in a typecheck or build objects.

  The symptom is disproportionate to the cause: every route query throws *before reaching the
  network*, so the widget shows "No routes available" while LI.FI's API, asked the same question
  with `curl`, returns perfectly good routes.

  Seeding `toAmount: "0"` in the widget config looks like a fix and is not — it only sets the
  form's *initial* value, and the field is cleared again the moment the user changes a token or
  chain, so the bug returns looking like a new one. `check-viem-compat.mjs` runs on every build
  and in `npm run check`, calling `parseUnits("", 18)` for real rather than trusting a semver
  range. The permanent fix is @lifi/widget v4, which corrected the call — it needs React 19,
  MUI 9 and TanStack Router, so it is a deliberate migration rather than a version bump.
* **Testnets are filtered out by flag, not by hard-coded id.** `/v1/chains` ships testnets
  alongside the real networks — Base Sepolia, OP Sepolia, Arbitrum Sepolia and Arc Testnet at the
  time of writing — and the widget renders the response as-is. There is no "hide testnets" option;
  the documented lever is `chains.allow` / `chains.deny`, which puts the classification on the
  caller. Every chain in the response carries a `mainnet` boolean, so `lib/lifiChains.ts` filters
  on that rather than denying four ids by number, and a testnet LI.FI adds tomorrow is excluded
  the day it appears. A response with *no* mainnet chains is treated as a failed one: if we can no
  longer tell real networks from test ones, the page says so instead of showing them all. This
  matters beyond tidiness — LI.FI has no testnet routing, so a testnet in the picker is a dead end
  as a source, and as a *destination* it is a way to send real funds somewhere unrecoverable.
* The widget is not rendered until that list resolves. Rendering first and filtering after would
  work, but for a moment the picker is LI.FI's raw response, and a moment is long enough to click.
* Themed from the literal hexes in `tailwind.config.ts` — the widget renders in its own MUI theme
  with no access to our CSS variables, so the palette has to be restated in `pages/Bridge.tsx`.
* Lazy-loaded by the router. It brings its own UI framework and multi-ecosystem wallet adapters —
  roughly 640 kB gzipped — which most visitors, who came to look at tokens, should not download
  before the feed can paint.
* On a testnet deployment the page says plainly that bridged funds arrive on Base **mainnet** and
  cannot be traded here. There is no testnet routing; without that notice the page is a trap.

`TokenCover` handles both cases, and both must fill the frame completely, because a card with a
hole in it reads as broken:

* **Uploaded image** — drawn `object-contain` over a blurred, over-scaled copy of itself. Plain
  `object-cover` crops a wide or tall upload to fill the frame, cutting off exactly the part
  people meant to show. Contain-over-blur keeps the whole image visible whatever its aspect
  ratio, and the blurred layer supplies the colour behind it.
* **No upload** — a generated poster: gradient, drifting light, diagonal texture, and the ticker
  set large as SVG text in a fixed viewBox, so it scales with the card instead of needing a
  breakpoint per column count. Everything derives from the address, so a token has a stable
  identity with no image host involved (spec §7).

The status badge is the only thing drawn on top of a cover, and it uses `StatusBadge`'s `overlay`
variant — an opaque dark base plus a blur — because the upload is arbitrary user content and a
translucent chip that reads fine on a dark card washes out completely over a white image.

## Market data source

The app tries three sources in order, all returning identical shapes:

| Order | Source | Needs |
|---|---|---|
| 1 | **The Graph** — `VITE_SUBGRAPH_URL` | a URL |
| 2 | **REST indexer** — `VITE_INDEXER_URL` | a Postgres instance you host |
| 3 | **Simulation** — `lib/mock.ts` | nothing |

The first two are built from the same events and expose the same entity model, so this is an
operational choice rather than a fork in the UI. The header chip names whichever is live, so a
misconfigured deployment is obvious at a glance.

Two figures differ slightly under the subgraph, and the difference is real:

* **24h volume** comes from the current *daily* candle (calendar-bucketed, UTC) rather than a
  trailing 24 hours — early in a UTC day it reads low. The REST indexer does a true trailing
  window; The Graph has no cheap equivalent inside a list query.
* **Sorting by volume** falls back to lifetime volume, because a nested per-token aggregate
  can't be an `orderBy` target.

## Where each number comes from

The chain is the source of truth; the indexer is a cache of its events (spec §14).

* **Quotes** come from `quoteBuy` / `quoteSell` on the contract. `src/lib/curve.ts` mirrors the
  Solidity for instant feedback and for demo mode, but the submit path **refuses to sign against
  a local estimate** — it waits for the on-chain quote.
* **Reserves, price, status, supply** come from `getToken`, with the indexed copy used only as a
  placeholder while the RPC read is in flight.
* **History, candles, volume, holders** come from the indexer.

## USD pricing

Everything valuation-shaped — token price, market cap, FDV, volume, portfolio value — displays in
USD. `GET /api/eth-price` provides the rate, cached **30 minutes in two tiers**:

1. process memory (free, but per-instance and lost on every restart — and `tsx watch` restarts
   the API on each edit, so in development this tier alone caches nothing);
2. **Turso**, which is the actual global cache: shared across instances, survives restarts and
   cold starts. That is what stops a keyless public endpoint from rate limiting us.

Two upstream sources are tried in order — Coinbase, then CoinGecko — because a single free
endpoint going down would otherwise blank every figure on the site. If both fail, the last known
price is served and flagged `stale`; ETH does not move enough in an hour to change any decision
this figure informs.

The rate is **presentational only**. Trades are quoted, signed and settled in ETH/wei; USD is a
label on top. If the feed is unavailable every figure falls back to ETH — the unit the protocol
actually denominates in — rather than showing `—` or a misleading `$0.00`. The header chip shows
the live rate so the source of every dollar figure is visible.

Token prices land far below a cent (a fresh curve is ~$0.0000015), so `formatUsd` collapses
leading zeros to subscript notation — `$0.0₅14` — instead of rounding to nothing.

## Chart

TradingView Lightweight Charts: candlesticks or an area line, plus a volume ribbon, over the
indexer's OHLCV buckets (1m / 5m / 15m / 1H / 4H / 1D), with a crosshair readout.

The chart plots the token's **unit price** — what one token costs — with a **USD / gwei** toggle
defaulting to USD.

A fresh curve sits around `$0.0000015`, which no ordinary axis renders usefully. Rather than
substituting a different quantity (valuation) to dodge that, a custom
`localization.priceFormatter` keeps the real price on the axis and collapses the leading zeros:
`$0.0₅14`. The number on the axis is the number you pay. `minMove` drops to `1e-12` in USD mode so
the scale can still generate distinct ticks at that magnitude.

gwei mode plots the same price in gwei per token (`0.5 → 60.5` across a token's whole life) and is
the automatic fallback when the price feed is unavailable.

### Interaction

Drag the plot to pan, wheel to zoom, drag either axis to rescale it, double-click an axis to snap
back to auto. Touch drag and pinch are enabled too.

The price scale **autoscales to the data range**, not to zero. An earlier version pinned the
minimum at zero to stop the axis labelling negative values; that fixed the labels and ruined the
chart, squashing a curve trading between `$0.0000010` and `$0.0000014` into the top few percent of
the pane. The negative labels were really a symptom of an oversized bottom margin — now 2% — so
the data range can speak for itself, as on any trading chart.

### Viewport

`fitContent()` is wrong at both ends: three candles get stretched into slabs that fill the pane,
five hundred get crushed into a smear. The window is instead held between **90 and 180 bars**, so
a bar is always roughly bar-sized and a young token reads as "barely any trades yet" rather than
as one giant block.

The viewport is only repositioned when the series changes identity (token or interval) — never on
a live tick, which would otherwise yank the chart back every few seconds while you were panning.

Short intervals on a young token produce very few buckets. The window clamp already makes that
read correctly — a handful of thin bars against empty space, which is what "barely any trades yet"
should look like — so there is no banner about it.

**Volume is a ribbon, not a second axis.** It lives on its own scale confined to the bottom ~14%
with its axis hidden — a magnitude strip under the price line, not a second labelled y-axis
inviting a false comparison against price. (A dual y-axis chart is the one form this project never
ships.)

## Colour

Buy/sell use **green/orange** (`#0CA678` / `#E8590C`) rather than the conventional green/red.
Green/red fails colourblind separation once both hues sit in a readable lightness band —
deuteranopia ΔE ≈ 4 against a floor of 8, i.e. genuinely indistinguishable. The chosen pair
validates at deutan ΔE 11.3, normal-vision ΔE 32.6, and passes the lightness, chroma and
contrast checks against the `#0E1014` surface.

Direction is never carried by colour alone: trades are labelled "Buy"/"Sell" in text, statuses
are spelled out, and candlestick bodies encode direction geometrically.

Base Blue `#0052FF` is the brand accent, with `#4C8DFF` for text and marks on dark surfaces.

> **Tailwind gotcha:** the brand colour scale is named `brand`, not `base`. Naming a colour
> `base` makes Tailwind generate `.text-base` as a *colour* utility, silently overriding the
> built-in `text-base` **font-size** utility — every `text-base` in the app turns blue. Keep the
> scale named `brand`.

## Off-chain layer — Turso + R2

Everything a token or a person *is* beyond its address — picture, description, links, handle,
bio — lives off-chain. The launchpad contract deliberately has no metadata fields, no owner and
no admin, so this material has nowhere on-chain to go, and nothing that affects a trade is ever
read from here (spec §14).

| | Where | Holds |
|---|---|---|
| **Turso** (libSQL) | `../server/src/db.ts` | `token_metadata`, `profiles`, `images` |
| **Cloudflare R2** | `../server/src/storage.ts` | the image bytes |

```bash
npm --prefix ../server run storage:check   # round-trips both services; prints no secrets
```

Both are optional. Unconfigured, the app falls back to demo fixtures and uploads are compressed
and returned inline. `GET /api/storage/status` reports which are live (hostnames and bucket name
only — never a credential).

### Image pipeline

Every uploaded byte is **re-encoded through sharp** rather than passed through, which does three
jobs at once:

* **Size** — a phone photo arrives at 3–8 MB; the stored 512px WebP is 20–60 KB.
* **Safety** — re-encoding strips EXIF (including GPS from the camera roll) and discards anything
  that isn't decodable pixel data: a polyglot file with a script appended, an SVG carrying
  JavaScript, a zip-bomb PNG. What reaches the bucket is bytes sharp produced.
* **Uniformity** — one format, one bounded dimension, plus a 128px thumbnail.

Limits are layered, because a client-side check is a courtesy and not a control:

1. `Content-Length` rejected before the body is read;
2. `Blob.size` rejected before decode — so a decompression bomb never reaches sharp;
3. `limitInputPixels: 50 MP` — a 30 000 × 30 000 PNG compresses to well under 5 MB and would
   still exhaust memory;
4. magic-byte sniffing, because the multipart `Content-Type` is attacker-controlled;
5. 30 uploads per address per hour.

The UI reports the real before/after byte counts, because "we compress your image" is the kind of
claim that should be visible rather than asserted.

### Who may write

Connecting a wallet opens a **session**: one `personal_sign` (no gas, no transaction) over a
message naming the domain, a server nonce and both time bounds, exchanged for an HMAC bearer
token. Every off-chain write then rides on that token — uploading a picture and saving a
description no longer open a wallet popup each.

This replaced a signature per write. Beyond the friction, that pattern is actively bad for users:
it teaches people to approve signature prompts without reading them, which is the exact habit
wallet drainers depend on.

### Session lifetime

Two bounds rather than one, because a single TTL forces a choice between interrupting people who
are actively using the site and handing out a credential that outlives their attention:

| | Default | Env | Behaviour |
|---|---|---|---|
| Idle window | 12 hours | `SESSION_IDLE_HOURS` | Slides forward on use. An active user is never interrupted. |
| Hard cap | 7 days | `SESSION_MAX_DAYS` | Measured from the signature. No renewal passes it. |

Renewal happens two ways, neither of which prompts: every authenticated request returns a rotated
token in `X-Session-Token`, and an open tab calls `POST /api/auth/refresh` when its token is
within an hour of lapsing. The heartbeat is skipped while the tab is hidden — a background tab is
not somebody using the site, and that is exactly what makes a 12-hour idle window safe to offer.

This is strictly stronger than issuing one long token up front: an abandoned or stolen token
still dies at the idle window. Renewal requires presenting a currently valid token, so it grants
nothing that token did not already grant. The cap travels inside the MAC and is re-clamped to
policy on every read, so a token may claim a *shorter* life than configuration allows but never a
longer one — and lowering `SESSION_MAX_DAYS` immediately shortens sessions already issued.

A write that hits a 401 recovers on its own: the client drops the dead token, signs in once, and
retries the write exactly once. A second 401 is a real refusal, not a stale token.

Authentication is still not authorisation — a token proves control of *an* address, nothing more:

* **Profile** — the session address must equal the profile's address.
* **Token** — the route reads `creator` from the launchpad and requires it to equal the session
  address. The launchpad is the authority here, never the request body.

Verification of the sign-in goes through a public client rather than a bare `verifyMessage`, so
ERC-1271 smart accounts work as well as EOAs. The sign-in message itself is only valid for five
minutes.

### Set `AUTH_SECRET`

Without it the signing key is generated at boot, so **every restart invalidates every outstanding
session**. The symptom is users being told their session expired while their own countdown still
shows time left — and `tsx watch` restarts the API on each edit, so in development it happens
constantly.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Sign-out is client-side: the token is dropped, not revoked. With a stateless design the lever for
mass revocation is rotating `AUTH_SECRET`, which invalidates everything at once. The per-write
signature path from before is still accepted, so a tab running an older bundle keeps working
through a deploy.

User-supplied links are parsed, not sanitised: only `http`/`https` survive, so `javascript:`,
`data:` and protocol-relative `//evil.com` are rejected at write time rather than escaped at
render time. Handles (`@someone`) are accepted and expanded to canonical URLs.

## Profiles

`/u/<username>` or `/u/<address>` — both resolve, so a profile is reachable before anyone claims
a handle.

Identity follows a wallet everywhere it appears: the header pill, the trade ticker, the
leaderboard and the creator line on every card all show the avatar and display name their owner
set, falling back to a generated mark and a shortened address. `AccountLabel` and `useProfiles`
in `components/Account.tsx` do this, batched through `GET /api/profiles/batch` so a ticker of
twenty trades costs one request rather than twenty.

The fallback is asymmetric on purpose. A generated *mark* is decoration — better than a blank
circle, and stable per address. A generated *name* would be a claim, so an address without a
profile stays an address.

The two halves come from different places on purpose. Identity (avatar, handle, bio, links) is
editable and lives in Turso. The portfolio is derived from chain events and is **not** editable
by anyone, including the profile's owner: holdings come from the subgraph's `Account` entity, or
the indexer's `/accounts/:address/portfolio`, both of which track balances from ERC-20 `Transfer`
logs — so they stay correct through peer-to-peer sends and post-migration Uniswap trades, neither
of which emit launchpad events. Someone can style their page however they like; they cannot
misrepresent what they hold.

## Wallets

Wallets are discovered via EIP-6963 (`multiInjectedProviderDiscovery`), so every installed wallet
is listed individually. This also keeps `wagmi/connectors` out of the bundle — that barrel pulls
in the Coinbase CDP SDK and its optional `x402` dependencies, which fail to resolve at build time.
