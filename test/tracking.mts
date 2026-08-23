import db from "../src/db.js";
import {
  formatReport,
  markToMarket,
  outcomeStats,
  recordOutcomes,
  type OutcomeEntry,
} from "../src/tracking.js";

let pass = 0, fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = String(got) === String(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      got=${got} want=${want}`);
}

const T0 = Date.now() - 10 * 3_600_000; // start in the past so horizons elapse
const MIN = 60_000;

const entry = (base: string, direction: "long" | "short"): OutcomeEntry => ({
  mode: "premove", direction, base, exchanges: ["binance"],
  entryPrice: 100, score: 0.5, oiDeltaPct: 6,
  pxWindowPct: 0.2, quoteVolUsd: 50e6, fundingRate: 0.0001,
  features: { baselineVolPct: 0.5, oiConcentration: 0.2, volRatio: 1.4, impulseAgeMin: 10 },
});

db.prepare("DELETE FROM alert_outcomes").run();
recordOutcomes([entry("LONGC", "long"), entry("SHORTC", "short")], T0);

const row = (base: string) =>
  db.prepare("SELECT * FROM alert_outcomes WHERE base = ?").get(base) as any;

// +20m: long is up 3%, short's coin is down 3% (a 3% GAIN for the short).
markToMarket(new Map([["LONGC", 103], ["SHORTC", 97]]), T0 + 20 * MIN);

check("1. long MFE tracks the rise", row("LONGC").mfe_pct.toFixed(2), "3.00");
check("2. short MFE is signed for its side", row("SHORTC").mfe_pct.toFixed(2), "3.00");
check("3. the 15m mark is stamped", row("LONGC").px_15m, 103);
check("4. the 1h mark is not yet", row("LONGC").px_1h, null);

// +65m: long gives it all back and then some.
markToMarket(new Map([["LONGC", 99], ["SHORTC", 101]]), T0 + 65 * MIN);

check("5. MFE keeps the best excursion", row("LONGC").mfe_pct.toFixed(2), "3.00");
check("6. MAE records the worst", row("LONGC").mae_pct.toFixed(2), "-1.00");
check("7. the 1h mark is stamped now", row("LONGC").px_1h, 99);
check("8. short MAE is signed too", row("SHORTC").mae_pct.toFixed(2), "-1.00");

// +4h: the horizon closes.
markToMarket(new Map([["LONGC", 105], ["SHORTC", 105]]), T0 + 4 * 60 * MIN + MIN);
check("9. the 4h mark closes the row", row("LONGC").px_4h, 105);
check("10. MFE updated on the final mark", row("LONGC").mfe_pct.toFixed(2), "5.00");

// Settled rows are done — further marks must not reopen or mutate them.
const touched = markToMarket(new Map([["LONGC", 999], ["SHORTC", 999]]), T0 + 5 * 60 * MIN);
check("11. settled rows are never re-marked", touched, 0);
check("12. and their MFE is untouched", row("LONGC").mfe_pct.toFixed(2), "5.00");

// A base that vanishes from the universe is skipped, not zeroed.
db.prepare("UPDATE alert_outcomes SET px_4h = NULL WHERE base = 'LONGC'").run();
markToMarket(new Map(), T0 + 5 * 60 * MIN);
check("13. a missing price leaves the row alone", row("LONGC").mfe_pct.toFixed(2), "5.00");

const stats = outcomeStats(30);
check("14. stats group by mode and side", stats.byMode.length, 2);
// Test 13 cleared LONGC's 4h mark and gave it no price, so exactly one of the
// two rows is settled — the report must count that, not assume both.
check("15. settled counts only rows that reached 4h",
  stats.byMode.reduce((n, s) => n + s.settled, 0), 1);
// Both fixtures carry oiConcentration 0.2, so both land in the sustained bucket.
check("16. outcomes bucket by OI shape", stats.byShape[0]?.label, "sustained");
check("17. returns normalise by the coin's own volatility",
  stats.byShape[0]?.norm4h !== null, true);

console.log("\n--- report ---");
console.log(formatReport(stats, 30));
console.log("---");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
