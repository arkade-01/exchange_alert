import { config } from "../config.js";

export interface Candidate {
  exchange: string;
  symbol: string; // exchange-native, e.g. BTCUSDT / BTC_USDT
  base: string; // BTC
  quoteVol24hUsd: number;
  priceChgPct24h: number;
  lastPrice: number;
  fundingRate: number;
  /** Current open interest in exchange-native units, when the universe call exposes it. */
  openInterest?: number;
}

/** One open-interest reading. Series are returned oldest-first. */
export interface OiPoint {
  ts: number; // epoch ms
  oi: number; // exchange-native units; only ratios are used
}

export interface OiChange {
  oiNow: number;
  oiPrev: number;
  /** null when the exchange has not accumulated enough history yet. */
  deltaPct: number | null;
}

export interface Exchange {
  name: string;
  getUniverse(): Promise<Candidate[]>;
  /**
   * OI readings covering at least `lookbackMinutes`, oldest first.
   *
   * Returning the whole series rather than a single delta is what lets several
   * scan modes with different windows share one HTTP call: a 60m series at 5m
   * resolution answers the 15m question too.
   */
  getOiHistory(symbol: string, lookbackMinutes: number): Promise<OiPoint[]>;
  /**
   * True for exchanges that expose only current OI and therefore need
   * snapshot-and-diff (MEXC, Bitget). The scanner persists their universe
   * before asking for deltas.
   */
  needsSnapshots?: boolean;
}

// ---- shared helpers ---------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET JSON with bounded retries. Public market-data endpoints occasionally drop
 * a connection under fan-out, and 429/418 mean we are being told to slow down;
 * both are worth one more try rather than losing the symbol for the scan.
 */
export async function getJson<T>(url: string, attempts = 3): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(config.HTTP_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });

      if (res.status === 429 || res.status === 418 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        throw Object.assign(
          new Error(`HTTP ${res.status} ${res.statusText} for ${url}`),
          { retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : 0 },
        );
      }
      if (!res.ok) {
        // 4xx other than rate limits is our bug (bad symbol/params) — don't retry.
        throw Object.assign(
          new Error(`HTTP ${res.status} ${res.statusText} for ${url}`),
          { fatal: true },
        );
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if ((err as { fatal?: boolean }).fatal || attempt === attempts) break;
      const hinted = (err as { retryAfterMs?: number }).retryAfterMs ?? 0;
      await sleep(Math.max(hinted, 300 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

/**
 * Pick the finest supported bucket that still spans the window with at least
 * `minBuckets` readings, so oldest-vs-newest actually covers `windowMinutes`.
 * For a 60m window against Binance's periods this yields 5m x 15 — two buckets
 * of margin so the series brackets the target instead of starting exactly on it.
 */
export function pickPeriod<T extends string>(
  periods: ReadonlyArray<readonly [T, number]>,
  windowMinutes: number,
  maxLimit: number,
  minBuckets = 6,
): { period: T; limit: number } {
  const sorted = [...periods].sort((a, b) => a[1] - b[1]);
  let chosen = sorted[0]!;
  for (const p of sorted) {
    if (windowMinutes / p[1] >= minBuckets) chosen = p;
    else break;
  }
  const limit = Math.min(
    maxLimit,
    Math.max(2, Math.floor(windowMinutes / chosen[1]) + 3),
  );
  return { period: chosen[0], limit };
}

export function pctChange(prev: number, now: number): number | null {
  if (!Number.isFinite(prev) || !Number.isFinite(now) || prev <= 0) return null;
  return ((now - prev) / prev) * 100;
}

/** Typical gap between readings — the natural tolerance for reference picking. */
function medianSpacing(sorted: OiPoint[]): number {
  if (sorted.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i]!.ts - sorted[i - 1]!.ts);
  }
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}

/**
 * Delta between the newest reading and the one nearest `windowMinutes` ago.
 *
 * The reference is the *closest* point to the target rather than the newest one
 * before it: exchange buckets are grid-aligned, so a 60m series often starts at
 * 58m and a strict "at or before" rule would reject it outright. Anything
 * further from the target than `toleranceMs` returns a null delta — a gap in
 * history must not silently turn a 15m window into an hour-long one.
 */
export function deltaOverWindow(
  points: OiPoint[],
  windowMinutes: number,
  now = Date.now(),
  toleranceMs?: number,
): OiChange {
  if (points.length < 2) return { oiNow: 0, oiPrev: 0, deltaPct: null };

  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  const newest = sorted[sorted.length - 1]!;
  const tol = toleranceMs ?? Math.max(medianSpacing(sorted) * 1.5, 90_000);
  const target = now - windowMinutes * 60_000;

  let ref = sorted[0]!;
  for (const p of sorted) {
    if (Math.abs(p.ts - target) < Math.abs(ref.ts - target)) ref = p;
  }

  const stale =
    Math.abs(ref.ts - target) > tol || // reference too far from the window edge
    now - newest.ts > tol || //           latest reading itself is stale
    ref.ts >= newest.ts; //               degenerate: no span to measure

  return {
    oiNow: newest.oi,
    oiPrev: ref.oi,
    deltaPct: stale ? null : pctChange(ref.oi, newest.oi),
  };
}

/** Strip the quote leg to get the base asset. Handles BTCUSDT and BTC_USDT. */
export function toBase(symbol: string): string {
  return symbol.replace(/_/g, "").replace(/USDT$/, "");
}
