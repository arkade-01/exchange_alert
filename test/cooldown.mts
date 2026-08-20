import { applyCooldown, commitAlerts, formatMessage, type MergedSignal, type ScanResult } from "../src/scanner.js";
import { syncBucketMembership } from "../src/db.js";

const sig = (base: string, exchanges: string[]): MergedSignal => ({
  base, exchanges, oiDeltaPct: 12.4, quoteVol24hUsd: 84e6,
  priceChgPct24h: 3.1, priceChgPctWindow: 3.1, fundingRate: 0.00011,
  lastPrice: 1, score: 0.82, confirmedOn: [],
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
syncBucketMembership(["ARB"]);
commitAlerts({ alerts: r.alerts, scannedAt: new Date(T0) } as ScanResult);

// Step 2: 10 min later, still Binance only, cooldown 60m -> muted.
m = [sig("ARB", ["binance"])];
r = applyCooldown(m, T0 + 10 * 60_000);
check("2. same venue in cooldown is muted", `${r.alerts.length}/${r.suppressed.length}`, "0/1");
syncBucketMembership(["ARB"]);

// Step 3: 20 min later, Bybit joins -> must break through as a confirmation.
m = [sig("ARB", ["binance", "bybit"])];
r = applyCooldown(m, T0 + 20 * 60_000);
check("3. venue spread breaks cooldown", `${r.alerts.length}/${r.suppressed.length}`, "1/0");
check("3b. marked confirmed on the NEW venue", JSON.stringify(r.alerts[0]?.confirmedOn), '["bybit"]');
console.log("\n--- message for the confirmation alert ---");
console.log(formatMessage({ windowMinutes: 60, scannedAt: new Date(T0 + 20*60_000), alerts: r.alerts, suppressed: [], stats: {} as any }));
console.log("---\n");
syncBucketMembership(["ARB"]);
commitAlerts({ alerts: r.alerts, scannedAt: new Date(T0 + 20 * 60_000) } as ScanResult);

// Step 4: 30 min, same two venues, nothing new -> muted again.
m = [sig("ARB", ["binance", "bybit"])];
r = applyCooldown(m, T0 + 30 * 60_000);
check("4. no further spread is muted again", `${r.alerts.length}/${r.suppressed.length}`, "0/1");
syncBucketMembership(["ARB"]);

// Step 5: 40 min, Binance DROPS OUT, only Bybit -> not corroboration, stay muted.
m = [sig("ARB", ["bybit"])];
r = applyCooldown(m, T0 + 40 * 60_000);
check("5. venue swap (not growth) stays muted", `${r.alerts.length}/${r.suppressed.length}`, "0/1");
syncBucketMembership(["ARB"]);

// Step 6: 90 min after the confirmation -> cooldown elapsed, alerts normally.
m = [sig("ARB", ["binance", "bybit"])];
r = applyCooldown(m, T0 + 20 * 60_000 + 61 * 60_000);
check("6. cooldown expiry alerts again", `${r.alerts.length}/${r.suppressed.length}`, "1/0");
check("6b. expiry is not labelled a confirmation", JSON.stringify(r.alerts[0]?.confirmedOn), "[]");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
