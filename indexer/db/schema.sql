-- =============================================================================================
-- Pumper.fun indexer schema (PostgreSQL 14+)
--
-- Design rules:
--   * uint256 values are stored as NUMERIC(78,0) — lossless for the full range, and still
--     arithmetic-capable in SQL (needed for volume/market-cap rollups).
--   * Everything in `tokens` below the "derived" line is a cache: it can be rebuilt from
--     `trades` + `migrations` alone. That is what makes reorg rollback safe (see
--     src/handlers.ts:recomputeToken) and what guarantees the chain stays the source of truth.
--   * (tx_hash, log_index) is the natural key for every event-derived row, so replaying a range
--     is idempotent.
-- =============================================================================================

CREATE TABLE IF NOT EXISTS indexer_state (
    id                      SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_indexed_block      BIGINT      NOT NULL,
    last_indexed_block_hash TEXT,
    chain_id                INTEGER     NOT NULL,
    factory_address         TEXT        NOT NULL,
    started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rolling window of recent block hashes, used to detect reorgs.
CREATE TABLE IF NOT EXISTS blocks (
    number      BIGINT PRIMARY KEY,
    hash        TEXT   NOT NULL,
    parent_hash TEXT   NOT NULL,
    timestamp   BIGINT NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- Creator
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS creators (
    address         TEXT PRIMARY KEY,
    tokens_created  INTEGER       NOT NULL DEFAULT 0,
    tokens_migrated INTEGER       NOT NULL DEFAULT 0,
    first_seen_at   BIGINT        NOT NULL,
    last_seen_at    BIGINT        NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- Token
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tokens (
    address                 TEXT PRIMARY KEY,
    creator                 TEXT          NOT NULL REFERENCES creators(address),
    name                    TEXT          NOT NULL,
    symbol                  TEXT          NOT NULL,

    -- genesis parameters, straight from TokenCreated
    total_supply            NUMERIC(78,0) NOT NULL,
    initial_virtual_eth     NUMERIC(78,0) NOT NULL,
    initial_virtual_tokens  NUMERIC(78,0) NOT NULL,
    migration_threshold     NUMERIC(78,0) NOT NULL,

    created_at              BIGINT        NOT NULL,
    created_at_block        BIGINT        NOT NULL,
    created_at_tx           TEXT          NOT NULL,

    -- ---- derived from the event stream below this line ----
    status                  SMALLINT      NOT NULL DEFAULT 1,  -- 1 trading, 2 pending, 3 migrated
    eth_reserve             NUMERIC(78,0) NOT NULL DEFAULT 0,
    virtual_eth_reserve     NUMERIC(78,0) NOT NULL,
    token_reserve           NUMERIC(78,0) NOT NULL,
    price                   NUMERIC(78,0) NOT NULL,            -- wei per whole token
    market_cap              NUMERIC(78,0) NOT NULL DEFAULT 0,
    ath_market_cap          NUMERIC(78,0) NOT NULL DEFAULT 0,  -- high-water mark, never decreases
    fdv                     NUMERIC(78,0) NOT NULL DEFAULT 0,
    migration_progress_bps  INTEGER       NOT NULL DEFAULT 0,

    volume_eth              NUMERIC(78,0) NOT NULL DEFAULT 0,  -- buy gross + sell gross
    buy_volume_eth          NUMERIC(78,0) NOT NULL DEFAULT 0,
    sell_volume_eth         NUMERIC(78,0) NOT NULL DEFAULT 0,
    tokens_bought           NUMERIC(78,0) NOT NULL DEFAULT 0,
    tokens_sold             NUMERIC(78,0) NOT NULL DEFAULT 0,
    fees_eth                NUMERIC(78,0) NOT NULL DEFAULT 0,
    trade_count             INTEGER       NOT NULL DEFAULT 0,
    buy_count               INTEGER       NOT NULL DEFAULT 0,
    sell_count              INTEGER       NOT NULL DEFAULT 0,
    holder_count            INTEGER       NOT NULL DEFAULT 0,

    pair                    TEXT,
    migrated_at             BIGINT,
    last_trade_at           BIGINT,
    updated_at_block        BIGINT        NOT NULL
);

-- Added after the initial release, so an existing database needs it retrofitted. `IF NOT EXISTS`
-- makes re-running the schema a no-op, which is what `npm run migrate` relies on.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS ath_market_cap NUMERIC(78,0) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS tokens_created_at_idx  ON tokens (created_at DESC);
CREATE INDEX IF NOT EXISTS tokens_market_cap_idx  ON tokens (market_cap DESC);
CREATE INDEX IF NOT EXISTS tokens_last_trade_idx  ON tokens (last_trade_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS tokens_status_idx      ON tokens (status);
CREATE INDEX IF NOT EXISTS tokens_creator_idx     ON tokens (creator);
CREATE INDEX IF NOT EXISTS tokens_symbol_idx      ON tokens (lower(symbol));
CREATE INDEX IF NOT EXISTS tokens_name_idx        ON tokens (lower(name));

-- ---------------------------------------------------------------------------------------------
-- Trade
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trades (
    id                  BIGSERIAL PRIMARY KEY,
    token               TEXT          NOT NULL REFERENCES tokens(address) ON DELETE CASCADE,
    trader              TEXT          NOT NULL,
    side                SMALLINT      NOT NULL,  -- 0 buy, 1 sell

    -- Buy:  eth_in = gross paid, eth_out = 0.       Sell: eth_in = 0, eth_out = received.
    -- gross_eth is the curve-side amount in both directions (buy: post-fee in; sell: pre-fee out).
    eth_in              NUMERIC(78,0) NOT NULL DEFAULT 0,
    eth_out             NUMERIC(78,0) NOT NULL DEFAULT 0,
    gross_eth           NUMERIC(78,0) NOT NULL,
    fee                 NUMERIC(78,0) NOT NULL,
    token_amount        NUMERIC(78,0) NOT NULL,

    price               NUMERIC(78,0) NOT NULL,  -- post-trade spot, wei per whole token
    execution_price     NUMERIC(78,0) NOT NULL,  -- realised: gross_eth * 1e18 / token_amount
    eth_reserve         NUMERIC(78,0) NOT NULL,
    virtual_eth_reserve NUMERIC(78,0) NOT NULL,
    token_reserve       NUMERIC(78,0) NOT NULL,

    block_number        BIGINT        NOT NULL,
    block_hash          TEXT          NOT NULL,
    tx_hash             TEXT          NOT NULL,
    log_index           INTEGER       NOT NULL,
    timestamp           BIGINT        NOT NULL,

    UNIQUE (tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS trades_token_time_idx  ON trades (token, timestamp DESC);
CREATE INDEX IF NOT EXISTS trades_token_block_idx ON trades (token, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS trades_trader_idx      ON trades (trader, timestamp DESC);
CREATE INDEX IF NOT EXISTS trades_block_idx       ON trades (block_number);

-- ---------------------------------------------------------------------------------------------
-- PricePoint — one tick per trade. The chart's raw series; candles roll up from here.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_points (
    id            BIGSERIAL PRIMARY KEY,
    token         TEXT          NOT NULL REFERENCES tokens(address) ON DELETE CASCADE,
    price         NUMERIC(78,0) NOT NULL,
    eth_reserve   NUMERIC(78,0) NOT NULL,
    token_reserve NUMERIC(78,0) NOT NULL,
    market_cap    NUMERIC(78,0) NOT NULL,
    volume_eth    NUMERIC(78,0) NOT NULL,
    block_number  BIGINT        NOT NULL,
    tx_hash       TEXT          NOT NULL,
    log_index     INTEGER       NOT NULL,
    timestamp     BIGINT        NOT NULL,

    UNIQUE (tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS price_points_token_time_idx ON price_points (token, timestamp);
CREATE INDEX IF NOT EXISTS price_points_block_idx      ON price_points (block_number);

-- OHLCV candles, maintained incrementally per (token, interval, bucket).
CREATE TABLE IF NOT EXISTS candles (
    token          TEXT          NOT NULL REFERENCES tokens(address) ON DELETE CASCADE,
    interval_secs  INTEGER       NOT NULL,
    bucket_start   BIGINT        NOT NULL,
    open           NUMERIC(78,0) NOT NULL,
    high           NUMERIC(78,0) NOT NULL,
    low            NUMERIC(78,0) NOT NULL,
    close          NUMERIC(78,0) NOT NULL,
    volume_eth     NUMERIC(78,0) NOT NULL DEFAULT 0,
    trade_count    INTEGER       NOT NULL DEFAULT 0,
    last_block     BIGINT        NOT NULL,

    PRIMARY KEY (token, interval_secs, bucket_start)
);

CREATE INDEX IF NOT EXISTS candles_lookup_idx ON candles (token, interval_secs, bucket_start DESC);
CREATE INDEX IF NOT EXISTS candles_block_idx  ON candles (last_block);

-- ---------------------------------------------------------------------------------------------
-- Holder — maintained from ERC-20 Transfer logs of launchpad tokens, so balances stay correct
-- through curve trades, peer-to-peer transfers and post-migration Uniswap activity alike.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS holders (
    token          TEXT          NOT NULL REFERENCES tokens(address) ON DELETE CASCADE,
    address        TEXT          NOT NULL,
    balance        NUMERIC(78,0) NOT NULL DEFAULT 0,
    first_seen_at  BIGINT        NOT NULL,
    last_seen_at   BIGINT        NOT NULL,

    PRIMARY KEY (token, address)
);

CREATE INDEX IF NOT EXISTS holders_token_balance_idx ON holders (token, balance DESC);
CREATE INDEX IF NOT EXISTS holders_address_idx       ON holders (address);

-- Raw transfer log, kept so holder balances can be rebuilt after a reorg rollback.
CREATE TABLE IF NOT EXISTS transfers (
    id           BIGSERIAL PRIMARY KEY,
    token        TEXT          NOT NULL REFERENCES tokens(address) ON DELETE CASCADE,
    from_address TEXT          NOT NULL,
    to_address   TEXT          NOT NULL,
    amount       NUMERIC(78,0) NOT NULL,
    block_number BIGINT        NOT NULL,
    tx_hash      TEXT          NOT NULL,
    log_index    INTEGER       NOT NULL,
    timestamp    BIGINT        NOT NULL,

    UNIQUE (tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS transfers_token_idx ON transfers (token, block_number);
CREATE INDEX IF NOT EXISTS transfers_block_idx ON transfers (block_number);

-- ---------------------------------------------------------------------------------------------
-- Migration
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migrations (
    token                 TEXT PRIMARY KEY REFERENCES tokens(address) ON DELETE CASCADE,
    pair                  TEXT,
    triggered_at          BIGINT,
    triggered_at_block    BIGINT,
    triggered_eth_reserve NUMERIC(78,0),
    triggered_token_reserve NUMERIC(78,0),
    completed_at          BIGINT,
    completed_at_block    BIGINT,
    completed_tx          TEXT,
    eth_deposited         NUMERIC(78,0),
    tokens_deposited      NUMERIC(78,0),
    tokens_burned         NUMERIC(78,0),
    lp_tokens_burned      NUMERIC(78,0),
    opening_price         NUMERIC(78,0)
);

CREATE INDEX IF NOT EXISTS migrations_completed_idx ON migrations (completed_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS migrations_block_idx     ON migrations (completed_at_block);

-- ---------------------------------------------------------------------------------------------
-- PlatformFee
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_fees (
    id           BIGSERIAL PRIMARY KEY,
    token        TEXT          NOT NULL REFERENCES tokens(address) ON DELETE CASCADE,
    user_address TEXT          NOT NULL,
    action       SMALLINT      NOT NULL,  -- 0 buy, 1 sell
    amount       NUMERIC(78,0) NOT NULL,
    block_number BIGINT        NOT NULL,
    tx_hash      TEXT          NOT NULL,
    log_index    INTEGER       NOT NULL,
    timestamp    BIGINT        NOT NULL,

    UNIQUE (tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS platform_fees_token_idx ON platform_fees (token, timestamp DESC);
CREATE INDEX IF NOT EXISTS platform_fees_block_idx ON platform_fees (block_number);

-- ---------------------------------------------------------------------------------------------
-- Convenience view: 24h rollups for the discover page.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW token_stats_24h AS
SELECT
    t.address,
    COALESCE(SUM(tr.gross_eth), 0)                              AS volume_24h,
    COUNT(tr.id)                                                AS trades_24h,
    COUNT(DISTINCT tr.trader)                                   AS traders_24h,
    MIN(tr.price) FILTER (WHERE tr.price > 0)                   AS low_24h,
    MAX(tr.price)                                               AS high_24h,
    (ARRAY_AGG(tr.price ORDER BY tr.block_number, tr.log_index))[1] AS open_24h
FROM tokens t
LEFT JOIN trades tr
       ON tr.token = t.address
      AND tr.timestamp >= EXTRACT(EPOCH FROM now())::BIGINT - 86400
GROUP BY t.address;
