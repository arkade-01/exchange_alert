import pLimit from "p-limit";
import db from "./db.js";
import { config } from "./config.js";
import { getJson } from "./exchanges/base.js";
import { fetchBaseline, oiShape } from "./features.js";
import { MODES, type ModeName } from "./modes.js";

/**
 * Fill in the alert features for rows recorded before those columns existed.
 *
 * This is possible only because Binance serves historical open interest for
 * about 30 days and accepts startTime/endTime — the series behind an old alert
 * is gone from our memory but not from theirs. Rows older than that retention
 * window cannot be recovered, which is why this is worth running promptly.
 */

interface Row {
  id: number;
  ts: number;
  mode: string;
  base: string;
}

const selectMissing = db.prepare(
  `SELECT id, ts, mode, base FROM alert_outcomes
   WHERE oi_concentration IS NULL OR baseline_vol_pct IS NULL
   ORDER BY ts DESC`,
);

const updateFeatures = db.prepare(
  `UPDATE alert_outcomes SET
     baseline_vol_pct = @baselineVolPct,
     oi_concentration = @oiConcentration,
     vol_ratio        = @volRatio,
     impulse_age_min  = @impulseAgeMin
   WHERE id = @id`,
);

interface OiHistPoint {
  sumOpenInterestValue: string;
  timestamp: number;
}

export async function backfill(): Promise<{
  total: number;
  filled: number;
  expired: number;
  failed: number;
}> {
  const rows = selectMissing.all() as Row[];
  // Binance keeps roughly 30 days of OI history; leave a day of margin.
  const horizon = Date.now() - 29 * 86_400_000;

  let filled = 0;
  let expired = 0;
  let failed = 0;

  const limit = pLimit(config.CONCURRENCY);
  await Promise.all(
    rows.map((r) =>
      limit(async () => {
        if (r.ts < horizon) {
          expired++;
          return;
        }
        const mode = MODES[r.mode as ModeName];
        if (!mode) {
          failed++;
          return;
        }

        const symbol = `${r.base}USDT`;
        const windowMs = mode.windowMinutes * 60_000;

        try {
          // Reach a little past the window so the series brackets its edge,
          // exactly as a live scan's lookback does.
          const points = await getJson<OiHistPoint[]>(
            `${config.BINANCE_BASE_URL}/futures/data/openInterestHist` +
              `?symbol=${symbol}&period=5m` +
              `&startTime=${r.ts - windowMs - 600_000}&endTime=${r.ts}&limit=100`,
          );
          const series = (Array.isArray(points) ? points : [])
            .map((p) => ({
              ts: Number(p.timestamp),
              oi: Number(p.sumOpenInterestValue),
            }))
            .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.oi))
            .sort((a, b) => a.ts - b.ts);

          // Measure both as of the ALERT's timestamp, not now — otherwise the
          // features describe a different market than the one that fired.
          const shape = oiShape(series, mode.windowMinutes, r.ts);
          const base = await fetchBaseline(symbol, r.ts);

          if (shape.concentration === null && base.baselineVolPct === null) {
            failed++;
            return;
          }
          updateFeatures.run({
            id: r.id,
            baselineVolPct: base.baselineVolPct,
            volRatio: base.volRatio,
            oiConcentration: shape.concentration,
            impulseAgeMin: shape.impulseAgeMin,
          });
          filled++;
        } catch {
          failed++;
        }
      }),
    ),
  );

  return { total: rows.length, filled, expired, failed };
}
