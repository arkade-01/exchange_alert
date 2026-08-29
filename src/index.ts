import { config, windowCadenceWarning } from "./config.js";
import { getMeta, hasAlertHistory, setMeta } from "./db.js";
import { installDnsOverride } from "./net.js";
import { commitAlerts, formatMessage, scan } from "./scanner.js";
import { sendMessage } from "./telegram.js";
import { formatReport, outcomeStats } from "./tracking.js";
import { backfill } from "./backfill.js";
import { startCommandListener, stopCommandListener } from "./commands.js";

// Must run before the first request goes out.
installDnsOverride();

interface Args {
  once: boolean;
  loop: boolean;
  dryRun: boolean;
  report: number | null; // lookback in days
  send: boolean; // deliver the report to Telegram instead of stdout
  backfill: boolean; // recompute features for rows recorded before they existed
  intervalMin: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    once: argv.includes("--once"),
    loop: argv.includes("--loop"),
    dryRun: argv.includes("--dry-run"),
    report: null,
    send: argv.includes("--send"),
    backfill: argv.includes("--backfill"),
    intervalMin: config.SCAN_INTERVAL_MIN,
  };

  const i = argv.indexOf("--interval");
  if (i !== -1) {
    const v = Number(argv[i + 1]);
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error("--interval requires a positive number of minutes");
    }
    args.intervalMin = v;
  }

  const r = argv.indexOf("--report");
  if (r !== -1) {
    const v = Number(argv[r + 1]);
    args.report = Number.isFinite(v) && v > 0 ? v : 30;
  }

  if (!args.once && !args.loop && args.report === null && !args.backfill) {
    args.once = true;
  }
  return args;
}

const LAST_REPORT_KEY = "last_report_ts";

/**
 * Push the performance report on a schedule.
 *
 * The worker usually has no shell — on Railway and similar hosts the container
 * just runs `--loop` — so a scheduled push is the only way to read the numbers
 * without SSH. Delivery is to TELEGRAM_REPORT_CHAT_ID only; it never falls back
 * to the alert channel.
 *
 * The timestamp lives in the database rather than in memory, so redeploying
 * does not re-send. A worker that has never reported sends one immediately,
 * which is what makes the first deploy after enabling this useful.
 */
async function maybeSendReport(now: number): Promise<void> {
  const chat = config.TELEGRAM_REPORT_CHAT_ID;
  if (!chat || config.REPORT_EVERY_HOURS <= 0) return;

  const last = Number(getMeta(LAST_REPORT_KEY) ?? 0);
  if (now - last < config.REPORT_EVERY_HOURS * 3_600_000) return;

  const days = Math.max(1, Math.ceil(config.REPORT_EVERY_HOURS / 24) * 7);
  const text = formatReport(outcomeStats(days), days);
  try {
    await sendMessage(`<pre>${text}</pre>`, chat);
    setMeta(LAST_REPORT_KEY, String(now));
    console.error("  performance report sent");
  } catch (err) {
    // A failed report must never take down the scan loop.
    console.error(`  report send failed: ${(err as Error).message}`);
  }
}

/**
 * `prime` records cooldowns without sending. Used for the first scan of a
 * worker that booted with no alert history — a fresh container or a new volume
 * — where every name currently in the bucket would otherwise be re-announced.
 */
async function runOnce(dryRun: boolean, prime = false): Promise<void> {
  const result = await scan();
  const s = result.stats;
  const totalAlerts = result.modes.reduce((n, m) => n + m.alerts.length, 0);

  console.error(
    `[${result.scannedAt.toISOString()}] universe ${s.universe} → vol gate ${s.afterVolumeGate} → ` +
      `oi ${s.oiFetched} (${s.nullDeltas} null) · ${s.tracked} tracked`,
  );
  for (const m of result.modes) {
    console.error(
      `  ${m.mode.name.padEnd(8)} bucket ${m.bucketCount} → ` +
        `${m.alerts.length} alert(s), ${m.suppressed.length} on cooldown, ` +
        `${m.belowScore} below score floor`,
    );
  }
  if (s.errors.length) {
    console.error(`  ${s.errors.length} error(s); first 3:`);
    for (const e of s.errors.slice(0, 3)) console.error(`    ${e}`);
  }

  if (dryRun) {
    console.log(formatMessage(result, true));
    return;
  }
  if (totalAlerts === 0) return; // stay quiet when there is nothing to say

  if (prime) {
    console.error(
      `  priming: ${totalAlerts} alert(s) recorded, not sent ` +
        `(no alert history — treating this scan as the baseline)`,
    );
    commitAlerts(result);
    return;
  }

  await sendMessage(formatMessage(result));
  commitAlerts(result);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.backfill) {
    const r = await backfill();
    console.log(
      `backfill: ${r.filled} filled, ${r.expired} past Binance's ~30d OI ` +
        `retention, ${r.failed} failed (of ${r.total} incomplete rows)`,
    );
    if (!args.once && !args.loop && args.report === null) return;
  }

  if (args.report !== null) {
    const text = formatReport(outcomeStats(args.report), args.report);
    console.log(text);
    if (args.send) {
      // Never fall back to TELEGRAM_CHAT_ID: that is the alert channel, and a
      // performance report is not something its subscribers asked for.
      if (!config.TELEGRAM_REPORT_CHAT_ID) {
        throw new Error(
          "--send needs TELEGRAM_REPORT_CHAT_ID (your own chat id). " +
            "It is deliberately separate from the alert channel.",
        );
      }
      await sendMessage(`<pre>${text}</pre>`, config.TELEGRAM_REPORT_CHAT_ID);
      console.error("report sent");
    }
    if (!args.once && !args.loop) return;
  }

  console.error(
    `OI scanner · mode=${config.MODE} · exchanges=${config.EXCHANGES.join(",")} · ` +
      `minVol=${config.MIN_VOLUME}` +
      (args.dryRun ? " · DRY RUN" : ""),
  );

  const warning = windowCadenceWarning();
  if (warning) console.error(`⚠️  ${warning}`);

  if (!args.loop) {
    await runOnce(args.dryRun);
    return;
  }

  let stopping = false;
  // Set while the loop is idling between scans, so a signal cuts the wait short
  // instead of leaving the process alive until the interval elapses.
  let wake: (() => void) | null = null;
  const stop = () => {
    stopping = true;
    stopCommandListener();
    console.error("\nShutting down after the current scan…");
    wake?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // A worker that boots with an empty database has lost its cooldowns; its
  // first scan is a baseline, not news. Manual --once runs are never primed.
  let prime = !args.dryRun && !hasAlertHistory();
  if (prime) {
    console.error("No alert history — first scan will prime cooldowns silently.");
  }

  // Old rows lose their features permanently once they pass Binance's OI
  // retention, and there is no shell here to run --backfill manually.
  if (config.BACKFILL_ON_BOOT && !args.dryRun) {
    try {
      const r = await backfill();
      if (r.total) {
        console.error(
          `backfill: ${r.filled} filled, ${r.expired} past OI retention, ` +
            `${r.failed} failed (of ${r.total})`,
        );
      }
    } catch (err) {
      console.error(`backfill failed: ${(err as Error).message}`);
    }
  }

  // Long-polls alongside the scan loop so /report answers in about a second
  // rather than waiting for the next scan.
  if (!args.dryRun) startCommandListener();

  console.error(`Looping every ${args.intervalMin} min. Ctrl-C to stop.`);
  while (!stopping) {
    try {
      await runOnce(args.dryRun, prime);
      prime = false;
      if (!args.dryRun) await maybeSendReport(Date.now());
    } catch (err) {
      // A single bad scan must never kill the worker.
      console.error(`Scan failed: ${(err as Error).message}`);
    }
    if (stopping) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, args.intervalMin * 60_000);
      // Waking early must also drop the timer, or the process lingers until it fires.
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = null;
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
