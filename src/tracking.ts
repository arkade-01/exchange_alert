import db from "./db.js";
import type { Direction, ModeName } from "./modes.js";

/**
 * Post-signal performance tracking.
 *
 * Every alert is written with its entry price and then scored forward on later
 * scans. This costs nothing: the universe call each scan already carries the
 * current price of every base we have ever alerted on, so marking positions to
 * market is a database write, not an HTTP request.
 *
 * The point is to make the thresholds falsifiable. Without this there is no way
 * to tell whether the OI weight, the quiet term, or the funding penalty is
 * earning its place — only whether the alerts feel plausible.
 */

export interface OutcomeEntry {
  mode: ModeName;
  direction: Direction;
  base: string;
  exchanges: string[];
  entryPrice: number;
  score: number;
  oiDeltaPct: number;
  pxWindowPct: number | null;
  quoteVolUsd: number;
  fundingRate: number;
}

const insertOutcome = db.prepare(
  `INSERT INTO alert_outcomes
     (ts, mode, direction, base, exchanges, entry_price, score,
      oi_delta_pct, px_window_pct, quote_vol_usd, funding_rate, last_check_ts)
   VALUES (@ts, @mode, @direction, @base, @exchanges, @entryPrice, @score,
           @oiDeltaPct, @pxWindowPct, @quoteVolUsd, @fundingRate, @ts)`,
);

export function recordOutcomes(entries: OutcomeEntry[], ts: number): void {
  if (!entries.length) return;
  const tx = db.transaction(() => {
    for (const e of entries) {
      insertOutcome.run({
        ts,
        mode: e.mode,
        direction: e.direction,
        base: e.base,
        exchanges: [...e.exchanges].sort().join(","),
        entryPrice: e.entryPrice,
        score: e.score,
        oiDeltaPct: e.oiDeltaPct,
        pxWindowPct: e.pxWindowPct,
        quoteVolUsd: e.quoteVolUsd,
        fundingRate: e.fundingRate,
      });
    }
  });
  tx();
}

interface OpenRow {
  id: number;
  ts: number;
  base: string;
  direction: Direction;
  entry_price: number;
  mfe_pct: number | null;
  mae_pct: number | null;
  px_15m: number | null;
  px_1h: number | null;
  px_4h: number | null;
}

// Anything still inside the 4h scoring horizon, plus a grace margin so a row
// that went unchecked while the worker was down still gets its final marks.
const selectOpen = db.prepare(
  `SELECT id, ts, base, direction, entry_price, mfe_pct, mae_pct, px_15m, px_1h, px_4h
   FROM alert_outcomes
   WHERE px_4h IS NULL AND ts >= ?`,
);

const updateOutcome = db.prepare(
  `UPDATE alert_outcomes SET
     mfe_pct = @mfe, mae_pct = @mae,
     px_15m = @px15m, px_1h = @px1h, px_4h = @px4h,
     last_check_ts = @now
   WHERE id = @id`,
);

const HORIZON_MS = 4 * 3_600_000;
const GRACE_MS = 24 * 3_600_000;

/**
 * Mark every open alert to market. `prices` is keyed by base asset — whatever
 * the current scan's universe returned.
 *
 * Excursions are signed *for the alert's direction*: a short that falls 3%
 * records +3 MFE, so long and short performance aggregate on one scale.
 */
export function markToMarket(
  prices: Map<string, number>,
  now = Date.now(),
): number {
  const rows = selectOpen.all(now - HORIZON_MS - GRACE_MS) as OpenRow[];
  if (!rows.length) return 0;

  let touched = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const price = prices.get(r.base);
      if (price === undefined || !(price > 0) || !(r.entry_price > 0)) continue;

      const raw = ((price - r.entry_price) / r.entry_price) * 100;
      const ret = r.direction === "short" ? -raw : raw;
      const age = now - r.ts;

      updateOutcome.run({
        id: r.id,
        now,
        mfe: r.mfe_pct === null ? ret : Math.max(r.mfe_pct, ret),
        mae: r.mae_pct === null ? ret : Math.min(r.mae_pct, ret),
        // Stamped on the first check at or after each mark. A gap in uptime
        // shifts a stamp later rather than losing it.
        px15m: r.px_15m ?? (age >= 15 * 60_000 ? price : null),
        px1h: r.px_1h ?? (age >= 3_600_000 ? price : null),
        px4h: r.px_4h ?? (age >= HORIZON_MS ? price : null),
      });
      touched++;
    }
  });
  tx();
  return touched;
}

// ---- reporting --------------------------------------------------------------

export interface ModeStats {
  mode: string;
  direction: string;
  n: number;
  settled: number;
  avgMfe: number;
  avgMae: number;
  avgRet1h: number | null;
  avgRet4h: number | null;
  hit1: number;
  hit2: number;
  hit5: number;
}

const selectAll = db.prepare(
  `SELECT mode, direction, entry_price, mfe_pct, mae_pct, px_1h, px_4h
   FROM alert_outcomes WHERE ts >= ?`,
);

interface ReportRow {
  mode: string;
  direction: string;
  entry_price: number;
  mfe_pct: number | null;
  mae_pct: number | null;
  px_1h: number | null;
  px_4h: number | null;
}

export function outcomeStats(sinceDays = 30): ModeStats[] {
  const rows = selectAll.all(
    Date.now() - sinceDays * 86_400_000,
  ) as ReportRow[];

  const groups = new Map<string, ReportRow[]>();
  for (const r of rows) {
    const k = `${r.mode}|${r.direction}`;
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }

  const ret = (r: ReportRow, px: number | null) => {
    if (px === null || !(r.entry_price > 0)) return null;
    const raw = ((px - r.entry_price) / r.entry_price) * 100;
    return r.direction === "short" ? -raw : raw;
  };
  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

  const out: ModeStats[] = [];
  for (const [key, list] of groups) {
    const [mode, direction] = key.split("|") as [string, string];
    const scored = list.filter((r) => r.mfe_pct !== null);
    const mfes = scored.map((r) => r.mfe_pct!);
    const r1h = list.map((r) => ret(r, r.px_1h)).filter((x): x is number => x !== null);
    const r4h = list.map((r) => ret(r, r.px_4h)).filter((x): x is number => x !== null);
    const share = (t: number) =>
      scored.length ? mfes.filter((m) => m >= t).length / scored.length : 0;

    out.push({
      mode,
      direction,
      n: list.length,
      settled: list.filter((r) => r.px_4h !== null).length,
      avgMfe: mean(mfes),
      avgMae: mean(scored.map((r) => r.mae_pct!)),
      avgRet1h: r1h.length ? mean(r1h) : null,
      avgRet4h: r4h.length ? mean(r4h) : null,
      hit1: share(1),
      hit2: share(2),
      hit5: share(5),
    });
  }
  return out.sort((a, b) => b.n - a.n);
}

export function formatReport(stats: ModeStats[], sinceDays: number): string {
  if (!stats.length) {
    return `No alerts recorded in the last ${sinceDays} days.`;
  }
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const num = (x: number | null, d = 2) =>
    x === null ? "  —  " : `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;

  const lines = [
    `Alert outcomes · last ${sinceDays}d`,
    "",
    "mode      dir    n  settled   avgMFE   avgMAE    +1h     +4h   ≥1%  ≥2%  ≥5%",
    "─".repeat(78),
  ];
  for (const s of stats) {
    lines.push(
      `${s.mode.padEnd(9)} ${s.direction.padEnd(5)} ${String(s.n).padStart(3)} ` +
        `${String(s.settled).padStart(7)}  ${num(s.avgMfe).padStart(7)}  ` +
        `${num(s.avgMae).padStart(7)}  ${num(s.avgRet1h).padStart(6)}  ` +
        `${num(s.avgRet4h).padStart(6)}  ${pct(s.hit1).padStart(4)} ` +
        `${pct(s.hit2).padStart(4)} ${pct(s.hit5).padStart(4)}`,
    );
  }
  lines.push(
    "",
    "MFE/MAE are signed for the alert's direction, so shorts and longs share a scale.",
    "`settled` counts alerts that have reached the full 4h horizon.",
  );
  return lines.join("\n");
}
