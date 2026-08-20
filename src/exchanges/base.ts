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

export interface OiChange {
  oiNow: number;
  oiPrev: number;
  /** null when the exchange has not accumulated enough history yet. */
  deltaPct: number | null;
}

export interface Exchange {
  name: string;
  getUniverse(): Promise<Candidate[]>;
  getOiChange(symbol: string, windowMinutes: number): Promise<OiChange>;
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
 * For a 60m window against Binance's periods this yields 5m x 13.
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
    Math.max(2, Math.floor(windowMinutes / chosen[1]) + 1),
  );
  return { period: chosen[0], limit };
}

export function pctChange(prev: number, now: number): number | null {
  if (!Number.isFinite(prev) || !Number.isFinite(now) || prev <= 0) return null;
  return ((now - prev) / prev) * 100;
}

/** Strip the quote leg to get the base asset. Handles BTCUSDT and BTC_USDT. */
export function toBase(symbol: string): string {
  return symbol.replace(/_/g, "").replace(/USDT$/, "");
}
