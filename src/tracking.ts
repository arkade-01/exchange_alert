import db from "./db.js";
import type { Direction, ModeName } from "./modes.js";
import type { AlertFeatures } from "./features.js";

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
  features: AlertFeatures;
}

const insertOutcome = db.prepare(
  `INSERT INTO alert_outcomes
     (ts, mode, direction, base, exchanges, entry_price, score,
      oi_delta_pct, px_window_pct, quote_vol_usd, funding_rate, last_check_ts,
      baseline_vol_pct, oi_concentration, vol_ratio, impulse_age_min)
   VALUES (@ts, @mode, @direction, @base, @exchanges, @entryPrice, @score,
           @oiDeltaPct, @pxWindowPct, @quoteVolUsd, @fundingRate, @ts,
           @baselineVolPct, @oiConcentration, @volRatio, @impulseAgeMin)`,
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
        baselineVolPct: e.features.baselineVolPct,
        oiConcentration: e.features.oiConcentration,
        volRatio: e.features.volRatio,
        impulseAgeMin: e.features.impulseAgeMin,
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

interface ReportRow {
  mode: string;
  direction: string;
  entry_price: number;
  mfe_pct: number | null;
  mae_pct: number | null;
  px_1h: number | null;
  px_4h: number | null;
  baseline_vol_pct: number | null;
  oi_concentration: number | null;
  vol_ratio: number | null;
  impulse_age_min: number | null;
}

const selectAll = db.prepare(
  `SELECT mode, direction, entry_price, mfe_pct, mae_pct, px_1h, px_4h,
          baseline_vol_pct, oi_concentration, vol_ratio, impulse_age_min
   FROM alert_outcomes WHERE ts >= ?`,
);

export interface Summary {
  label: string;
  n: number;
  settled: number;
  ret1h: number | null;
  ret4h: number | null;
  /**
   * The 4h return in units of the coin's own median hourly move. This is the
   * only figure that compares across coins: +0.8% is a strong hour on a quiet
   * name and noise on a violent one, and a raw average silently mixes them.
   */
  norm4h: number | null;
  mfe: number | null;
  mae: number | null;
  winRate: number | null;
}

const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

/** Return at a mark, signed for the alert's direction. */
function retAt(r: ReportRow, px: number | null): number | null {
  if (px === null || !(r.entry_price > 0)) return null;
  const raw = ((px - r.entry_price) / r.entry_price) * 100;
  return r.direction === "short" ? -raw : raw;
}

function summarize(label: string, rows: ReportRow[]): Summary {
  const r1 = rows.map((r) => retAt(r, r.px_1h)).filter((x): x is number => x !== null);
  const r4 = rows.map((r) => retAt(r, r.px_4h)).filter((x): x is number => x !== null);

  const norm = rows
    .map((r) => {
      const ret = retAt(r, r.px_4h);
      if (ret === null || !r.baseline_vol_pct || r.baseline_vol_pct <= 0) return null;
      return ret / r.baseline_vol_pct;
    })
    .filter((x): x is number => x !== null);

  return {
    label,
    n: rows.length,
    settled: rows.filter((r) => r.px_4h !== null).length,
    ret1h: mean(r1),
    ret4h: mean(r4),
    norm4h: mean(norm),
    mfe: mean(rows.map((r) => r.mfe_pct).filter((x): x is number => x !== null)),
    mae: mean(rows.map((r) => r.mae_pct).filter((x): x is number => x !== null)),
    winRate: r4.length ? r4.filter((x) => x > 0).length / r4.length : null,
  };
}

function groupBy(rows: ReportRow[], key: (r: ReportRow) => string | null) {
  const g = new Map<string, ReportRow[]>();
  for (const r of rows) {
    const k = key(r);
    if (k === null) continue;
    const list = g.get(k);
    if (list) list.push(r);
    else g.set(k, [r]);
  }
  return g;
}

/**
 * How lumpy the OI build was. The composite score sees only the total OI
 * change, so a violent one-bucket spike and a patient hour-long accumulation
 * can score identically — this is the split that tells them apart.
 */
function shapeBucket(c: number | null): string | null {
  if (c === null) return null;
  if (c < 0.3) return "sustained";
  if (c <= 0.6) return "mixed";
  return "spike";
}

export interface Report {
  byMode: Summary[];
  byShape: Summary[];
  byLateness: Summary[];
  total: number;
}

export function outcomeStats(sinceDays = 30): Report {
  const rows = selectAll.all(Date.now() - sinceDays * 86_400_000) as ReportRow[];

  const byMode = [...groupBy(rows, (r) => `${r.mode} ${r.direction}`)]
    .map(([k, v]) => summarize(k, v))
    .sort((a, b) => b.n - a.n);

  const order = ["sustained", "mixed", "spike"];
  const byShape = [...groupBy(rows, (r) => shapeBucket(r.oi_concentration))]
    .map(([k, v]) => summarize(k, v))
    .sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));

  const byLateness = [...groupBy(rows, (r) =>
    r.impulse_age_min === null
      ? null
      : r.impulse_age_min <= 15
        ? "fresh (<15m)"
        : r.impulse_age_min <= 40
          ? "late (15-40m)"
          : "stale (>40m)",
  )]
    .map(([k, v]) => summarize(k, v))
    .sort((a, b) => a.label.localeCompare(b.label));

  return { byMode, byShape, byLateness, total: rows.length };
}

const pct = (x: number | null, d = 2) =>
  x === null ? "   —  " : `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;
const sigma = (x: number | null) =>
  x === null ? "   —  " : `${x >= 0 ? "+" : ""}${x.toFixed(2)}s`;
const rate = (x: number | null) => (x === null ? "  — " : `${(x * 100).toFixed(0)}%`);

function table(title: string, rows: Summary[], note?: string): string[] {
  if (!rows.length) return [];
  const out = [
    "",
    title,
    "label            n  done     +1h      +4h   vs base   win     MFE     MAE",
    "-".repeat(74),
  ];
  for (const s of rows) {
    out.push(
      `${s.label.padEnd(14)} ${String(s.n).padStart(3)} ${String(s.settled).padStart(5)}  ` +
        `${pct(s.ret1h).padStart(7)} ${pct(s.ret4h).padStart(7)} ${sigma(s.norm4h).padStart(8)} ` +
        `${rate(s.winRate).padStart(5)} ${pct(s.mfe).padStart(7)} ${pct(s.mae).padStart(7)}`,
    );
  }
  if (note) out.push(note);
  return out;
}

export function formatReport(rep: Report, sinceDays: number): string {
  if (!rep.total) return `No alerts recorded in the last ${sinceDays} days.`;

  const lines = [`Alert outcomes - last ${sinceDays}d - ${rep.total} alerts`];
  lines.push(...table("BY MODE", rep.byMode));
  lines.push(
    ...table(
      "BY OI SHAPE",
      rep.byShape,
      "  sustained = OI built steadily; spike = one bucket did most of it",
    ),
  );
  lines.push(
    ...table(
      "BY ENTRY LATENESS",
      rep.byLateness,
      "  minutes between the largest OI jump and the alert",
    ),
  );
  lines.push(
    "",
    "'vs base' is the 4h return in units of that coin's median hourly move -",
    "the only column comparable across coins. Anything under ~1s is noise.",
    "Rows need ~30 alerts before a difference between them means anything.",
  );
  return lines.join("\n");
}
