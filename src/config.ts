import "dotenv/config";
import { z } from "zod";

const csv = (s: string) =>
  s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

const Schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHAT_ID: z.string().default(""),
  // Where `--report --send` delivers. Deliberately separate: performance
  // reports are for you, not for the alert channel's subscribers. Unset means
  // reports are never sent anywhere, only printed.
  TELEGRAM_REPORT_CHAT_ID: z.string().default(""),
  EXCHANGES: z.string().default("binance,bybit").transform(csv),

  // Which scan modes run. "breakout" is the original behaviour (OI and price
  // both rising); "premove" hunts the opposite shape — OI committing while
  // price sits still. They share one OI fetch, so "both" costs no extra calls.
  MODE: z.enum(["breakout", "premove", "both"]).default("breakout"),

  // Scan window + gates (breakout)
  WINDOW_MINUTES: z.coerce.number().int().positive().default(60),
  MIN_VOLUME: z.coerce.number().nonnegative().default(10_000_000),
  MIN_OI_DELTA: z.coerce.number().default(5),
  MAX_PCHG_24H: z.coerce.number().default(40),

  // Pre-move gates. A shorter window because the thesis is a fast OI commit,
  // and a *maximum* price move because a name that already ran is not pre-move.
  PREMOVE_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  PREMOVE_MIN_OI_DELTA: z.coerce.number().default(3),
  PREMOVE_MAX_ABS_PCHG_WINDOW: z.coerce.number().positive().default(1.5),
  // Pre-move's own 24h ceiling, much tighter than the breakout one. Without it
  // a coin up 35% on the day qualifies as "pre-move" the moment it goes quiet
  // for a quarter of an hour — late longs into a topped move, mislabelled as
  // anticipation. This is the only pre/post discriminator available from OI
  // and price alone; the rest need order flow.
  PREMOVE_MAX_ABS_PCHG_24H: z.coerce.number().positive().default(12),
  PREMOVE_MIN_SCORE: z.coerce.number().default(0.35),

  // Pre-move weights. Separate from the breakout set because the price term is
  // inverted here — quiet is the signal, not movement.
  PM_W_OI: z.coerce.number().default(0.4),
  PM_W_VOL: z.coerce.number().default(0.15),
  PM_W_QUIET: z.coerce.number().default(0.3),

  // Alerting
  ALERT_COOLDOWN_MIN: z.coerce.number().nonnegative().default(60),
  // Let a signal spreading to a new exchange break through the cooldown.
  ALERT_ON_VENUE_SPREAD: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  MAX_ALERTS: z.coerce.number().int().positive().default(10),
  SCAN_INTERVAL_MIN: z.coerce.number().positive().default(10),
  CONCURRENCY: z.coerce.number().int().positive().default(8),

  // Scoring tunables (see CLAUDE.md > Scoring)
  W_OI: z.coerce.number().default(0.45),
  W_VOL: z.coerce.number().default(0.2),
  W_PRICE: z.coerce.number().default(0.25),
  W_FUNDING: z.coerce.number().default(0.15),
  CROSS_BONUS: z.coerce.number().default(0.15),
  CROSS_BONUS_MAX_EXTRA: z.coerce.number().int().default(2),
  NORM_OI_MAX: z.coerce.number().default(25),
  NORM_VOL_FLOOR: z.coerce.number().default(1e7),
  NORM_VOL_DECADES: z.coerce.number().default(2),
  NORM_PRICE_WINDOW_MAX: z.coerce.number().default(10),
  NORM_PRICE_24H_MAX: z.coerce.number().default(40),
  NORM_FUNDING_MAX: z.coerce.number().default(0.001),

  // Resolve through these servers instead of the system resolver. The escape
  // hatch for an ISP that NXDOMAINs exchange APIs while the hosts themselves
  // answer fine. Empty = system DNS.
  DNS_SERVERS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),

  // Base URLs are overridable so a blocked ISP can be routed around via an
  // official mirror (e.g. Bybit's api.bytick.com) without touching code.
  BINANCE_BASE_URL: z.string().url().default("https://fapi.binance.com"),
  BYBIT_BASE_URL: z.string().url().default("https://api.bybit.com"),
  MEXC_BASE_URL: z.string().url().default("https://contract.mexc.com"),
  BITGET_BASE_URL: z.string().url().default("https://api.bitget.com"),

  // How much older than the window cutoff a reference snapshot may be before it
  // is rejected. 0 = auto (two scan intervals, floor 15m). Without this bound a
  // gap in history silently turns a "1h" delta into a multi-hour one.
  SNAPSHOT_MAX_STALENESS_MIN: z.coerce.number().nonnegative().default(0),

  // Record every alert and score it forward at +15m/+1h/+4h. Costs no extra
  // API calls — later scans already carry the current price of everything.
  TRACK_OUTCOMES: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // How stale the snapshot backing a *price* window may be. 0 = auto
  // (1.5 scan intervals, floor 5m). Tighter than the OI allowance because a
  // 15m pre-move window is meaningless if the reference price is 30m old.
  PRICE_REF_STALENESS_MIN: z.coerce.number().nonnegative().default(0),

  // How often the loop delivers a performance report to
  // TELEGRAM_REPORT_CHAT_ID. 0 disables it. The worker has no shell on most
  // hosts, so a scheduled push is the only way to read the numbers without one.
  REPORT_EVERY_HOURS: z.coerce.number().nonnegative().default(24),

  DB_PATH: z.string().default("./oi-scanner.db"),
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
});

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

/**
 * A reference snapshot must sit in [cutoff - slack, cutoff]. Auto-sizing to two
 * scan intervals tolerates one missed scan without accepting stale history.
 */
export const snapshotStalenessMs =
  (config.SNAPSHOT_MAX_STALENESS_MIN ||
    Math.max(2 * config.SCAN_INTERVAL_MIN, 15)) * 60_000;

/**
 * Price references are held to a tighter clock than OI ones: the pre-move
 * verdict is "price did not move", which a stale reference silently fakes.
 */
export const priceRefStalenessMs =
  (config.PRICE_REF_STALENESS_MIN ||
    Math.max(1.5 * config.SCAN_INTERVAL_MIN, 5)) * 60_000;

/**
 * The shortest window any active mode asks for. Scanning on a cadence coarser
 * than half of it means the reference snapshot is routinely older than the
 * window itself — the delta then measures a longer period than it reports.
 */
export function windowCadenceWarning(): string | null {
  const shortest =
    config.MODE === "breakout"
      ? config.WINDOW_MINUTES
      : config.MODE === "premove"
        ? config.PREMOVE_WINDOW_MINUTES
        : Math.min(config.WINDOW_MINUTES, config.PREMOVE_WINDOW_MINUTES);

  if (config.SCAN_INTERVAL_MIN * 2 <= shortest) return null;
  return (
    `SCAN_INTERVAL_MIN=${config.SCAN_INTERVAL_MIN} is too coarse for a ` +
    `${shortest}m window — set it to ${Math.floor(shortest / 2)} or less, ` +
    `or window price changes will measure a longer period than they report.`
  );
}

/** Telegram is only required when actually sending. */
export function assertTelegramConfigured(): void {
  const missing: string[] = [];
  if (!config.TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!config.TELEGRAM_CHAT_ID) missing.push("TELEGRAM_CHAT_ID");
  if (missing.length) {
    throw new Error(
      `Missing ${missing.join(" and ")}. Set them in .env, or run with --dry-run.`,
    );
  }
}
