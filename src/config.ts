import "dotenv/config";
import { z } from "zod";

const csv = (s: string) =>
  s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

const Schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHAT_ID: z.string().default(""),
  EXCHANGES: z.string().default("binance,bybit").transform(csv),

  // Scan window + gates
  WINDOW_MINUTES: z.coerce.number().int().positive().default(60),
  MIN_VOLUME: z.coerce.number().nonnegative().default(10_000_000),
  MIN_OI_DELTA: z.coerce.number().default(5),
  MAX_PCHG_24H: z.coerce.number().default(40),

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
