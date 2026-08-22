import { deltaOverWindow, type OiPoint } from "../src/exchanges/base.js";
import { breakout, premove } from "../src/modes.js";

let pass = 0, fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = String(got) === String(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      got=${got} want=${want}`);
}

const NOW = Date.now();

// A 60m series at 5m resolution, OI climbing steadily: 100 → 160.
const series: OiPoint[] = Array.from({ length: 13 }, (_, i) => ({
  ts: NOW - (60 - i * 5) * 60_000,
  oi: 100 + i * 5,
}));

// ---- one fetch, many windows ------------------------------------------------
// This is the property that makes running both modes free: the 15m answer is
// already inside the 60m series.

check(
  "1. 60m delta off the full series",
  deltaOverWindow(series, 60, NOW).deltaPct?.toFixed(2),
  "60.00",
);
check(
  "2. 15m delta off the SAME series",
  deltaOverWindow(series, 15, NOW).deltaPct?.toFixed(2),
  "10.34", // 145 → 160
);

// ---- staleness --------------------------------------------------------------

const stalled = [
  { ts: NOW - 60 * 60_000, oi: 100 },
  { ts: NOW - 50 * 60_000, oi: 130 },
];
check(
  "3. stale series returns a null delta, not a stale one",
  deltaOverWindow(stalled, 15, NOW).deltaPct,
  null,
);
check(
  "4. a single point cannot produce a delta",
  deltaOverWindow([{ ts: NOW, oi: 100 }], 15, NOW).deltaPct,
  null,
);

// A 15m window asked of a series that only reaches back 8m: the reference
// would be 7m off target, beyond the 7.5m tolerance is fine, but a 30m gap
// is not — that would silently measure a longer window than it reports.
const shallow: OiPoint[] = Array.from({ length: 3 }, (_, i) => ({
  ts: NOW - (8 - i * 4) * 60_000,
  oi: 100 + i,
}));
check(
  "5. window deeper than the series is rejected",
  deltaOverWindow(shallow, 60, NOW).deltaPct,
  null,
);

// ---- the scoring inversion --------------------------------------------------
// Same OI build, same volume; the only difference is how far price has moved.

const base = {
  oiDeltaPct: 6,
  quoteVol24hUsd: 50e6,
  priceChgPct24h: 2,
  fundingRate: 0,
  exchangesFiring: 1,
};
const quiet = { ...base, priceChgPctWindow: 0.2 };
const moving = { ...base, priceChgPctWindow: 1.4 };

check(
  "6. pre-move ranks the QUIET tape higher",
  premove.score(quiet) > premove.score(moving),
  true,
);
check(
  "7. breakout ranks the MOVING tape higher — the terms are opposed",
  breakout.score(moving) > breakout.score(quiet),
  true,
);

// ---- gates ------------------------------------------------------------------

check(
  "8. pre-move rejects a name that already ran",
  premove.admits({ priceChgPct24h: 2, priceChgPctWindow: 4.0 }),
  false,
);
check(
  "9. pre-move rejects a null window — 'quiet' must be shown, not assumed",
  premove.admits({ priceChgPct24h: 2, priceChgPctWindow: null }),
  false,
);
check(
  "10. pre-move accepts a flat tape",
  premove.admits({ priceChgPct24h: 2, priceChgPctWindow: 0.4 }),
  true,
);
check(
  "11. breakout still tolerates a null window (falls back to 24h)",
  breakout.admits({ priceChgPct24h: 2, priceChgPctWindow: null }),
  true,
);

// ---- direction --------------------------------------------------------------

check("12. pre-move takes shorts", premove.accepts("shorts building"), true);
check("13. breakout does not", breakout.accepts("shorts building"), false);
check("14. neither acts on unwinds", premove.accepts("longs closing"), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
