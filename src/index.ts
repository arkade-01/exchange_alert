import { config, windowCadenceWarning } from "./config.js";
import { hasAlertHistory } from "./db.js";
import { installDnsOverride } from "./net.js";
import { commitAlerts, formatMessage, scan } from "./scanner.js";
import { sendMessage } from "./telegram.js";
import { formatReport, outcomeStats } from "./tracking.js";

// Must run before the first request goes out.
installDnsOverride();

interface Args {
  once: boolean;
  loop: boolean;
  dryRun: boolean;
  report: number | null; // lookback in days
  intervalMin: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    once: argv.includes("--once"),
    loop: argv.includes("--loop"),
    dryRun: argv.includes("--dry-run"),
    report: null,
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

  if (!args.once && !args.loop && args.report === null) args.once = true;
  return args;
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

  if (args.report !== null) {
    console.log(formatReport(outcomeStats(args.report), args.report));
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

  console.error(`Looping every ${args.intervalMin} min. Ctrl-C to stop.`);
  while (!stopping) {
    try {
      await runOnce(args.dryRun, prime);
      prime = false;
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
