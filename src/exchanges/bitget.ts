import {
  getJson,
  toBase,
  type Candidate,
  type Exchange,
  type OiChange,
} from "./base.js";
import { config } from "../config.js";
import { makeSnapshotOiChange } from "./snapshot.js";

const BASE = config.BITGET_BASE_URL;

interface BitgetTicker {
  symbol: string; // BTCUSDT
  lastPr: string;
  usdtVolume: string; // 24h quote volume
  holdingAmount: string; // current open interest, base units
  change24h: string; // decimal: 0.05 = 5%
  fundingRate: string;
}

/** Latest OI per symbol from the most recent getUniverse() call. */
const latestOi = new Map<string, number>();

export const bitget: Exchange = {
  name: "bitget",
  needsSnapshots: true,

  async getUniverse(): Promise<Candidate[]> {
    const body = await getJson<{ code: string; msg: string; data: BitgetTicker[] }>(
      `${BASE}/api/v2/mix/market/tickers?productType=USDT-FUTURES`,
    );
    if (body.code !== "00000" || !Array.isArray(body.data)) {
      throw new Error(`Bitget tickers: ${body.code} ${body.msg}`);
    }

    latestOi.clear();
    const out: Candidate[] = [];
    for (const t of body.data) {
      if (!t.symbol.endsWith("USDT")) continue;
      const vol = Number(t.usdtVolume);
      const price = Number(t.lastPr);
      if (!Number.isFinite(vol) || !(price > 0)) continue;
      latestOi.set(t.symbol, Number(t.holdingAmount));
      out.push({
        exchange: "bitget",
        symbol: t.symbol,
        base: toBase(t.symbol),
        quoteVol24hUsd: vol,
        priceChgPct24h: Number(t.change24h) * 100,
        lastPrice: price,
        fundingRate: Number(t.fundingRate) || 0,
        openInterest: Number(t.holdingAmount),
      });
    }
    return out;
  },

  getOiChange: makeSnapshotOiChange("bitget", () => latestOi) as (
    symbol: string,
    windowMinutes: number,
  ) => Promise<OiChange>,
};
