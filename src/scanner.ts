import pLimit from "p-limit";
import { config, snapshotStalenessMs } from "./config.js";
import {
  getAlertState,
  getSnapshotAtOrBefore,
  pruneSnapshots,
  recordAlerted,
  recordSnapshots,
  syncBucketMembership,
  type SnapshotRow,
} from "./db.js";
import { pctChange, type Candidate, type Exchange } from "./exchanges/base.js";
import { resolveExchanges } from "./exchanges/index.js";

export type Classification =
  | "longs building"
  | "shorts building"
  | "short covering"
  | "longs closing"
  | "flat";

/** One (exchange, symbol) that cleared the volume gate and got an OI reading. */
export interface Signal extends Candidate {
  oiNow: number;
  oiPrev: number;
  oiDeltaPct: number;
  /** Price change across the scan window, from snapshots; null before history exists. */
  priceChgPctWindow: number | null;
  classification: Classification;
}

/** Signals for one base asset, merged across every exchange it fired on. */
export interface MergedSignal {
  base: string;
  exchanges: string[];
  oiDeltaPct: number; // strongest across exchanges
  quoteVol24hUsd: number; // summed
  priceChgPct24h: number; // from the strongest exchange
  priceChgPctWindow: number | null;
  fundingRate: number; // volume-weighted
  lastPrice: number;
  score: number;
  /**
   * Venues added since this base was last alerted. Non-empty means a second
   * exchange confirmed an existing signal — that breaks the cooldown, because
   * one venue can be speculation while two agreeing is corroboration.
   */
  confirmedOn: string[];
}

export interface ScanResult {
  windowMinutes: number;
  scannedAt: Date;
  alerts: MergedSignal[];
  /** Cleared every gate but suppressed by the cooldown rule. */
  suppressed: MergedSignal[];
  stats: {
    universe: number;
    afterVolumeGate: number;
    oiFetched: number;
    nullDeltas: number;
    longsBuilding: number;
    merged: number;
    errors: string[];
  };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function classify(oiDelta: number, priceDelta: number): Classification {
  if (oiDelta === 0 || priceDelta === 0) return "flat";
  if (oiDelta > 0) return priceDelta > 0 ? "longs building" : "shorts building";
  return priceDelta > 0 ? "short covering" : "longs closing";
}

/**
 * Composite rank for the longs-building bucket. OI carries the most weight —
 * it is the fresh signal; volume is log-scaled so a $1B name does not drown a
 * $30M mover; funding is a crowding penalty. Every constant is in config.
 */
export function scoreSignal(s: {
  oiDeltaPct: number;
  quoteVol24hUsd: number;
  priceChgPct24h: number;
  priceChgPctWindow: number | null;
  fundingRate: number;
  exchangesFiring: number;
}): number {
  const nOi = clamp01(s.oiDeltaPct / config.NORM_OI_MAX);
  const nVol = clamp01(
    Math.log10(Math.max(s.quoteVol24hUsd, 1) / config.NORM_VOL_FLOOR) /
      config.NORM_VOL_DECADES,
  );
  // Prefer the window move; fall back to the 24h move on a wider scale.
  const nPrice =
    s.priceChgPctWindow !== null
      ? clamp01(s.priceChgPctWindow / config.NORM_PRICE_WINDOW_MAX)
      : clamp01(s.priceChgPct24h / config.NORM_PRICE_24H_MAX);
  const funding = clamp01(Math.abs(s.fundingRate) / config.NORM_FUNDING_MAX);
  const cross =
    Math.min(s.exchangesFiring - 1, config.CROSS_BONUS_MAX_EXTRA) *
    config.CROSS_BONUS;

  return (
    config.W_OI * nOi +
    config.W_VOL * nVol +
    config.W_PRICE * nPrice +
    cross -
    config.W_FUNDING * funding
  );
}

function mergeByBase(signals: Signal[]): MergedSignal[] {
  const groups = new Map<string, Signal[]>();
  for (const s of signals) {
    const list = groups.get(s.base);
    if (list) list.push(s);
    else groups.set(s.base, [s]);
  }

  const merged: MergedSignal[] = [];
  for (const [base, list] of groups) {
    // Representative = the exchange showing the strongest OI build.
    const lead = list.reduce((a, b) => (b.oiDeltaPct > a.oiDeltaPct ? b : a));
    const quoteVol = list.reduce((sum, s) => sum + s.quoteVol24hUsd, 0);
    const fundingRate =
      quoteVol > 0
        ? list.reduce((sum, s) => sum + s.fundingRate * s.quoteVol24hUsd, 0) /
          quoteVol
        : lead.fundingRate;

    merged.push({
      base,
      exchanges: [...new Set(list.map((s) => s.exchange))],
      oiDeltaPct: lead.oiDeltaPct,
      quoteVol24hUsd: quoteVol,
      priceChgPct24h: lead.priceChgPct24h,
      priceChgPctWindow: lead.priceChgPctWindow,
      fundingRate,
      lastPrice: lead.lastPrice,
      score: 0,
      confirmedOn: [],
    });
  }

  for (const m of merged) {
    m.score = scoreSignal({ ...m, exchangesFiring: m.exchanges.length });
  }
  return merged;
}

/**
 * Suppress a repeat alert unless one of three things is true:
 *   1. the base left the bucket and came back,
 *   2. ALERT_COOLDOWN_MIN has elapsed, or
 *   3. the signal spread to an exchange it was not alerted on before.
 *
 * Rule 3 is deliberate: a build on one venue can be a single desk or a thin
 * book, but the same build appearing on a second venue is corroboration, and
 * that is worth interrupting a cooldown for.
 */
export function applyCooldown(merged: MergedSignal[], now: number) {
  const cooldownMs = config.ALERT_COOLDOWN_MIN * 60_000;
  const alerts: MergedSignal[] = [];
  const suppressed: MergedSignal[] = [];

  for (const m of merged) {
    const state = getAlertState(m.base);
    const isNew = !state || state.in_bucket === 0;
    const cooled = state ? now - state.last_alerted_ts >= cooldownMs : true;

    if (isNew || cooled) {
      alerts.push(m);
      continue;
    }

    // Spread only counts when every previously-alerted venue is STILL firing
    // and at least one new one joined. A signal that merely moved from Binance
    // to Bybit has not been confirmed by anything.
    const prev = state!.exchanges;
    const current = new Set(m.exchanges);
    const held = prev.every((v) => current.has(v));
    const added = m.exchanges.filter((v) => !prev.includes(v));

    if (config.ALERT_ON_VENUE_SPREAD && held && added.length > 0) {
      m.confirmedOn = added;
      alerts.push(m);
    } else {
      suppressed.push(m);
    }
  }
  return { alerts, suppressed };
}

export async function scan(
  windowMinutes = config.WINDOW_MINUTES,
): Promise<ScanResult> {
  const scannedAt = new Date();
  const now = scannedAt.getTime();
  const errors: string[] = [];
  const exchanges: Exchange[] = resolveExchanges(config.EXCHANGES);

  // 1. One universe call per exchange, in parallel. A dead exchange must not
  //    take down the scan.
  const universes = await Promise.all(
    exchanges.map(async (ex) => {
      try {
        return { ex, candidates: await ex.getUniverse() };
      } catch (err) {
        errors.push(`${ex.name} universe: ${(err as Error).message}`);
        return { ex, candidates: [] as Candidate[] };
      }
    }),
  );

  const universeCount = universes.reduce((n, u) => n + u.candidates.length, 0);

  // 2. Volume gate before any OI fetch — this is what keeps the fan-out small.
  const gated = universes.map((u) => ({
    ex: u.ex,
    candidates: u.candidates.filter(
      (c) => c.quoteVol24hUsd >= config.MIN_VOLUME,
    ),
  }));
  const afterVolumeGate = gated.reduce((n, g) => n + g.candidates.length, 0);

  // 3. Bounded parallel OI fetch for the survivors.
  const limit = pLimit(config.CONCURRENCY);
  const cutoff = now - windowMinutes * 60_000;
  const signals: Signal[] = [];
  let nullDeltas = 0;

  await Promise.all(
    gated.flatMap(({ ex, candidates }) =>
      candidates.map((c) =>
        limit(async () => {
          try {
            const oi = await ex.getOiChange(c.symbol, windowMinutes);
            if (oi.deltaPct === null) {
              nullDeltas++;
              return;
            }
            const prevSnap = getSnapshotAtOrBefore(
              ex.name,
              c.symbol,
              cutoff,
              snapshotStalenessMs,
            );
            const priceChgPctWindow = prevSnap
              ? pctChange(prevSnap.price, c.lastPrice)
              : null;
            const priceDir = priceChgPctWindow ?? c.priceChgPct24h;
            signals.push({
              ...c,
              oiNow: oi.oiNow,
              oiPrev: oi.oiPrev,
              oiDeltaPct: oi.deltaPct,
              priceChgPctWindow,
              classification: classify(oi.deltaPct, priceDir),
            });
          } catch (err) {
            errors.push(`${ex.name} ${c.symbol}: ${(err as Error).message}`);
          }
        }),
      ),
    ),
  );

  // 4. Persist this poll. Feeds MEXC/Bitget deltas and the window price change
  //    for every exchange on the next run.
  const rows: SnapshotRow[] = [];
  for (const { ex, candidates } of gated) {
    for (const c of candidates) {
      const oi = c.openInterest;
      if (oi === undefined || !Number.isFinite(oi)) continue;
      rows.push({
        exchange: ex.name,
        symbol: c.symbol,
        ts: now,
        oi,
        price: c.lastPrice,
      });
    }
  }
  recordSnapshots(rows);
  pruneSnapshots();

  // 5. Remaining gates, then merge by base asset across exchanges.
  const bucket = signals.filter(
    (s) =>
      s.oiDeltaPct >= config.MIN_OI_DELTA &&
      s.priceChgPct24h <= config.MAX_PCHG_24H &&
      s.classification === "longs building",
  );

  const merged = mergeByBase(bucket).sort((a, b) => b.score - a.score);

  // 6. Cooldown + dedup.
  const { alerts, suppressed } = applyCooldown(merged, now);
  syncBucketMembership(merged.map((m) => m.base));

  return {
    windowMinutes,
    scannedAt,
    alerts: alerts.slice(0, config.MAX_ALERTS),
    suppressed,
    stats: {
      universe: universeCount,
      afterVolumeGate,
      oiFetched: signals.length,
      nullDeltas,
      longsBuilding: bucket.length,
      merged: merged.length,
      errors,
    },
  };
}

/** Commit the cooldown timestamps — only after a send actually succeeds. */
export function commitAlerts(result: ScanResult): void {
  recordAlerted(
    result.alerts.map((a) => ({ key: a.base, exchanges: a.exchanges })),
    result.scannedAt.getTime(),
  );
}

// ---- message formatting -----------------------------------------------------

const EXCHANGE_LABEL: Record<string, string> = {
  binance: "Binance",
  bybit: "Bybit",
  mexc: "MEXC",
  bitget: "Bitget",
};

function fmtWindow(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function fmtUsd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${Math.round(v / 1e6)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

const sign = (v: number) => (v >= 0 ? "+" : "");

export function formatMessage(result: ScanResult): string {
  const { alerts, windowMinutes, scannedAt } = result;
  const time = scannedAt.toISOString().slice(11, 16);
  const win = fmtWindow(windowMinutes);

  if (alerts.length === 0) {
    return (
      `⚪️ <b>OI Scanner</b> — no signals · ${win} window\n` +
      `<i>${time} UTC</i>`
    );
  }

  const header =
    `🟢 <b>OI Scanner</b> — ${alerts.length} signal${alerts.length === 1 ? "" : "s"} · ${win} window\n` +
    `<i>${time} UTC</i>\n`;

  const lines = alerts.map((a, i) => {
    const px =
      a.priceChgPctWindow !== null
        ? `${sign(a.priceChgPctWindow)}${a.priceChgPctWindow.toFixed(1)}%`
        : `${sign(a.priceChgPct24h)}${a.priceChgPct24h.toFixed(1)}% (24h)`;
    const venues = a.exchanges
      .map((e) => EXCHANGE_LABEL[e] ?? e)
      .sort()
      .join(", ");
    const funding = `${sign(a.fundingRate)}${(a.fundingRate * 100).toFixed(3)}%`;

    const confirm = a.confirmedOn.length
      ? `  ⚡ <b>confirmed on ${a.confirmedOn.map((e) => EXCHANGE_LABEL[e] ?? e).join(", ")}</b>`
      : "";

    return (
      `<b>${i + 1}. ${a.base}</b>  score ${a.score.toFixed(2)}${confirm}\n` +
      `  OI <b>${sign(a.oiDeltaPct)}${a.oiDeltaPct.toFixed(1)}%</b> · px ${px} · vol ${fmtUsd(a.quoteVol24hUsd)}\n` +
      `  longs building · ${venues} · funding ${funding}`
    );
  });

  return `${header}\n${lines.join("\n\n")}`;
}
