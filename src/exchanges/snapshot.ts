import { getSnapshotAtOrBefore } from "../db.js";
import { pctChange, type OiChange } from "./base.js";
import { snapshotStalenessMs } from "../config.js";

/**
 * OI delta for exchanges that expose only *current* open interest.
 *
 * The scanner writes each poll's OI into `snapshots`; the delta is measured
 * against the newest snapshot that is already at least `windowMinutes` old.
 * Until that much history exists, `deltaPct` is null — expected on a cold
 * start, and it resolves on its own as the worker keeps running.
 */
export function makeSnapshotOiChange(
  exchange: string,
  currentOi: () => Map<string, number>,
) {
  return async (symbol: string, windowMinutes: number): Promise<OiChange> => {
    const oiNow = currentOi().get(symbol);
    if (oiNow === undefined) return { oiNow: 0, oiPrev: 0, deltaPct: null };

    const cutoff = Date.now() - windowMinutes * 60_000;
    const prev = getSnapshotAtOrBefore(exchange, symbol, cutoff, snapshotStalenessMs);
    if (!prev) return { oiNow, oiPrev: 0, deltaPct: null };

    return { oiNow, oiPrev: prev.oi, deltaPct: pctChange(prev.oi, oiNow) };
  };
}
