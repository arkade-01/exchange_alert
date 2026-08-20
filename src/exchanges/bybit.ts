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

const BASE = config.BYBIT_BASE_URL;

const INTERVALS = [
  ["5min", 5],
  ["15min", 15],
  ["30min", 30],
  ["1h", 60],
  ["4h", 240],
  ["1d", 1440],
] as const;

interface BybitEnvelope<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

interface TickerRow {
  symbol: string;
  lastPrice: string;
  price24hPcnt: string; // decimal: 0.05 = 5%
  turnover24h: string;
  openInterest: string;
  fundingRate: string;
}

interface OiRow {
  openInterest: string;
  timestamp: string;
}

async function bybitGet<T>(path: string): Promise<T> {
  const body = await getJson<BybitEnvelope<T>>(`${BASE}${path}`);
  if (body.retCode !== 0) {
    throw new Error(`Bybit ${path}: retCode ${body.retCode} ${body.retMsg}`);
  }
  return body.result;
}

export const bybit: Exchange = {
  name: "bybit",

  async getUniverse(): Promise<Candidate[]> {
    // One rich call covers universe, volume, price, OI and funding.
    const result = await bybitGet<{ list: TickerRow[] }>(
      "/v5/market/tickers?category=linear",
    );

    return result.list
      // linear also carries USDC perps; keep the USDT leg only.
      .filter((t) => t.symbol.endsWith("USDT"))
      .map((t) => ({
        exchange: "bybit",
        symbol: t.symbol,
        base: toBase(t.symbol),
        quoteVol24hUsd: Number(t.turnover24h),
        priceChgPct24h: Number(t.price24hPcnt) * 100, // decimal -> percent
        lastPrice: Number(t.lastPrice),
        fundingRate: Number(t.fundingRate) || 0,
        openInterest: Number(t.openInterest),
      }))
      .filter((c) => Number.isFinite(c.quoteVol24hUsd) && c.lastPrice > 0);
  },

  async getOiChange(symbol: string, windowMinutes: number): Promise<OiChange> {
    const { period, limit } = pickPeriod(INTERVALS, windowMinutes, 200);
    const result = await bybitGet<{ list: OiRow[] }>(
      `/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=${period}&limit=${limit}`,
    );
    if (!result.list || result.list.length < 2) {
      return { oiNow: 0, oiPrev: 0, deltaPct: null };
    }

    // Bybit returns newest-first — sorting is mandatory, not defensive.
    const sorted = [...result.list].sort(
      (a, b) => Number(a.timestamp) - Number(b.timestamp),
    );
    const oiPrev = Number(sorted[0]!.openInterest);
    const oiNow = Number(sorted[sorted.length - 1]!.openInterest);
    return { oiNow, oiPrev, deltaPct: pctChange(oiPrev, oiNow) };
  },
};
