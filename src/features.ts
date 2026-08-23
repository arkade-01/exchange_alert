import { getJson, type OiPoint } from "./exchanges/base.js";
import { config } from "./config.js";

/**
 * Context captured at alert time so outcomes can be explained later.
 *
 * None of this can be reconstructed after the fact — the OI series that
 * produced a given alert is gone by the next scan, and a coin's volatility at
 * the moment of the alert is not the same as its volatility a week later. If a
 * field is not recorded now, that alert is permanently unsliceable.
 */
export interface AlertFeatures {
  /** Median absolute 1h return over the sample — the coin's own noise floor. */
  baselineVolPct: number | null;
  /** Share of the window's OI rise contributed by its single largest bucket. */
  oiConcentration: number | null;
  /** Volume in the latest hour against the median hour. 1 = typical. */
  volRatio: number | null;
  /** Minutes between the largest OI jump and now — how late the alert is. */
  impulseAgeMin: number | null;
}

export const EMPTY_FEATURES: AlertFeatures = {
  baselineVolPct: null,
  oiConcentration: null,
  volRatio: null,
  impulseAgeMin: null,
};

/**
 * How lumpy the OI build was.
 *
 * A single bucket doing all the work (concentration near 1) is a spike that may
 * unwind as fast as it appeared; the same total spread evenly across the window
 * is sustained accumulation. The composite score cannot tell these apart — it
 * only sees the total — so recording the shape is what makes the difference
 * testable.
 */
export function oiShape(
  points: OiPoint[],
  windowMinutes: number,
  now: number,
): { concentration: number | null; impulseAgeMin: number | null } {
  const cutoff = now - windowMinutes * 60_000;
  const win = points.filter((p) => p.ts >= cutoff).sort((a, b) => a.ts - b.ts);
  if (win.length < 3) return { concentration: null, impulseAgeMin: null };

  let totalRise = 0;
  let maxRise = 0;
  let maxAt = win[0]!.ts;

  for (let i = 1; i < win.length; i++) {
    const d = win[i]!.oi - win[i - 1]!.oi;
    if (d <= 0) continue;
    totalRise += d;
    if (d > maxRise) {
      maxRise = d;
      maxAt = win[i]!.ts;
    }
  }
  if (totalRise <= 0) return { concentration: null, impulseAgeMin: null };

  return {
    concentration: maxRise / totalRise,
    impulseAgeMin: Math.round((now - maxAt) / 60_000),
  };
}

interface Kline {
  0: number; // open time
  1: string; // open
  4: string; // close
  7: string; // quote volume
}

/**
 * Baseline volatility and current participation, from one klines call.
 *
 * Fetched only for coins we actually alert on — a handful per scan, not the
 * whole universe. Without the baseline every outcome is uncomparable: +0.8% is
 * a strong hour on a quiet coin and noise on a violent one.
 */
export async function fetchBaseline(
  symbol: string,
): Promise<Pick<AlertFeatures, "baselineVolPct" | "volRatio">> {
  try {
    const kl = await getJson<Kline[]>(
      `${config.BINANCE_BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=500`,
    );
    if (kl.length < 24) return { baselineVolPct: null, volRatio: null };

    const rets: number[] = [];
    const vols: number[] = [];
    for (const k of kl) {
      const open = Number(k[1]);
      const close = Number(k[4]);
      const vol = Number(k[7]);
      if (open > 0 && Number.isFinite(close)) {
        rets.push(Math.abs((close / open - 1) * 100));
      }
      if (Number.isFinite(vol)) vols.push(vol);
    }
    if (!rets.length || !vols.length) {
      return { baselineVolPct: null, volRatio: null };
    }

    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)]!;
    };

    const medVol = median(vols);
    return {
      baselineVolPct: median(rets),
      // Latest bar against a typical one. Volume dying into an alert is the
      // signature of a move that already happened.
      volRatio: medVol > 0 ? vols[vols.length - 1]! / medVol : null,
    };
  } catch {
    // A missing baseline must never cost us the alert itself.
    return { baselineVolPct: null, volRatio: null };
  }
}
