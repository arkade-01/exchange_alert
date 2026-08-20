import type { Exchange } from "./base.js";
import { binance } from "./binance.js";
import { bybit } from "./bybit.js";
import { mexc } from "./mexc.js";
import { bitget } from "./bitget.js";

export const ALL_EXCHANGES: Record<string, Exchange> = {
  binance,
  bybit,
  mexc,
  bitget,
};

export function resolveExchanges(names: string[]): Exchange[] {
  const out: Exchange[] = [];
  for (const n of names) {
    const ex = ALL_EXCHANGES[n];
    if (!ex) {
      throw new Error(
        `Unknown exchange "${n}". Known: ${Object.keys(ALL_EXCHANGES).join(", ")}`,
      );
    }
    out.push(ex);
  }
  return out;
}
