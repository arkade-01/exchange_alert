import {
  getJson,
  toBase,
  type Candidate,
  type Exchange,
  type OiChange,
} from "./base.js";
import { config } from "../config.js";
import { makeSnapshotOiChange } from "./snapshot.js";

const BASE = config.MEXC_BASE_URL;

interface MexcTicker {
  symbol: string; // BTC_USDT
  lastPrice: number;
  amount24: number; // 24h quote volume (USDT)
  holdVol: number; // current open interest, contracts
  riseFallRate: number; // decimal: 0.05 = 5%
  fundingRate: number;
}

/** Latest OI per symbol from the most recent getUniverse() call. */
const latestOi = new Map<string, number>();

export const mexc: Exchange = {
  name: "mexc",
  needsSnapshots: true,

  async getUniverse(): Promise<Candidate[]> {
    const body = await getJson<{ success: boolean; data: MexcTicker[] }>(
      `${BASE}/api/v1/contract/ticker`,
    );
    if (!body.success || !Array.isArray(body.data)) {
      throw new Error("MEXC ticker: unexpected response shape");
    }

    latestOi.clear();
    const out: Candidate[] = [];
    for (const t of body.data) {
      if (!t.symbol.endsWith("_USDT")) continue;
      if (!Number.isFinite(t.amount24) || !(t.lastPrice > 0)) continue;
      latestOi.set(t.symbol, Number(t.holdVol));
      out.push({
        exchange: "mexc",
        symbol: t.symbol,
        base: toBase(t.symbol),
        quoteVol24hUsd: Number(t.amount24),
        priceChgPct24h: Number(t.riseFallRate) * 100,
        lastPrice: Number(t.lastPrice),
        fundingRate: Number(t.fundingRate) || 0,
        openInterest: Number(t.holdVol),
      });
    }
    return out;
  },

  getOiChange: makeSnapshotOiChange("mexc", () => latestOi) as (
    symbol: string,
    windowMinutes: number,
  ) => Promise<OiChange>,
};
