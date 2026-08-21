import { config } from "./config.js";
import { installDnsOverride } from "./net.js";
import { commitAlerts, formatMessage, scan } from "./scanner.js";
import { sendMessage } from "./telegram.js";

// Must run before the first request goes out.
installDnsOverride();

interface Args {
  once: boolean;
  loop: boolean;
  dryRun: boolean;
  intervalMin: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    once: argv.includes("--once"),
    loop: argv.includes("--loop"),
    dryRun: argv.includes("--dry-run"),
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
  if (!args.once && !args.loop) args.once = true; // default to a single scan
  return args;
}

async function runOnce(dryRun: boolean): Promise<void> {
  const result = await scan();
  const s = result.stats;

  console.error(
    `[${result.scannedAt.toISOString()}] universe ${s.universe} → vol gate ${s.afterVolumeGate} → ` +
      `oi ${s.oiFetched} (${s.nullDeltas} null) → longs building ${s.longsBuilding} → ` +
      `${s.merged} bases → ${result.alerts.length} alerts, ${result.suppressed.length} on cooldown`,
  );
  if (s.errors.length) {
    console.error(`  ${s.errors.length} error(s); first 3:`);
    for (const e of s.errors.slice(0, 3)) console.error(`    ${e}`);
  }

  const message = formatMessage(result);
  if (dryRun) {
    console.log(message);
    return;
  }
  if (result.alerts.length === 0) return; // stay quiet when there is nothing to say

  await sendMessage(message);
  commitAlerts(result);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.error(
    `OI scanner · exchanges=${config.EXCHANGES.join(",")} · window=${config.WINDOW_MINUTES}m · ` +
      `minVol=${config.MIN_VOLUME} · minOi=${config.MIN_OI_DELTA}%` +
      (args.dryRun ? " · DRY RUN" : ""),
  );

  if (!args.loop) {
    await runOnce(args.dryRun);
    return;
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
    console.error("\nShutting down after the current scan…");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.error(`Looping every ${args.intervalMin} min. Ctrl-C to stop.`);
  while (!stopping) {
    try {
      await runOnce(args.dryRun);
    } catch (err) {
      // A single bad scan must never kill the worker.
      console.error(`Scan failed: ${(err as Error).message}`);
    }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, args.intervalMin * 60_000));
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
