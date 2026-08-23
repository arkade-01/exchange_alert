import { config } from "./config.js";

/** OI direction against price direction — the four positioning regimes. */
export type Classification =
  | "longs building"
  | "shorts building"
  | "short covering"
  | "longs closing"
  | "flat";

export type ModeName = "breakout" | "premove";
export type Direction = "long" | "short";

export interface ScoreInput {
  oiDeltaPct: number;
  quoteVol24hUsd: number;
  priceChgPct24h: number;
  priceChgPctWindow: number | null;
  fundingRate: number;
  exchangesFiring: number;
}

export interface Mode {
  name: ModeName;
  emoji: string;
  label: string;
  /** One line telling a reader what this mode is claiming, in plain terms. */
  tagline: string;
  /** Window this mode measures OI and price over. */
  windowMinutes: number;
  minOiDelta: number;
  /** Alerts below this score are dropped rather than ranked. */
  minScore: number;
  /** Positioning regimes this mode acts on. */
  accepts(c: Classification): boolean;
  /** Per-signal gate beyond the shared volume and OI ones. */
  admits(s: {
    priceChgPct24h: number;
    priceChgPctWindow: number | null;
  }): boolean;
  score(i: ScoreInput): number;
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function classify(
  oiDelta: number,
  priceDelta: number,
): Classification {
  if (oiDelta === 0 || priceDelta === 0) return "flat";
  if (oiDelta > 0) return priceDelta > 0 ? "longs building" : "shorts building";
  return priceDelta > 0 ? "short covering" : "longs closing";
}

/** Which side a regime implies. Only the two building regimes are tradeable. */
export function directionOf(c: Classification): Direction | null {
  if (c === "longs building") return "long";
  if (c === "shorts building") return "short";
  return null;
}

// ---- shared normalisers -----------------------------------------------------

const nOi = (oiDeltaPct: number, max: number) => clamp01(oiDeltaPct / max);

/** Log-scaled so a $1B name does not drown a $30M mover. */
const nVol = (quoteVol24hUsd: number) =>
  clamp01(
    Math.log10(Math.max(quoteVol24hUsd, 1) / config.NORM_VOL_FLOOR) /
      config.NORM_VOL_DECADES,
  );

/** Crowding penalty — an already-paid-for move is a worse entry. */
const nFunding = (fundingRate: number) =>
  clamp01(Math.abs(fundingRate) / config.NORM_FUNDING_MAX);

const crossBonus = (exchangesFiring: number) =>
  Math.min(exchangesFiring - 1, config.CROSS_BONUS_MAX_EXTRA) *
  config.CROSS_BONUS;

// ---- breakout ---------------------------------------------------------------

/**
 * The original thesis: OI and price both rising, catch the move in progress.
 * Price movement is *rewarded* here — that is the whole difference from
 * pre-move, and the reason the two cannot share one weight set.
 */
export const breakout: Mode = {
  name: "breakout",
  emoji: "🟢",
  label: "Breakout",
  tagline: "moves already underway",
  windowMinutes: config.WINDOW_MINUTES,
  minOiDelta: config.MIN_OI_DELTA,
  minScore: -Infinity, // rank-only, as before — no score floor
  accepts: (c) => c === "longs building",
  admits: (s) => s.priceChgPct24h <= config.MAX_PCHG_24H,

  score(i) {
    // Prefer the window move; fall back to the 24h move on a wider scale.
    const nPrice =
      i.priceChgPctWindow !== null
        ? clamp01(i.priceChgPctWindow / config.NORM_PRICE_WINDOW_MAX)
        : clamp01(i.priceChgPct24h / config.NORM_PRICE_24H_MAX);

    return (
      config.W_OI * nOi(i.oiDeltaPct, config.NORM_OI_MAX) +
      config.W_VOL * nVol(i.quoteVol24hUsd) +
      config.W_PRICE * nPrice +
      crossBonus(i.exchangesFiring) -
      config.W_FUNDING * nFunding(i.fundingRate)
    );
  },
};

// ---- pre-move ---------------------------------------------------------------

/**
 * The inverted thesis: capital committing while price has not moved yet.
 *
 * `nQuiet` is the term that flips — a flat tape scores 1, a tape already moving
 * scores 0. Combined with the `admits` ceiling on window price change, this
 * deliberately rejects exactly the names breakout mode is built to catch.
 *
 * Both building regimes qualify, so this mode calls shorts as well as longs:
 * OI rising into a falling price is the same commitment with the sign flipped.
 */
export const premove: Mode = {
  name: "premove",
  emoji: "🔵",
  label: "Pre-Move",
  tagline: "price still quiet",
  windowMinutes: config.PREMOVE_WINDOW_MINUTES,
  minOiDelta: config.PREMOVE_MIN_OI_DELTA,
  minScore: config.PREMOVE_MIN_SCORE,
  accepts: (c) => c === "longs building" || c === "shorts building",

  admits: (s) =>
    // No window price means no evidence the tape is quiet — and "quiet" is the
    // entire claim. Falling back to the 24h move would assert what it cannot show.
    s.priceChgPctWindow !== null &&
    Math.abs(s.priceChgPctWindow) <= config.PREMOVE_MAX_ABS_PCHG_WINDOW &&
    // Quiet over the window is not enough: a name that already ran and is
    // merely consolidating looks identical at 15m resolution. The day's move
    // is what separates "has not gone yet" from "has already gone".
    Math.abs(s.priceChgPct24h) <= config.PREMOVE_MAX_ABS_PCHG_24H,

  score(i) {
    const quiet =
      i.priceChgPctWindow === null
        ? 0
        : 1 -
          clamp01(
            Math.abs(i.priceChgPctWindow) / config.PREMOVE_MAX_ABS_PCHG_WINDOW,
          );

    return (
      config.PM_W_OI * nOi(i.oiDeltaPct, config.NORM_OI_MAX) +
      config.PM_W_VOL * nVol(i.quoteVol24hUsd) +
      config.PM_W_QUIET * quiet +
      crossBonus(i.exchangesFiring) -
      config.W_FUNDING * nFunding(i.fundingRate)
    );
  },
};

export const MODES: Record<ModeName, Mode> = { breakout, premove };

export function activeModes(): Mode[] {
  if (config.MODE === "both") return [breakout, premove];
  return [MODES[config.MODE]];
}

/**
 * Longest window any active mode needs. One OI fetch at this depth answers
 * every mode's question, so adding pre-move costs no additional HTTP calls.
 */
export function maxLookbackMinutes(modes = activeModes()): number {
  return Math.max(...modes.map((m) => m.windowMinutes));
}
