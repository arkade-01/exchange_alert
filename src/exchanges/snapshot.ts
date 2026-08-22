import { getSnapshotSeries } from "../db.js";
import { snapshotStalenessMs } from "../config.js";
import type { OiPoint } from "./base.js";

/**
 * OI history for exchanges that expose only *current* open interest.
 *
 * The scanner writes each poll's OI into `snapshots`; this reads that back as a
 * series and appends the live reading as the newest point, since the current
 * poll has not been persisted yet. Until enough polls have accumulated the
 * series is too short to span the window and deltas come back null — expected
 * on a cold start, and it resolves on its own as the worker keeps running.
 */
export function makeSnapshotOiHistory(
  exchange: string,
  currentOi: () => Map<string, number>,
) {
  return async (
    symbol: string,
    lookbackMinutes: number,
  ): Promise<OiPoint[]> => {
    // Reach back past the window by the staleness allowance, so a reference
    // point sitting just outside the window edge is still available.
    const since = Date.now() - lookbackMinutes * 60_000 - snapshotStalenessMs;
    const points: OiPoint[] = getSnapshotSeries(exchange, symbol, since).map(
      (r) => ({ ts: r.ts, oi: r.oi }),
    );

    const live = currentOi().get(symbol);
    if (live !== undefined && Number.isFinite(live)) {
      points.push({ ts: Date.now(), oi: live });
    }
    return points;
  };
}
