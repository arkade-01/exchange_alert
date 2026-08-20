import {
  getJson,
  pctChange,
  pickPeriod,
  toBase,
  type Candidate,
  type Exchange,
  type OiChange,
} from "./base.js";
import { config } from "../config.js";

const BASE = config.BINANCE_BASE_URL;

// period -> minutes, per the documented set
const PERIODS = [
  ["5m", 5],
  ["15m", 15],
  ["30m", 30],
  ["1h", 60],
  ["2h", 120],
  ["4h", 240],
  ["6h", 360],
  ["12h", 720],
  ["1d", 1440],
] as const;

interface Ticker24h {
  symbol: string;
  quoteVolume: string;
  priceChangePercent: string;
  lastPrice: string;
}

interface PremiumIndex {
  symbol: string;
  lastFundingRate: string;
}

interface OiHistPoint {
  sumOpenInterestValue: string;
  timestamp: number;
}

export const binance: Exchange = {
  name: "binance",

  async getUniverse(): Promise<Candidate[]> {
    // Two batched calls for the whole universe — never one per symbol.
    const [tickers, premiums] = await Promise.all([
      getJson<Ticker24h[]>(`${BASE}/fapi/v1/ticker/24hr`),
      getJson<PremiumIndex[]>(`${BASE}/fapi/v1/premiumIndex`),
    ]);

    const funding = new Map<string, number>();
    for (const p of premiums) {
      funding.set(p.symbol, Number(p.lastFundingRate));
    }

    return tickers
      // USDT perps only; `_` marks quarterlies/delivery contracts.
      .filter((t) => t.symbol.endsWith("USDT") && !t.symbol.includes("_"))
      .map((t) => ({
        exchange: "binance",
        symbol: t.symbol,
        base: toBase(t.symbol),
        quoteVol24hUsd: Number(t.quoteVolume),
        priceChgPct24h: Number(t.priceChangePercent),
        lastPrice: Number(t.lastPrice),
        fundingRate: funding.get(t.symbol) ?? 0,
      }))
      .filter((c) => Number.isFinite(c.quoteVol24hUsd) && c.lastPrice > 0);
  },

  async getOiChange(symbol: string, windowMinutes: number): Promise<OiChange> {
    const { period, limit } = pickPeriod(PERIODS, windowMinutes, 500);
    const points = await getJson<OiHistPoint[]>(
      `${BASE}/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`,
    );
    if (points.length < 2) return { oiNow: 0, oiPrev: 0, deltaPct: null };

    // Documented ascending, but sort defensively — the delta depends on it.
    const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);
    // USD notional, so cross-symbol comparisons stay meaningful.
    const oiPrev = Number(sorted[0]!.sumOpenInterestValue);
    const oiNow = Number(sorted[sorted.length - 1]!.sumOpenInterestValue);
    return { oiNow, oiPrev, deltaPct: pctChange(oiPrev, oiNow) };
  },
};
