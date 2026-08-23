import pLimit from "p-limit";
import { config, priceRefStalenessMs } from "./config.js";
import {
  getAlertState,
  getSnapshotAtOrBefore,
  pruneSnapshots,
  recordAlerted,
  recordSnapshots,
  syncBucketMembership,
  type SnapshotRow,
} from "./db.js";
import {
  deltaOverWindow,
  pctChange,
  type Candidate,
  type Exchange,
  type OiPoint,
} from "./exchanges/base.js";
import { resolveExchanges } from "./exchanges/index.js";
import {
  activeModes,
  classify,
  directionOf,
  maxLookbackMinutes,
  type Classification,
  type Direction,
  type Mode,
  type ModeName,
} from "./modes.js";
import { markToMarket, recordOutcomes } from "./tracking.js";
import {
  EMPTY_FEATURES,
  fetchBaseline,
  oiShape,
  type AlertFeatures,
} from "./features.js";

export type { Classification } from "./modes.js";

/** One (exchange, symbol) evaluated against one mode's window. */
export interface Signal extends Candidate {
  oiNow: number;
  oiPrev: number;
  oiDeltaPct: number;
  /** Price change across this mode's window, from snapshots; null before history exists. */
  priceChgPctWindow: number | null;
  classification: Classification;
  /** Shape of the OI build — see features.ts. Free; derived from the series. */
  oiConcentration: number | null;
  impulseAgeMin: number | null;
}

/** Signals for one base asset, merged across every exchange it fired on. */
export interface MergedSignal {
  mode: ModeName;
  direction: Direction;
  base: string;
  exchanges: string[];
  oiDeltaPct: number; // strongest across exchanges
  quoteVol24hUsd: number; // summed
  priceChgPct24h: number; // from the strongest exchange
  priceChgPctWindow: number | null;
  fundingRate: number; // volume-weighted
  lastPrice: number;
  score: number;
  /** Context captured at alert time so the outcome can be explained later. */
  features: AlertFeatures;
  /**
   * Venues added since this base was last alerted. Non-empty means a second
   * exchange confirmed an existing signal — that breaks the cooldown, because
   * one venue can be speculation while two agreeing is corroboration.
   */
  confirmedOn: string[];
}

export interface ModeResult {
  mode: Mode;
  alerts: MergedSignal[];
  /** Cleared every gate but suppressed by the cooldown rule. */
  suppressed: MergedSignal[];
  /** Passed the gates before merging — the size of the raw bucket. */
  bucketCount: number;
  /** Dropped for scoring below the mode's floor. */
  belowScore: number;
}

export interface ScanResult {
  scannedAt: Date;
  modes: ModeResult[];
  stats: {
    universe: number;
    afterVolumeGate: number;
    oiFetched: number;
    nullDeltas: number;
    tracked: number;
    errors: string[];
  };
}

/** Cooldown state is per mode *and* side — a long and a short on the same base
 *  are different claims and must not mute each other. */
const alertKey = (m: { mode: ModeName; direction: Direction; base: string }) =>
  `${m.mode}:${m.direction}:${m.base}`;

function mergeByBase(mode: Mode, signals: Signal[]): MergedSignal[] {
  const groups = new Map<string, Signal[]>();
  for (const s of signals) {
    const dir = directionOf(s.classification);
    if (!dir) continue;
    const key = `${dir}|${s.base}`;
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }

  const merged: MergedSignal[] = [];
  for (const [key, list] of groups) {
    const direction = key.split("|")[0] as Direction;
    // Representative = the exchange showing the strongest OI build.
    const lead = list.reduce((a, b) => (b.oiDeltaPct > a.oiDeltaPct ? b : a));
    const quoteVol = list.reduce((sum, s) => sum + s.quoteVol24hUsd, 0);
    const fundingRate =
      quoteVol > 0
        ? list.reduce((sum, s) => sum + s.fundingRate * s.quoteVol24hUsd, 0) /
          quoteVol
        : lead.fundingRate;

    merged.push({
      mode: mode.name,
      direction,
      base: lead.base,
      exchanges: [...new Set(list.map((s) => s.exchange))],
      oiDeltaPct: lead.oiDeltaPct,
      quoteVol24hUsd: quoteVol,
      priceChgPct24h: lead.priceChgPct24h,
      priceChgPctWindow: lead.priceChgPctWindow,
      fundingRate,
      lastPrice: lead.lastPrice,
      score: 0,
      // Baseline volatility needs a network call and is filled in later, for
      // alerts only — there is no point fetching it for a name we suppress.
      features: {
        ...EMPTY_FEATURES,
        oiConcentration: lead.oiConcentration,
        impulseAgeMin: lead.impulseAgeMin,
      },
      confirmedOn: [],
    });
  }

  for (const m of merged) {
    m.score = mode.score({ ...m, exchangesFiring: m.exchanges.length });
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
    const state = getAlertState(alertKey(m));
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

export async function scan(): Promise<ScanResult> {
  const scannedAt = new Date();
  const now = scannedAt.getTime();
  const errors: string[] = [];
  const exchanges: Exchange[] = resolveExchanges(config.EXCHANGES);
  const modes = activeModes();
  const lookback = maxLookbackMinutes(modes);

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

  // 3. Bounded parallel OI fetch — ONE call per symbol at the deepest lookback
  //    any active mode needs. Every mode's window is then derived from the same
  //    series, so running both modes costs no extra requests.
  const limit = pLimit(config.CONCURRENCY);
  const series: { ex: Exchange; c: Candidate; points: OiPoint[] }[] = [];

  await Promise.all(
    gated.flatMap(({ ex, candidates }) =>
      candidates.map((c) =>
        limit(async () => {
          try {
            const points = await ex.getOiHistory(c.symbol, lookback);
            if (points.length) series.push({ ex, c, points });
          } catch (err) {
            errors.push(`${ex.name} ${c.symbol}: ${(err as Error).message}`);
          }
        }),
      ),
    ),
  );

  // 4. Persist this poll. Feeds MEXC/Bitget deltas and the window price change
  //    for every exchange on the next run. Exchanges whose universe call omits
  //    OI (Binance) get it from the history fetch, so they are not left out of
  //    the snapshot table — without this their window price change is always null.
  const rows: SnapshotRow[] = [];
  for (const { ex, c, points } of series) {
    const oi = c.openInterest ?? points[points.length - 1]?.oi;
    if (oi === undefined || !Number.isFinite(oi)) continue;
    rows.push({
      exchange: ex.name,
      symbol: c.symbol,
      ts: now,
      oi,
      price: c.lastPrice,
    });
  }
  recordSnapshots(rows);
  pruneSnapshots();

  // 5. Evaluate each mode against the shared series.
  let nullDeltas = 0;
  const modeResults: ModeResult[] = [];

  for (const mode of modes) {
    const cutoff = now - mode.windowMinutes * 60_000;
    const bucket: Signal[] = [];

    for (const { ex, c, points } of series) {
      const oi = deltaOverWindow(points, mode.windowMinutes, now);
      if (oi.deltaPct === null) {
        nullDeltas++;
        continue;
      }

      const prevSnap = getSnapshotAtOrBefore(
        ex.name,
        c.symbol,
        cutoff,
        priceRefStalenessMs,
      );
      const priceChgPctWindow = prevSnap
        ? pctChange(prevSnap.price, c.lastPrice)
        : null;

      // Direction comes from the window move when we have it. Falling back to
      // the 24h move would classify a name on a move that already finished.
      const priceDir = priceChgPctWindow ?? c.priceChgPct24h;
      const classification = classify(oi.deltaPct, priceDir);

      if (oi.deltaPct < mode.minOiDelta) continue;
      if (!mode.accepts(classification)) continue;
      if (!mode.admits({ priceChgPct24h: c.priceChgPct24h, priceChgPctWindow }))
        continue;

      const shape = oiShape(points, mode.windowMinutes, now);
      bucket.push({
        ...c,
        oiConcentration: shape.concentration,
        impulseAgeMin: shape.impulseAgeMin,
        oiNow: oi.oiNow,
        oiPrev: oi.oiPrev,
        oiDeltaPct: oi.deltaPct,
        priceChgPctWindow,
        classification,
      });
    }

    const merged = mergeByBase(mode, bucket);
    const ranked = merged
      .filter((m) => m.score >= mode.minScore)
      .sort((a, b) => b.score - a.score);
    const belowScore = merged.length - ranked.length;

    const { alerts, suppressed } = applyCooldown(ranked, now);
    syncBucketMembership(ranked.map((m) => alertKey(m)));

    modeResults.push({
      mode,
      alerts: alerts.slice(0, config.MAX_ALERTS),
      suppressed,
      bucketCount: bucket.length,
      belowScore,
    });
  }

  // 6. Baseline volatility for the alerts we are actually sending. One call
  //    each, a handful per scan — never for the whole universe. Without it a
  //    return is uncomparable across coins: +0.8% is a strong hour on a quiet
  //    name and noise on a violent one.
  if (config.TRACK_OUTCOMES) {
    const firing = modeResults.flatMap((m) => m.alerts);
    await Promise.all(
      firing.map((a) =>
        limit(async () => {
          const base = await fetchBaseline(`${a.base}USDT`);
          a.features = { ...a.features, ...base };
        }),
      ),
    );
  }

  // 7. Mark open alerts to market. The universe already carries every current
  //    price, so scoring past signals forward costs nothing.
  let tracked = 0;
  if (config.TRACK_OUTCOMES) {
    const prices = new Map<string, number>();
    for (const { candidates } of gated) {
      for (const c of candidates) {
        if (c.lastPrice > 0) prices.set(c.base, c.lastPrice);
      }
    }
    tracked = markToMarket(prices, now);
  }

  return {
    scannedAt,
    modes: modeResults,
    stats: {
      universe: universeCount,
      afterVolumeGate,
      oiFetched: series.length,
      nullDeltas,
      tracked,
      errors,
    },
  };
}

/** Commit cooldowns and record outcomes — only after a send actually succeeds. */
export function commitAlerts(result: ScanResult): void {
  const ts = result.scannedAt.getTime();
  const all = result.modes.flatMap((m) => m.alerts);
  if (!all.length) return;

  recordAlerted(
    all.map((a) => ({ key: alertKey(a), exchanges: a.exchanges })),
    ts,
  );

  if (config.TRACK_OUTCOMES) {
    recordOutcomes(
      all.map((a) => ({
        mode: a.mode,
        direction: a.direction,
        base: a.base,
        exchanges: a.exchanges,
        entryPrice: a.lastPrice,
        score: a.score,
        oiDeltaPct: a.oiDeltaPct,
        pxWindowPct: a.priceChgPctWindow,
        quoteVolUsd: a.quoteVol24hUsd,
        fundingRate: a.fundingRate,
        features: a.features,
      })),
      ts,
    );
  }
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

/** TradingView deep link for the venue showing the strongest build. */
function chartUrl(a: MergedSignal): string {
  const venue = (a.exchanges[0] ?? "binance").toUpperCase();
  return `https://www.tradingview.com/chart/?symbol=${venue}:${a.base}USDT.P`;
}

/** "this hour" reads better than "1h window" for the common case. */
function windowPhrase(minutes: number): string {
  if (minutes === 60) return "this hour";
  if (minutes % 1440 === 0) return `in ${minutes / 1440}d`;
  if (minutes % 60 === 0) return `in ${minutes / 60}h`;
  return `in ${minutes} min`;
}

/** Is the crowd already paying to hold this side? */
function fundingPhrase(f: number): string {
  const a = Math.abs(f);
  if (a < 0.0002) return "funding calm";
  if (a < 0.0005) return f > 0 ? "longs paying a little" : "shorts paying a little";
  return f > 0 ? "⚠️ longs paying up" : "⚠️ shorts paying up";
}

function pricePhrase(a: MergedSignal): string {
  const p = a.priceChgPctWindow;
  if (p === null) {
    return `price ${sign(a.priceChgPct24h)}${a.priceChgPct24h.toFixed(1)}% today`;
  }
  if (Math.abs(p) < 0.5) return `price flat (${sign(p)}${p.toFixed(1)}%)`;
  return `price ${sign(p)}${p.toFixed(1)}%`;
}

/**
 * What the OI/price combination actually means, in words. This is the whole
 * point of the alert: price rising on *new* positions is different from price
 * rising because shorts are being forced out, and the two look identical on a
 * chart.
 */
function headline(a: MergedSignal, mode: Mode): string {
  if (mode.name === "premove") {
    return a.direction === "long"
      ? "🤫 <b>Quiet build · long side</b> — positions growing while price sits still"
      : "🤫 <b>Quiet build · short side</b> — short positions growing while price sits still";
  }
  return "📈 <b>New longs building</b> — fresh buying, not shorts covering";
}

export function formatModeMessage(
  result: ModeResult,
  scannedAt: Date,
): string {
  const { mode, alerts } = result;
  const time = scannedAt.toISOString().slice(11, 16);
  const win = fmtWindow(mode.windowMinutes);

  if (alerts.length === 0) {
    return (
      `⚪️ <b>${mode.label}</b> · nothing right now · ${win} window\n` +
      `<i>${time} UTC</i>`
    );
  }

  const header =
    `${mode.emoji} <b>${mode.label}</b> · ${alerts.length} coin${alerts.length === 1 ? "" : "s"} · ${mode.tagline}\n` +
    `<i>${time} UTC · looking back ${win}</i>\n`;

  const lines = alerts.map((a, i) => {
    const venues = a.exchanges
      .map((e) => EXCHANGE_LABEL[e] ?? e)
      .sort()
      .join(", ");

    // Caveats the reader would otherwise have to infer from raw numbers.
    const notes: string[] = [venues, fundingPhrase(a.fundingRate)];
    if (a.quoteVol24hUsd < 25e6) notes.push("⚠️ thin book");
    if (a.exchanges.length > 1) notes.push(`⚡ ${a.exchanges.length} exchanges agree`);
    if (a.confirmedOn.length) {
      notes.push(
        `⚡ just confirmed on ${a.confirmedOn.map((e) => EXCHANGE_LABEL[e] ?? e).join(", ")}`,
      );
    }

    return (
      `<b>${i + 1}. <a href="${chartUrl(a)}">${a.base}</a></b>  score ${Math.round(a.score * 100)}\n` +
      `${headline(a, mode)}\n` +
      `Open positions <b>${sign(a.oiDeltaPct)}${a.oiDeltaPct.toFixed(1)}%</b> ${windowPhrase(mode.windowMinutes)} · ` +
      `${pricePhrase(a)} · ${fmtUsd(a.quoteVol24hUsd)}/day\n` +
      `<i>${notes.join(" · ")}</i>`
    );
  });

  return (
    `${header}\n${lines.join("\n\n")}\n\n` +
    `<i>Candidates to look at — not trade calls.</i>`
  );
}

/** Every mode's message, joined. Modes with nothing to say stay silent. */
export function formatMessage(result: ScanResult, includeEmpty = false): string {
  const parts = result.modes
    .filter((m) => includeEmpty || m.alerts.length > 0)
    .map((m) => formatModeMessage(m, result.scannedAt));

  if (!parts.length && includeEmpty) {
    return formatModeMessage(result.modes[0]!, result.scannedAt);
  }
  return parts.join("\n\n");
}
