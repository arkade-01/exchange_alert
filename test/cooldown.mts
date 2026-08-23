import {
  applyCooldown,
  commitAlerts,
  formatModeMessage,
  type MergedSignal,
  type ModeResult,
  type ScanResult,
} from "../src/scanner.js";
import { breakout } from "../src/modes.js";
import { syncBucketMembership } from "../src/db.js";

const sig = (base: string, exchanges: string[]): MergedSignal => ({
  mode: "breakout", direction: "long", base, exchanges,
  oiDeltaPct: 12.4, quoteVol24hUsd: 84e6,
  priceChgPct24h: 3.1, priceChgPctWindow: 3.1, fundingRate: 0.00011,
  lastPrice: 1, score: 0.82, confirmedOn: [],
  features: { baselineVolPct: 0.5, oiConcentration: 0.3, volRatio: 2.1, impulseAgeMin: 12 },
});

/** Cooldown keys are namespaced by mode and side, matching the scanner. */
const key = (m: MergedSignal) => `${m.mode}:${m.direction}:${m.base}`;

const asResult = (alerts: MergedSignal[], at: number): ScanResult => ({
  scannedAt: new Date(at),
  modes: [{ mode: breakout, alerts, suppressed: [], bucketCount: alerts.length, belowScore: 0 } as ModeResult],
  stats: { universe: 0, afterVolumeGate: 0, oiFetched: 0, nullDeltas: 0, tracked: 0, errors: [] },
});

const T0 = Date.now();
let pass = 0, fail = 0;
function check(name: string, got: string, want: string) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      got=${got} want=${want}`);
}

// Step 1: brand new signal on Binance only.
let m = [sig("ARB", ["binance"])];
let r = applyCooldown(m, T0);
check("1. new coin alerts", `${r.alerts.length}/${r.suppressed.length}`, "1/0");
syncBucketMembership(m.map(key));
commitAlerts(asResult(r.alerts, T0));

// Step 2: 10 min later, still Binance only, cooldown 60m -> muted.
m = [sig("ARB", ["binance"])];
r = applyCooldown(m, T0 + 10 * 60_000);
check("2. same venue in cooldown is muted", `${r.alerts.length}/${r.suppressed.length}`, "0/1");
syncBucketMembership(m.map(key));

// Step 3: 20 min later, Bybit joins -> must break through as a confirmation.
m = [sig("ARB", ["binance", "bybit"])];
r = applyCooldown(m, T0 + 20 * 60_000);
check("3. venue spread breaks cooldown", `${r.alerts.length}/${r.suppressed.length}`, "1/0");
check("3b. marked confirmed on the NEW venue", JSON.stringify(r.alerts[0]?.confirmedOn), '["bybit"]');
console.log("\n--- message for the confirmation alert ---");
console.log(formatModeMessage(
  { mode: breakout, alerts: r.alerts, suppressed: [], bucketCount: 1, belowScore: 0 },
  new Date(T0 + 20 * 60_000),
));
console.log("---\n");
syncBucketMembership(m.map(key));
commitAlerts(asResult(r.alerts, T0 + 20 * 60_000));

// Step 4: 30 min, same two venues, nothing new -> muted again.
m = [sig("ARB", ["binance", "bybit"])];
r = applyCooldown(m, T0 + 30 * 60_000);
check("4. no further spread is muted again", `${r.alerts.length}/${r.suppressed.length}`, "0/1");
syncBucketMembership(m.map(key));

// Step 5: 40 min, Binance DROPS OUT, only Bybit -> not corroboration, stay muted.
m = [sig("ARB", ["bybit"])];
r = applyCooldown(m, T0 + 40 * 60_000);
check("5. venue swap (not growth) stays muted", `${r.alerts.length}/${r.suppressed.length}`, "0/1");
syncBucketMembership(m.map(key));

// Step 6: 90 min after the confirmation -> cooldown elapsed, alerts normally.
m = [sig("ARB", ["binance", "bybit"])];
r = applyCooldown(m, T0 + 20 * 60_000 + 61 * 60_000);
check("6. cooldown expiry alerts again", `${r.alerts.length}/${r.suppressed.length}`, "1/0");
check("6b. expiry is not labelled a confirmation", JSON.stringify(r.alerts[0]?.confirmedOn), "[]");

// Step 7: a SHORT on the same base is a separate claim — it must not inherit
// the long's cooldown, or every pre-move reversal call would be swallowed.
const short: MergedSignal = { ...sig("ARB", ["binance"]), mode: "premove", direction: "short" };
r = applyCooldown([short], T0 + 21 * 60_000);
check("7. short on an alerted base is not muted by the long", `${r.alerts.length}/${r.suppressed.length}`, "1/0");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
