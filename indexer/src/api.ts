import cors from "cors";
import express, { type Express, type Request, type Response } from "express";

import { CANDLE_INTERVALS, PROTOCOL, config } from "./config";
import { query } from "./db";
import { logger } from "./logger";

/**
 * Read API for the frontend.
 *
 * Every numeric field is serialised as a decimal **string**: these are uint256 values and
 * JSON numbers would silently lose precision. The frontend parses them with BigInt.
 */

const SORT_COLUMNS: Record<string, string> = {
  newest: "t.created_at DESC",
  oldest: "t.created_at ASC",
  marketCap: "t.market_cap DESC",
  ath: "t.ath_market_cap DESC",
  volume: "s.volume_24h DESC NULLS LAST",
  volumeAll: "t.volume_eth DESC",
  progress: "t.migration_progress_bps DESC, t.created_at DESC",
  lastTrade: "t.last_trade_at DESC NULLS LAST",
  trades: "t.trade_count DESC",
};

const TOKEN_COLUMNS = `
  t.address, t.creator, t.name, t.symbol, t.status,
  t.total_supply, t.migration_threshold,
  t.eth_reserve, t.virtual_eth_reserve, t.token_reserve,
  t.price, t.market_cap, t.ath_market_cap, t.fdv, t.migration_progress_bps,
  t.volume_eth, t.buy_volume_eth, t.sell_volume_eth,
  t.tokens_bought, t.tokens_sold, t.fees_eth,
  t.trade_count, t.buy_count, t.sell_count, t.holder_count,
  t.pair, t.migrated_at, t.last_trade_at, t.created_at, t.created_at_block, t.created_at_tx
`;

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    handler(req, res).catch((error) => {
      logger.error("API request failed", {
        path: req.path,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "internal_error" });
    });
  };
}

export function createApi(): Express {
  const app = express();
  app.use(cors({ origin: config.apiCorsOrigin }));
  app.use(express.json());

  // ---- health & global stats ----------------------------------------------------------------

  app.get(
    "/health",
    asyncRoute(async (_req, res) => {
      const state = await query<{ last_indexed_block: string; updated_at: string }>(
        `SELECT last_indexed_block, updated_at FROM indexer_state WHERE id = 1`,
      );
      res.json({
        ok: true,
        chainId: config.chainId,
        factory: config.factoryAddress,
        lastIndexedBlock: state[0]?.last_indexed_block ?? null,
        updatedAt: state[0]?.updated_at ?? null,
      });
    }),
  );

  app.get(
    "/constants",
    asyncRoute(async (_req, res) => {
      res.json({
        chainId: config.chainId,
        factory: config.factoryAddress,
        totalSupply: PROTOCOL.totalSupply.toString(),
        virtualEthReserve: PROTOCOL.virtualEthReserve.toString(),
        migrationThreshold: PROTOCOL.migrationThreshold.toString(),
        buyFeeBps: 20,
        sellFeeBps: 30,
        priceUnit: PROTOCOL.priceUnit.toString(),
        candleIntervals: CANDLE_INTERVALS,
      });
    }),
  );

  app.get(
    "/stats",
    asyncRoute(async (_req, res) => {
      const rows = await query<Record<string, string>>(
        `SELECT
            COUNT(*)                                              AS tokens,
            COUNT(*) FILTER (WHERE status = 3)                    AS migrated,
            COUNT(*) FILTER (WHERE status = 2)                    AS pending_migration,
            COALESCE(SUM(volume_eth), 0)                          AS total_volume_eth,
            COALESCE(SUM(fees_eth), 0)                            AS total_fees_eth,
            COALESCE(SUM(eth_reserve), 0)                         AS total_eth_locked,
            COALESCE(SUM(trade_count), 0)                         AS total_trades
           FROM tokens`,
      );
      const volume24h = await query<{ volume_24h: string }>(
        `SELECT COALESCE(SUM(gross_eth), 0) AS volume_24h
           FROM trades WHERE timestamp >= EXTRACT(EPOCH FROM now())::BIGINT - 86400`,
      );
      res.json({ ...rows[0], volume_24h: volume24h[0]?.volume_24h ?? "0" });
    }),
  );

  // ---- token discovery -----------------------------------------------------------------------

  app.get(
    "/tokens",
    asyncRoute(async (req, res) => {
      const limit = parseLimit(req.query.limit, 50, 200);
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const sort = SORT_COLUMNS[String(req.query.sort ?? "newest")] ?? SORT_COLUMNS.newest;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (req.query.status !== undefined && req.query.status !== "all") {
        params.push(Number(req.query.status));
        conditions.push(`t.status = $${params.length}`);
      }
      if (req.query.creator && isAddress(String(req.query.creator))) {
        params.push(String(req.query.creator).toLowerCase());
        conditions.push(`t.creator = $${params.length}`);
      }
      if (req.query.q) {
        params.push(`%${String(req.query.q).toLowerCase()}%`);
        conditions.push(
          `(lower(t.name) LIKE $${params.length} OR lower(t.symbol) LIKE $${params.length} OR t.address LIKE $${params.length})`,
        );
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(limit, offset);

      // The lateral join attaches the last 24 price points per row so the discover feed can draw
      // a sparkline without an N+1 round trip per token.
      const rows = await query(
        `SELECT ${TOKEN_COLUMNS},
                COALESCE(s.volume_24h, 0) AS volume_24h,
                COALESCE(s.trades_24h, 0) AS trades_24h,
                s.open_24h,
                sp.sparkline
           FROM tokens t
           LEFT JOIN token_stats_24h s ON s.address = t.address
           LEFT JOIN LATERAL (
             SELECT ARRAY(
               SELECT price FROM (
                 SELECT price, block_number, log_index
                   FROM price_points
                  WHERE token = t.address
                  ORDER BY block_number DESC, log_index DESC
                  LIMIT 24
               ) recent
               ORDER BY block_number ASC, log_index ASC
             ) AS sparkline
           ) sp ON TRUE
           ${where}
          ORDER BY ${sort}
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      const totalRows = await query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM tokens t ${where}`,
        params.slice(0, params.length - 2),
      );

      res.json({ tokens: rows, total: Number(totalRows[0]?.count ?? 0), limit, offset });
    }),
  );

  app.get(
    "/tokens/:address",
    asyncRoute(async (req, res) => {
      const address = String(req.params.address).toLowerCase();
      if (!isAddress(address)) {
        res.status(400).json({ error: "invalid_address" });
        return;
      }

      const rows = await query(
        `SELECT ${TOKEN_COLUMNS},
                COALESCE(s.volume_24h, 0) AS volume_24h,
                COALESCE(s.trades_24h, 0) AS trades_24h,
                COALESCE(s.traders_24h, 0) AS traders_24h,
                s.high_24h, s.low_24h, s.open_24h
           FROM tokens t
           LEFT JOIN token_stats_24h s ON s.address = t.address
          WHERE t.address = $1`,
        [address],
      );

      if (rows.length === 0) {
        res.status(404).json({ error: "token_not_found" });
        return;
      }

      const migration = await query(`SELECT * FROM migrations WHERE token = $1`, [address]);
      res.json({ token: rows[0], migration: migration[0] ?? null });
    }),
  );

  /** Newest trades across every token — powers the frontend's live ticker. */
  app.get(
    "/trades/recent",
    asyncRoute(async (req, res) => {
      const limit = parseLimit(req.query.limit, 24, 100);
      const rows = await query(
        `SELECT tr.token, tr.trader, tr.side, tr.eth_in, tr.eth_out, tr.gross_eth, tr.fee,
                tr.token_amount, tr.price, tr.execution_price, tr.eth_reserve,
                tr.virtual_eth_reserve, tr.token_reserve, tr.block_number, tr.tx_hash,
                tr.log_index, tr.timestamp,
                t.symbol, t.name
           FROM trades tr
           JOIN tokens t ON t.address = tr.token
          ORDER BY tr.block_number DESC, tr.log_index DESC
          LIMIT $1`,
        [limit],
      );
      res.json({ trades: rows });
    }),
  );

  // ---- trades ---------------------------------------------------------------------------------

  app.get(
    "/tokens/:address/trades",
    asyncRoute(async (req, res) => {
      const address = String(req.params.address).toLowerCase();
      if (!isAddress(address)) {
        res.status(400).json({ error: "invalid_address" });
        return;
      }

      const limit = parseLimit(req.query.limit, 50, 500);
      const params: unknown[] = [address];
      let cursor = "";

      // Keyset pagination on (block_number, log_index) — stable under concurrent inserts.
      if (req.query.beforeBlock && req.query.beforeLogIndex) {
        params.push(String(req.query.beforeBlock), Number(req.query.beforeLogIndex));
        cursor = `AND (block_number, log_index) < ($2::bigint, $3::int)`;
      }
      params.push(limit);

      const rows = await query(
        `SELECT token, trader, side, eth_in, eth_out, gross_eth, fee, token_amount,
                price, execution_price, eth_reserve, virtual_eth_reserve, token_reserve,
                block_number, tx_hash, log_index, timestamp
           FROM trades
          WHERE token = $1 ${cursor}
          ORDER BY block_number DESC, log_index DESC
          LIMIT $${params.length}`,
        params,
      );

      res.json({ trades: rows, limit });
    }),
  );

  // ---- chart ----------------------------------------------------------------------------------

  app.get(
    "/tokens/:address/candles",
    asyncRoute(async (req, res) => {
      const address = String(req.params.address).toLowerCase();
      if (!isAddress(address)) {
        res.status(400).json({ error: "invalid_address" });
        return;
      }

      const interval = Number(req.query.interval ?? 300);
      if (!CANDLE_INTERVALS.includes(interval as (typeof CANDLE_INTERVALS)[number])) {
        res
          .status(400)
          .json({ error: "invalid_interval", supported: CANDLE_INTERVALS });
        return;
      }

      const limit = parseLimit(req.query.limit, 500, 2000);
      const params: unknown[] = [address, interval];
      let range = "";
      if (req.query.from) {
        params.push(String(req.query.from));
        range += ` AND bucket_start >= $${params.length}`;
      }
      if (req.query.to) {
        params.push(String(req.query.to));
        range += ` AND bucket_start <= $${params.length}`;
      }
      params.push(limit);

      const rows = await query(
        `SELECT bucket_start, open, high, low, close, volume_eth, trade_count
           FROM (
             SELECT bucket_start, open, high, low, close, volume_eth, trade_count
               FROM candles
              WHERE token = $1 AND interval_secs = $2 ${range}
              ORDER BY bucket_start DESC
              LIMIT $${params.length}
           ) recent
          ORDER BY bucket_start ASC`,
        params,
      );

      res.json({ interval, candles: rows });
    }),
  );

  /** Raw per-trade price series — for charts that prefer ticks over candles. */
  app.get(
    "/tokens/:address/prices",
    asyncRoute(async (req, res) => {
      const address = String(req.params.address).toLowerCase();
      if (!isAddress(address)) {
        res.status(400).json({ error: "invalid_address" });
        return;
      }
      const limit = parseLimit(req.query.limit, 1000, 5000);

      const rows = await query(
        `SELECT * FROM (
            SELECT timestamp, price, eth_reserve, token_reserve, market_cap, volume_eth, block_number
              FROM price_points WHERE token = $1
             ORDER BY timestamp DESC, block_number DESC LIMIT $2
         ) recent ORDER BY timestamp ASC`,
        [address, limit],
      );

      res.json({ prices: rows });
    }),
  );

  // ---- holders --------------------------------------------------------------------------------

  app.get(
    "/tokens/:address/holders",
    asyncRoute(async (req, res) => {
      const address = String(req.params.address).toLowerCase();
      if (!isAddress(address)) {
        res.status(400).json({ error: "invalid_address" });
        return;
      }
      const limit = parseLimit(req.query.limit, 100, 500);

      const rows = await query(
        `SELECT h.address, h.balance, h.first_seen_at, h.last_seen_at,
                (h.balance * 10000 / NULLIF(t.total_supply, 0)) AS share_bps
           FROM holders h
           JOIN tokens t ON t.address = h.token
          WHERE h.token = $1
            AND h.balance > 0
            AND h.address <> ALL($2::text[])
          ORDER BY h.balance DESC
          LIMIT $3`,
        [
          address,
          [PROTOCOL.burnAddress, PROTOCOL.zeroAddress, config.factoryAddress.toLowerCase()],
          limit,
        ],
      );

      res.json({ holders: rows });
    }),
  );

  // ---- fees & creators -------------------------------------------------------------------------

  app.get(
    "/tokens/:address/fees",
    asyncRoute(async (req, res) => {
      const address = String(req.params.address).toLowerCase();
      if (!isAddress(address)) {
        res.status(400).json({ error: "invalid_address" });
        return;
      }
      const rows = await query(
        `SELECT action, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
           FROM platform_fees WHERE token = $1 GROUP BY action`,
        [address],
      );
      res.json({ fees: rows });
    }),
  );

  /**
   * Everything a profile page needs about one address: current holdings valued at the live
   * price, tokens they launched, and their trading history.
   *
   * Balances come from the `holders` table, which is maintained from ERC-20 Transfer logs — so
   * they stay correct through peer-to-peer sends and post-migration Uniswap activity, neither of
   * which produce launchpad events.
   */
  app.get(
    "/accounts/:address/portfolio",
    asyncRoute(async (req, res) => {
      const address = String(req.params.address).toLowerCase();
      if (!isAddress(address)) {
        res.status(400).json({ error: "invalid_address" });
        return;
      }

      const holdings = await query(
        `SELECT h.token,
                t.name,
                t.symbol,
                t.status,
                h.balance::text                                              AS balance,
                t.price::text                                                AS price,
                FLOOR(h.balance * t.price / 1000000000000000000::numeric)::text AS "valueWei",
                FLOOR(h.balance * 10000 / NULLIF(t.total_supply, 0))         AS "shareBps"
           FROM holders h
           JOIN tokens t ON t.address = h.token
          WHERE h.address = $1
            AND h.balance > 0
          ORDER BY h.balance * t.price DESC
          LIMIT 200`,
        [address],
      );

      const created = await query<{ address: string }>(
        `SELECT address FROM tokens WHERE creator = $1 ORDER BY created_at DESC`,
        [address],
      );

      const activity = await query<{ trade_count: string; volume: string }>(
        `SELECT COUNT(*) AS trade_count, COALESCE(SUM(gross_eth), 0) AS volume
           FROM trades WHERE trader = $1`,
        [address],
      );

      const totalValueWei = holdings.reduce(
        (sum, row) => sum + BigInt((row as any).valueWei ?? "0"),
        0n,
      );

      res.json({
        holdings: holdings.map((row) => ({ ...row, shareBps: Number((row as any).shareBps ?? 0) })),
        created: created.map((row) => row.address),
        totalValueWei: totalValueWei.toString(),
        tradeCount: Number(activity[0]?.trade_count ?? 0),
        volumeWei: activity[0]?.volume ?? "0",
      });
    }),
  );

  // ---- leaderboard ---------------------------------------------------------------------------

  /**
   * Rankings of traders and creators.
   *
   * Two deliberate choices about what the numbers mean:
   *
   *   * **Flows are windowed, positions are not.** Volume, trade count and cash in/out are summed
   *     over the requested window; the value of what someone still holds is necessarily current.
   *     So `pnl` is only a true profit-and-loss over `window=all` — over a shorter window it is
   *     "cash out minus cash in during the window, plus everything held now", which flatters
   *     anyone whose position predates the window. The client labels the PnL board all-time for
   *     exactly this reason.
   *   * **Only launchpad trades count.** Tokens acquired by transfer, or bought on Uniswap after
   *     migration, still show up in the holdings leg (balances come from Transfer logs) but not
   *     in the flow leg. There is no cost basis for them to contribute.
   */
  app.get(
    "/leaderboard",
    asyncRoute(async (req, res) => {
      const limit = parseLimit(req.query.limit, 50, 200);
      const board = String(req.query.board ?? "traders") === "creators" ? "creators" : "traders";

      const windows: Record<string, number | null> = {
        "24h": 86_400,
        "7d": 604_800,
        "30d": 2_592_000,
        all: null,
      };
      const windowKey = String(req.query.window ?? "24h");
      const seconds = windowKey in windows ? windows[windowKey] : windows["24h"];
      const since = seconds === null ? null : Math.floor(Date.now() / 1000) - seconds;

      if (board === "creators") {
        const sort =
          {
            volume: "COALESCE(SUM(t.volume_eth), 0) DESC",
            graduated: "COUNT(*) FILTER (WHERE t.status = 3) DESC, COUNT(*) DESC",
            tokens: "COUNT(*) DESC",
            marketCap: "COALESCE(SUM(t.market_cap), 0) DESC",
          }[String(req.query.sort ?? "volume")] ?? "COALESCE(SUM(t.volume_eth), 0) DESC";

        const params: unknown[] = [];
        let where = "";
        if (since !== null) {
          params.push(since);
          where = `WHERE t.created_at >= $${params.length}`;
        }
        params.push(limit);

        const entries = await query(
          `SELECT t.creator                                          AS address,
                  COUNT(*)::int                                      AS tokens_created,
                  COUNT(*) FILTER (WHERE t.status = 3)::int          AS tokens_migrated,
                  COALESCE(SUM(t.volume_eth), 0)::text               AS volume,
                  COALESCE(SUM(t.market_cap), 0)::text               AS market_cap,
                  COALESCE(SUM(t.fees_eth), 0)::text                 AS fees,
                  COALESCE(SUM(t.trade_count), 0)::int               AS trades,
                  COALESCE(SUM(t.holder_count), 0)::int              AS holders,
                  MAX(t.created_at)                                  AS last_created_at
             FROM tokens t
             ${where}
            GROUP BY t.creator
            ORDER BY ${sort}
            LIMIT $${params.length}`,
          params,
        );

        res.json({ board, window: windowKey, entries });
        return;
      }

      const sort =
        {
          volume: "scored.volume DESC",
          pnl: "scored.pnl DESC",
          trades: "scored.trades DESC",
        }[String(req.query.sort ?? "volume")] ?? "scored.volume DESC";

      const params: unknown[] = [];
      let where = "";
      if (since !== null) {
        params.push(since);
        where = `WHERE timestamp >= $${params.length}`;
      }
      params.push(limit);

      const entries = await query(
        `WITH flows AS (
           SELECT trader                          AS address,
                  COUNT(*)::int                   AS trades,
                  COUNT(DISTINCT token)::int      AS tokens,
                  COALESCE(SUM(gross_eth), 0)     AS volume,
                  COALESCE(SUM(eth_in), 0)        AS eth_in,
                  COALESCE(SUM(eth_out), 0)       AS eth_out,
                  MAX(timestamp)                  AS last_trade_at
             FROM trades
             ${where}
            GROUP BY trader
         ),
         positions AS (
           SELECT h.address,
                  COALESCE(
                    SUM(FLOOR(h.balance * t.price / 1000000000000000000::numeric)), 0
                  ) AS holdings_value
             FROM holders h
             JOIN tokens t ON t.address = h.token
            WHERE h.balance > 0
            GROUP BY h.address
         ),
         scored AS (
           SELECT f.address, f.trades, f.tokens, f.last_trade_at,
                  f.volume, f.eth_in, f.eth_out,
                  COALESCE(p.holdings_value, 0)                              AS holdings_value,
                  f.eth_out - f.eth_in + COALESCE(p.holdings_value, 0)       AS pnl
             FROM flows f
             LEFT JOIN positions p ON p.address = f.address
         )
         SELECT scored.address,
                scored.trades,
                scored.tokens,
                scored.last_trade_at,
                scored.volume::text          AS volume,
                scored.eth_in::text          AS eth_in,
                scored.eth_out::text         AS eth_out,
                scored.holdings_value::text  AS holdings_value,
                scored.pnl::text             AS pnl
           FROM scored
          ORDER BY ${sort}
          LIMIT $${params.length}`,
        params,
      );

      res.json({ board, window: windowKey, entries });
    }),
  );

  app.get(
    "/creators/:address",
    asyncRoute(async (req, res) => {
      const address = String(req.params.address).toLowerCase();
      if (!isAddress(address)) {
        res.status(400).json({ error: "invalid_address" });
        return;
      }
      const creator = await query(`SELECT * FROM creators WHERE address = $1`, [address]);
      if (creator.length === 0) {
        res.status(404).json({ error: "creator_not_found" });
        return;
      }
      const tokens = await query(
        `SELECT ${TOKEN_COLUMNS} FROM tokens t WHERE t.creator = $1 ORDER BY t.created_at DESC`,
        [address],
      );
      res.json({ creator: creator[0], tokens });
    }),
  );

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));

  return app;
}
