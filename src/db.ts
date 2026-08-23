import Database from "better-sqlite3";
import { config } from "./config.js";

const db = new Database(config.DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    exchange TEXT NOT NULL,
    symbol   TEXT NOT NULL,
    ts       INTEGER NOT NULL,     -- epoch ms
    oi       REAL NOT NULL,        -- exchange-native units; only ratios are used
    price    REAL NOT NULL,
    PRIMARY KEY (exchange, symbol, ts)
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_lookup
    ON snapshots (exchange, symbol, ts DESC);

  CREATE TABLE IF NOT EXISTS alert_state (
    key             TEXT PRIMARY KEY,   -- "<mode>:<direction>:<base>", e.g. "premove:long:ARB"
    last_alerted_ts INTEGER NOT NULL DEFAULT 0,
    in_bucket       INTEGER NOT NULL DEFAULT 0,
    exchanges       TEXT NOT NULL DEFAULT ''  -- venues covered by the last alert
  );

  -- Every alert ever fired, with its entry price, scored forward in time.
  -- This is what turns the thresholds from guesses into measurements: without
  -- it there is no way to tell whether a factor earns its weight.
  CREATE TABLE IF NOT EXISTS alert_outcomes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    mode          TEXT NOT NULL,
    direction     TEXT NOT NULL,        -- long | short
    base          TEXT NOT NULL,
    exchanges     TEXT NOT NULL,
    entry_price   REAL NOT NULL,
    score         REAL NOT NULL,
    oi_delta_pct  REAL NOT NULL,
    px_window_pct REAL,
    quote_vol_usd REAL NOT NULL,
    funding_rate  REAL NOT NULL,
    -- filled in by later scans, at zero API cost: the universe call already
    -- carries the current price of everything we alerted on.
    -- Features captured AT ALERT TIME, so outcomes can be sliced by them later.
    -- These cannot be backfilled: the OI series that produced a given alert is
    -- not reconstructible after the fact.
    baseline_vol_pct REAL,             -- coin's median |1h move| over ~20d
    oi_concentration REAL,             -- largest bucket's share of the OI rise, 0..1
    vol_ratio        REAL,             -- volume at alert vs its own median hour
    impulse_age_min  REAL,             -- minutes from the biggest OI jump to the alert
    px_15m        REAL,
    px_1h         REAL,
    px_4h         REAL,
    mfe_pct       REAL,                 -- max favourable excursion, signed for direction
    mae_pct       REAL,                 -- max adverse excursion
    last_check_ts INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_outcomes_open
    ON alert_outcomes (ts) WHERE px_4h IS NULL;
`);

// Add outcome feature columns to databases created before they existed. The
// rows already written keep NULLs — the report treats those as unsliceable
// rather than guessing values it cannot recover.
{
  const cols = db.prepare(`PRAGMA table_info(alert_outcomes)`).all() as {
    name: string;
  }[];
  const have = new Set(cols.map((c) => c.name));
  for (const col of [
    "baseline_vol_pct",
    "oi_concentration",
    "vol_ratio",
    "impulse_age_min",
  ]) {
    if (!have.has(col)) {
      db.exec(`ALTER TABLE alert_outcomes ADD COLUMN ${col} REAL`);
    }
  }
}

// Migrate databases created before venue tracking existed.
{
  const cols = db.prepare(`PRAGMA table_info(alert_state)`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "exchanges")) {
    db.exec(
      `ALTER TABLE alert_state ADD COLUMN exchanges TEXT NOT NULL DEFAULT ''`,
    );
  }
}

const insertSnapshot = db.prepare(
  `INSERT OR REPLACE INTO snapshots (exchange, symbol, ts, oi, price)
   VALUES (@exchange, @symbol, @ts, @oi, @price)`,
);

export interface SnapshotRow {
  exchange: string;
  symbol: string;
  ts: number;
  oi: number;
  price: number;
}

const insertMany = db.transaction((rows: SnapshotRow[]) => {
  for (const row of rows) insertSnapshot.run(row);
});

export function recordSnapshots(rows: SnapshotRow[]): void {
  if (rows.length) insertMany(rows);
}

/**
 * Newest snapshot at or before `cutoffTs` — i.e. the closest reading that is
 * already at least `windowMinutes` old. Returns undefined until history exists.
 */
const selectAtOrBefore = db.prepare(
  `SELECT oi, price, ts FROM snapshots
   WHERE exchange = ? AND symbol = ? AND ts <= ? AND ts >= ?
   ORDER BY ts DESC LIMIT 1`,
);

/**
 * Newest snapshot in [cutoffTs - maxStalenessMs, cutoffTs] — the closest
 * reading that is already at least `windowMinutes` old, but not so old that it
 * would measure a different window than the one asked for. Returns undefined
 * when history is missing or has a gap, which callers treat as "no delta yet".
 */
export function getSnapshotAtOrBefore(
  exchange: string,
  symbol: string,
  cutoffTs: number,
  maxStalenessMs: number,
): { oi: number; price: number; ts: number } | undefined {
  return selectAtOrBefore.get(
    exchange,
    symbol,
    cutoffTs,
    cutoffTs - maxStalenessMs,
  ) as { oi: number; price: number; ts: number } | undefined;
}

/** Every snapshot from `sinceTs` onward, oldest first. */
const selectSeries = db.prepare(
  `SELECT ts, oi, price FROM snapshots
   WHERE exchange = ? AND symbol = ? AND ts >= ?
   ORDER BY ts ASC`,
);

export function getSnapshotSeries(
  exchange: string,
  symbol: string,
  sinceTs: number,
): { ts: number; oi: number; price: number }[] {
  return selectSeries.all(exchange, symbol, sinceTs) as {
    ts: number;
    oi: number;
    price: number;
  }[];
}

/** Drop snapshots older than `days` so the file does not grow without bound. */
const pruneStmt = db.prepare(`DELETE FROM snapshots WHERE ts < ?`);
export function pruneSnapshots(days = 7): number {
  return pruneStmt.run(Date.now() - days * 86_400_000).changes;
}

// ---- alert cooldown ---------------------------------------------------------

const selectAlert = db.prepare(
  `SELECT last_alerted_ts, in_bucket, exchanges FROM alert_state WHERE key = ?`,
);

export interface AlertState {
  last_alerted_ts: number;
  in_bucket: number;
  /** Venues the last alert covered, so venue spread can be detected. */
  exchanges: string[];
}

export function getAlertState(key: string): AlertState | undefined {
  const row = selectAlert.get(key) as
    | { last_alerted_ts: number; in_bucket: number; exchanges: string }
    | undefined;
  if (!row) return undefined;
  return {
    last_alerted_ts: row.last_alerted_ts,
    in_bucket: row.in_bucket,
    exchanges: row.exchanges ? row.exchanges.split(",").filter(Boolean) : [],
  };
}

const markAlerted = db.prepare(
  `INSERT INTO alert_state (key, last_alerted_ts, in_bucket, exchanges) VALUES (?, ?, 1, ?)
   ON CONFLICT(key) DO UPDATE SET
     last_alerted_ts = excluded.last_alerted_ts,
     in_bucket = 1,
     exchanges = excluded.exchanges`,
);

const setInBucket = db.prepare(
  `INSERT INTO alert_state (key, last_alerted_ts, in_bucket) VALUES (?, 0, ?)
   ON CONFLICT(key) DO UPDATE SET in_bucket = excluded.in_bucket`,
);

export function recordAlerted(
  entries: { key: string; exchanges: string[] }[],
  ts = Date.now(),
): void {
  const tx = db.transaction(() => {
    for (const e of entries) {
      markAlerted.run(e.key, ts, [...e.exchanges].sort().join(","));
    }
  });
  tx();
}

/**
 * True once anything has ever been alerted. A fresh file means lost state — a
 * new volume, a wiped container — which would otherwise re-alert the entire
 * current bucket on the next scan.
 */
const anyAlert = db.prepare(
  `SELECT 1 FROM alert_state WHERE last_alerted_ts > 0 LIMIT 1`,
);
export function hasAlertHistory(): boolean {
  return anyAlert.get() !== undefined;
}

/**
 * Track bucket membership for the "left the bucket and came back" rule.
 * Anything currently in the bucket is flagged 1; everything else resets to 0.
 */
export function syncBucketMembership(keysInBucket: string[]): void {
  const inBucket = new Set(keysInBucket);
  const tx = db.transaction(() => {
    for (const k of inBucket) setInBucket.run(k, 1);
    db.prepare(
      `UPDATE alert_state SET in_bucket = 0
       WHERE in_bucket = 1 AND key NOT IN (${inBucket.size ? [...inBucket].map(() => "?").join(",") : "''"})`,
    ).run(...inBucket);
  });
  tx();
}

export default db;
